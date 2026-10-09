// 건강식품 자동화 에이전트 백엔드 (single-file, Express 5)
// 흐름: 매직링크 인증 → 명령 큐 → 에이전트(수집→매칭→LLM→이미지) → WebSocket 푸시
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = (process.env.JWT_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).trim();
const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim();
const LLM_MODEL = (process.env.LLM_MODEL || 'gpt-4o-mini').trim();
const OPENCLAW_URL = (process.env.OPENCLAW_GATEWAY_URL || '').trim(); // 설정 시 에이전트 계획 수립을 OpenClaw에 위임

// ── 운영 DB 스키마 (PostgreSQL). 아래 인메모리 스토어는 이 구조를 그대로 따른다 ──
const SCHEMA_SQL = `
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  push_token TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE auth_tokens (            -- 매직링크(해시만 저장) + 리프레시 토큰
  token_hash TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  email TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('magic','refresh')),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE jobs (                    -- 원격 명령 큐
  id UUID PRIMARY KEY, user_id UUID REFERENCES users(id),
  command TEXT NOT NULL, intent TEXT,
  status TEXT CHECK (status IN ('queued','collecting','designing','done','failed')),
  error TEXT, created_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE TABLE collected_data (          -- 수집 원본 (source: coupang|imports|homeshopping|match)
  id BIGSERIAL PRIMARY KEY, job_id UUID REFERENCES jobs(id),
  source TEXT NOT NULL, payload JSONB NOT NULL, collected_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE generated_outputs (       -- LLM/이미지 결과물
  id BIGSERIAL PRIMARY KEY, job_id UUID REFERENCES jobs(id), user_id UUID REFERENCES users(id),
  ingredient TEXT, product_name TEXT, seo_keywords TEXT[], detail_markdown TEXT,
  image_prompts JSONB, image_urls JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY, user_id UUID REFERENCES users(id),
  job_id UUID, title TEXT, body TEXT, read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now()
);`;

// ── In-memory stores ─────────────────────────
const users = new Map();          // id -> {id,email,pushToken}
const usersByEmail = new Map();
const authTokens = new Map();     // hash -> {userId,email,kind,expiresAt,usedAt}
const jobs = new Map();           // id -> job
const collected = [];             // {jobId,source,payload,collectedAt}
const outputs = new Map();        // jobId -> output
const notifications = [];
const queue = [];
const sockets = new Map();        // userId -> Set<ws>
const rateLimit = new Map();      // email -> timestamps

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── JWT (HS256, 외부 의존성 없이) ─────────────
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
function signJwt(payload, ttlSec) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyJwt(token) {
  const [h, b, s] = String(token || '').split('.');
  if (!h || !b || !s) return null;
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest();
  const given = Buffer.from(s, 'base64url');
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString());
  return payload.exp > Date.now() / 1000 ? payload : null;
}
function issueSession(user) {
  const refresh = crypto.randomBytes(32).toString('hex');
  authTokens.set(sha256(refresh), { userId: user.id, email: user.email, kind: 'refresh', expiresAt: Date.now() + 30 * 864e5 });
  return { accessToken: signJwt({ sub: user.id, email: user.email }, 15 * 60), refreshToken: refresh, expiresIn: 900 };
}
function requireAuth(req, res, next) {
  const p = verifyJwt((req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!p || !users.has(p.sub)) return res.status(401).json({ success: false, message: '인증이 필요합니다.' });
  req.user = users.get(p.sub);
  next();
}

// ── 외부 연동: 이메일 / 푸시 / LLM ─────────────
async function sendMagicLinkEmail(email, link) {
  // RESEND_API_KEY가 있으면 Resend(https://resend.com, 무료 월 3,000통)로 실제 발송, 없으면 콘솔 출력
  const key = (process.env.RESEND_API_KEY || '').trim();
  if (!key) return console.log(`[magic-link] ${email} → ${link}`);
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: (process.env.MAIL_FROM || 'Healthy Agent <onboarding@resend.dev>').trim(),
      to: [email],
      subject: '[헬시 에이전트] 로그인 링크',
      html: `<p>아래 버튼을 누르면 로그인됩니다. (10분간 유효, 1회용)</p><p><a href="${link}" style="background:#059669;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none">로그인하기</a></p><p style="color:#64748b;font-size:12px">${link}</p>`,
    }),
  });
  if (!r.ok) {
    console.error('[mail failed]', r.status, await r.text());
    throw new Error('메일 발송에 실패했어요. 설정을 확인해 주세요.');
  }
}
function pushToUser(userId, event) {
  (sockets.get(userId) || new Set()).forEach((ws) => ws.readyState === 1 && ws.send(JSON.stringify(event)));
  const u = users.get(userId);
  if (u && u.pushToken && event.type === 'job.done') {
    console.log(`[push] FCM/APNs → ${u.pushToken.slice(0, 8)}… : ${event.title}`); // 운영: FCM HTTP v1 호출
  }
}
async function callLLM(system, user, { json = true } = {}) {
  if (!OPENAI_KEY) return null;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: LLM_MODEL, temperature: 0.7,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`LLM 호출 실패 (${r.status})`);
  const data = await r.json();
  const text = data.choices[0].message.content;
  return json ? JSON.parse(text) : text;
}
async function callImageAI(prompt) {
  if (!OPENAI_KEY) return `https://placehold.co/1024x1024/10b981/ffffff?text=${encodeURIComponent('DALL-E 3 mock')}`;
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'dall-e-3', prompt, size: '1024x1024', n: 1 }),
  });
  if (!r.ok) throw new Error(`이미지 생성 실패 (${r.status})`);
  return (await r.json()).data[0].url;
}

// ── 데이터 수집 워커 (가상 스크래퍼: 운영에서는 이 함수 내부만 교체) ──
const seeded = (seed) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const INGREDIENTS = ['오메가3', '루테인', '콜라겐', '밀크씨슬', '비타민D', '프로바이오틱스', '쏘팔메토', '마그네슘', '홍삼', 'NMN', '우롤리틴A', '사찰라'];
const POS_REVIEWS = ['배송이 빨라요', '효과를 느껴요', '가성비 좋아요', '재구매 의사 있음', '알이 작아 먹기 편해요', '부모님 선물로 만족', '포장이 꼼꼼해요'];

async function scrapeCoupang(category = '건강식품') {
  const rnd = seeded(new Date().getDate() * 7 + 1);
  const products = INGREDIENTS.slice(0, 10).flatMap((ing, i) => [0, 1].map((k) => {
    const sales = Math.round(5000 + rnd() * 45000);
    const price = Math.round((12000 + rnd() * 48000) / 100) * 100;
    const reviews = Array.from({ length: 12 }, () => ({
      text: POS_REVIEWS[Math.floor(rnd() * POS_REVIEWS.length)], rating: Math.round((3 + rnd() * 2) * 10) / 10,
    }));
    return { id: `cp-${i}-${k}`, title: `${ing} ${k ? '프리미엄' : '데일리'} ${30 + i * 10}일분`, ingredient: ing, price, sales, revenue: sales * price,
      searches: Math.round(20000 + rnd() * 100000), reviewCount: Math.round(sales * 0.15), reviews };
  }));
  const withExtras = products.map((p) => ({
    ...p,
    topReviews: [...p.reviews].sort((a, b) => b.rating - a.rating).slice(0, 5), // 평점순 상위 5
    tags: extractTags(p),
  }));
  const strip = ({ reviews, ...rest }) => rest;
  return {
    category,
    topBySales: [...withExtras].sort((a, b) => b.sales - a.sales).slice(0, 10).map(strip),
    topByRevenue: [...withExtras].sort((a, b) => b.revenue - a.revenue).slice(0, 10).map(strip),
    totalRevenue: withExtras.reduce((s, p) => s + p.revenue, 0),
  };
}
function extractTags(p, n = 3) {
  const stop = new Set(['일분', '데일리', '프리미엄']);
  const freq = new Map();
  [p.title, ...p.reviews.map((r) => r.text)].join(' ').split(/\s+/).forEach((w) => {
    if (w.length >= 2 && !stop.has(w) && !/^\d/.test(w)) freq.set(w, (freq.get(w) || 0) + 1);
  });
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

// ── 데이터 정제(Data Cleaning): 규격 없는 원문 → LLM 1차 변환 → 스키마 검증 → 실패 시 규칙 파서 폴백 ──
const CLEAN_SYSTEM_PROMPT = `당신은 데이터 정제기입니다. 규격이 제각각인 원문 줄들을 받아 JSON으로만 답하세요.
- kind가 "imports"면 {"records":[{"ingredient":"표준 원료명","month":"YYYY-MM","tons":숫자}]} (kg는 톤으로 환산, 쉼표 제거, 같은 원료·월은 합산)
- kind가 "homeshopping"면 {"records":[{"channel":"방송사","startsAt":"ISO8601(+09:00)","title":"방송명","ingredient":"표준 원료명 또는 null"}]}
원문에 없는 값을 만들어내지 말고, 해석할 수 없는 줄은 생략하세요.`;

async function cleanWithLLM(kind, rawLines, validate, ruleParse) {
  try {
    const out = await callLLM(CLEAN_SYSTEM_PROMPT, JSON.stringify({ kind, lines: rawLines, knownIngredients: INGREDIENTS }));
    if (out && Array.isArray(out.records)) {
      const ok = out.records.filter(validate);
      if (ok.length > 0) return ok;
    }
  } catch (e) { console.warn(`[clean:${kind}] LLM 정제 실패, 규칙 파서로 폴백:`, e.message); }
  return ruleParse(rawLines);
}

// 원료 수입량 (출처 무관). 키(IMPORT_API_KEY)와 URL(IMPORT_API_URL)이 있으면 공공데이터포털 무료 OpenAPI
// "관세청_품목별 수출입실적(GW)" (https://www.data.go.kr/data/15101609/openapi.do, 월 1회 갱신, HS코드별 수입 중량)을 호출하고,
// 없으면 가상 데이터를 쓴다. 정제 단계가 입력 원문을 "YYYY-MM|원료|수량 단위" 줄로 통일한다.
const importMonths = () => { // 최근 완결 4개월: [4개월 전 … 1개월 전]
  const d = new Date();
  return [4, 3, 2, 1].map((k) => { const x = new Date(d.getFullYear(), d.getMonth() - k, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; });
};
// 원료 → HS코드(근사치). 실제 사용 전 관세청 HS 표로 검증하고 IMPORT_HS_MAP='{"오메가3":"150420",...}' 환경변수로 덮어쓸 것
const HS_MAP = { '오메가3': '150420', '홍삼': '121120', '비타민D': '293629', '콜라겐': '350400', '프로바이오틱스': '210210', ...JSON.parse(process.env.IMPORT_HS_MAP || '{}') };
const IMPORT_API_KEY = (process.env.IMPORT_API_KEY || '').trim();
const IMPORT_API_URL = (process.env.IMPORT_API_URL || '').trim(); // 데이터포털 API 상세 페이지의 요청 URL을 그대로 복사

async function fetchImportsFromOpenApi(months) {
  const lines = [];
  for (const [ingredient, hs] of Object.entries(HS_MAP)) {
    const q = new URLSearchParams({ serviceKey: IMPORT_API_KEY, strtYymm: months[0].replace('-', ''), endYymm: months[3].replace('-', ''), hsSgn: hs });
    const r = await fetch(`${IMPORT_API_URL}?${q}`);
    if (!r.ok) throw new Error(`수입통계 API 오류 (${r.status})`);
    const text = await r.text();
    // XML/JSON 모두 대응: item 블록에서 연월과 수입중량(kg) 추출. 필드명은 기술문서 기준(year, impWgt)이며 다르면 여기서만 조정
    const blocks = text.includes('<item>') ? text.split('<item>').slice(1) : [];
    for (const b of blocks) {
      const ym = (b.match(/<year>([^<]+)<\/year>/) || [])[1];
      const wgt = (b.match(/<impWgt>([^<]+)<\/impWgt>/) || [])[1];
      const m = ym && ym.match(/(\d{4})\D?(\d{2})/);
      if (m && wgt && months.includes(`${m[1]}-${m[2]}`)) lines.push(`${m[1]}-${m[2]}|${ingredient}|${wgt} kg`);
    }
  }
  if (!lines.length) throw new Error('수입통계 API 응답에서 유효한 항목을 찾지 못했습니다.');
  return lines;
}
async function fetchImportsRaw() {
  const months = importMonths();
  if (IMPORT_API_KEY && IMPORT_API_URL) {
    try { return await fetchImportsFromOpenApi(months); }
    catch (e) { console.warn('[imports] 실제 API 실패, 가상 데이터로 대체:', e.message); }
  }
  const rnd = seeded(42);
  return INGREDIENTS.flatMap((name, i) => {
    const base = i >= 10 ? 0 : 80 + rnd() * 250; // 마지막 2개는 신규 진입 원료
    const trend = i % 3 === 0 ? 1.25 : i % 5 === 0 ? 1.6 : 1.02;
    return months.map((m, k) => {
      if (base === 0 && k < 2) return null;
      const tons = Math.round((base || 40) * Math.pow(trend, k));
      return k % 2 ? `${m}|${name} 원료(분말)|${(tons * 1000).toLocaleString('en-US')} kg` : `${m}|${name} 추출물|${tons} TON`;
    }).filter(Boolean);
  });
}
const parseImportRule = (lines) => lines.map((line) => {
  const [month, item, qty] = line.split('|');
  const ingredient = INGREDIENTS.find((n) => (item || '').includes(n));
  const num = parseFloat(String(qty || '').replace(/,/g, ''));
  if (!ingredient || !/^\d{4}-\d{2}$/.test(month || '') || !isFinite(num)) return null;
  return { ingredient, month, tons: /kg/i.test(qty) ? num / 1000 : num };
}).filter(Boolean);
const validImport = (r) => r && typeof r.ingredient === 'string' && /^\d{4}-\d{2}$/.test(r.month) && typeof r.tons === 'number' && isFinite(r.tons) && r.tons >= 0;

async function fetchImports() {
  const records = await cleanWithLLM('imports', await fetchImportsRaw(), validImport, parseImportRule);
  const months = importMonths();
  const byIng = new Map();
  for (const r of records) {
    const idx = months.indexOf(r.month);
    if (idx < 0) continue;
    if (!byIng.has(r.ingredient)) byIng.set(r.ingredient, [0, 0, 0, 0]);
    byIng.get(r.ingredient)[idx] += r.tons;
  }
  // monthly[0]=4개월 전 … monthly[3]=1개월 전
  return [...byIng].map(([ingredient, monthly]) => ({ ingredient, monthly: monthly.map((t) => Math.round(t)) }));
}
// 급증 필터: 1개월 전 / 4개월 전 ≥ 1.3 또는 4개월 전 0 → 신규 진입
function filterSurge(imports, threshold = 0.3) {
  return imports.map(({ ingredient, monthly }) => {
    const [m4, , , m1] = monthly;
    const isNew = m4 === 0 && m1 > 0;
    const rate = isNew ? Infinity : m4 > 0 ? (m1 - m4) / m4 : 0;
    return { ingredient, monthly, rate, isNew };
  }).filter((r) => r.isNew || r.rate >= threshold)
    .sort((a, b) => (b.isNew - a.isNew) || (b.rate - a.rate))
    .map((r) => ({ ...r, rate: r.isNew ? null : Math.round(r.rate * 100) / 100 }));
}

// 홈쇼핑 편성표: 원문 라인 수집(운영에서는 이 함수만 허용된 데이터 소스로 교체) → 정제 → 구조화
async function fetchHomeshoppingRaw() {
  // 목업: 오늘(KST) 기준 +1~8일 편성으로 생성
  const day = (n) => new Date(Date.now() + 9 * 36e5 + n * 864e5).toISOString().slice(0, 10);
  return [
    `CJ온스타일|${day(1)} 10:45|NMN 항노화 올인원`, `GS샵|${day(2)} 22:35|프리미엄 루테인 눈건강`,
    `롯데홈쇼핑|${day(1)} 21:20|쏘팔메토 옥타 남성건강`, `현대홈쇼핑|${day(3)} 20:45|오메가3 rTG 혈행개선`,
    `CJ온스타일|${day(4)} 21:55|마그네슘 글리시네이트 숙면`, `GS샵|${day(5)} 09:50|프로바이오틱스 장건강`,
    `롯데홈쇼핑|${day(6)} 23:10|우롤리틴A 미토콘드리아`, `현대홈쇼핑|${day(7)} 10:20|저분자 콜라겐 이너뷰티`,
  ];
}
const parseBroadcastRule = (lines) => lines.map((line) => {
  const [channel, at, title] = line.split('|');
  if (!channel || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at || '') || !title) return null;
  return { channel, startsAt: at.replace(' ', 'T') + ':00+09:00', title, ingredient: INGREDIENTS.find((i) => title.includes(i)) || null };
}).filter(Boolean);
const validBroadcast = (b) => b && typeof b.channel === 'string' && typeof b.title === 'string' && !isNaN(Date.parse(b.startsAt));

async function scrapeHomeshopping() {
  const rows = await cleanWithLLM('homeshopping', await fetchHomeshoppingRaw(), validBroadcast, parseBroadcastRule);
  return rows.map((b) => {
    const ingredient = INGREDIENTS.includes(b.ingredient) ? b.ingredient : INGREDIENTS.find((i) => b.title.includes(i)) || null;
    const hour = new Date(Date.parse(b.startsAt) + 9 * 36e5).getUTCHours(); // KST 기준 시
    return { channel: b.channel, startsAt: b.startsAt, title: b.title, ingredient, primeTime: hour >= 20 && hour <= 23 };
  }).filter((b) => b.ingredient);
}

// ── 변환·매칭 엔진: 수입 급증(공급) × 홈쇼핑 편성(수요) 시간축 조인 + 쿠팡 판매 성과 부가 정보 ──
function aggregateCoupang(coupang) {
  const byId = new Map();
  [...coupang.topBySales, ...coupang.topByRevenue].forEach((p) => byId.set(p.id, p));
  const agg = new Map();
  for (const p of byId.values()) {
    const a = agg.get(p.ingredient) || { sales: 0, revenue: 0, searches: 0 };
    a.sales += p.sales; a.revenue += p.revenue; a.searches += p.searches;
    agg.set(p.ingredient, a);
  }
  return agg;
}
function buildMatchTable(surge, broadcasts, coupang, windowDays = 14, now = new Date()) {
  const end = now.getTime() + windowDays * 864e5;
  const sales = aggregateCoupang(coupang);
  return surge.map((s) => {
    const shows = broadcasts.filter((b) => {
      const t = new Date(b.startsAt).getTime();
      return b.ingredient === s.ingredient && t >= now.getTime() && t <= end;
    }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const supply = s.isNew ? 100 : Math.min(100, Math.round((s.rate || 0) * 100));
    const demand = Math.min(100, shows.length * 40 + shows.filter((x) => x.primeTime).length * 20);
    return {
      ingredient: s.ingredient, monthlyImports: s.monthly, surgeRate: s.rate, isNew: s.isNew,
      coupang: sales.get(s.ingredient) || null,
      broadcasts: shows, supplyScore: supply, demandScore: demand,
      matchScore: Math.round(supply * 0.5 + demand * 0.5),
      highlight: s.isNew || (supply >= 50 && demand >= 40),
    };
  }).sort((a, b) => b.matchScore - a.matchScore);
}

// ── AI 에이전트 레이어: 프롬프트 + 이미지 프롬프트 빌더 ──
const BRANDING_SYSTEM_PROMPT = `당신은 한국 건강기능식품 전문 브랜드 전략가이자 쿠팡 상세페이지 카피라이터입니다.
입력으로 시장 데이터(쿠팡 상위 상품, 연관 태그, 수입 급증 정보, 홈쇼핑 편성)와 선정 원료가 주어집니다.
반드시 아래 JSON 스키마로만 답하세요.
{
  "productName": "기억하기 쉽고 원료/효능이 드러나는 한국어 상품명 1개 (20자 이내)",
  "nameReason": "선정 근거 한 문장",
  "seoKeywords": ["쿠팡 검색 상단 노출용 키워드 정확히 2개 (검색수·경쟁도를 고려한 롱테일 포함)"],
  "detailMarkdown": "상세페이지 구조 Markdown: # 상품명 / > 한 줄 카피 / ## 핵심 포인트(3개) / ## 이런 분께 / ## 섭취 방법 / ## 주의사항"
}
규칙: 1) 질병의 예방·치료·완치 표현 금지(식품표시광고법). 2) 기능성은 '도움을 줄 수 있음' 등 인정 범위 내 표현만. 3) 데이터에 없는 수치·인증을 지어내지 말 것. 4) 경쟁 상품명을 그대로 복제하지 말 것.`;

function buildImagePrompts(name, ingredient, tags = []) {
  const style = 'clean green and white palette, soft studio lighting, premium Korean health supplement brand, no text artifacts, no medical claims';
  return [
    { type: 'package', prompt: `Product packaging mockup of a supplement bottle for "${name}", ${ingredient} theme, ${style}, white background, 1:1` },
    { type: 'banner', prompt: `Wide hero banner for a Coupang product page, ${ingredient} natural source (${tags.join(', ') || 'wellness'}), fresh emerald gradient, space on left for copy, ${style}` },
    { type: 'ingredient-info', prompt: `Flat infographic background illustrating ${ingredient} origin and extraction, minimal icons, ${style}` },
  ];
}
function mockBranding(ingredient) {
  const name = `시그니처 ${ingredient} 플러스`;
  return {
    productName: name, nameReason: '원료 직관성과 프리미엄 뉘앙스를 결합 (목업)',
    seoKeywords: [`${ingredient} 추천`, `${ingredient} 영양제`],
    detailMarkdown: `# ${name}\n\n> 매일 가볍게, 건강 루틴\n\n## 핵심 포인트\n- ${ingredient} 함유\n- 1일 1회 간편 섭취\n- 꼼꼼한 품질 관리\n\n## 섭취 방법\n1일 1회, 물과 함께 섭취하세요.\n\n## 주의사항\n특이체질·알레르기 체질은 원료를 확인하세요.`,
  };
}

// ── OpenClaw 연동: 툴 레지스트리 + 에이전트 실행 루프 ──
// OpenClaw 게이트웨이가 설정되면 명령 해석(계획 수립)을 위임하고, 없으면 내장 의도 분류기를 쓴다.
// 게이트웨이 요청/응답 규격은 사용 중인 OpenClaw 버전에 맞게 planWithOpenClaw 안에서만 조정한다.
const TOOLS = {
  'coupang.scrape': async (ctx) => (ctx.coupang = await scrapeCoupang()),
  'imports.fetch': async (ctx) => { ctx.imports = await fetchImports(); return (ctx.surge = filterSurge(ctx.imports)); },
  'homeshopping.scrape': async (ctx) => (ctx.broadcasts = await scrapeHomeshopping()),
  'match.build': async (ctx) => (ctx.match = buildMatchTable(ctx.surge, ctx.broadcasts, ctx.coupang)),
  'brand.generate': async (ctx) => {
    const top = ctx.match[0] || { ingredient: ctx.surge[0] ? ctx.surge[0].ingredient : ctx.coupang.topBySales[0].ingredient };
    const ing = ctx.ingredient || top.ingredient;
    const related = [...ctx.coupang.topBySales, ...ctx.coupang.topByRevenue].filter((p) => p.ingredient === ing).slice(0, 3);
    const payload = { ingredient: ing, relatedProducts: related.map(({ title, sales, tags, searches }) => ({ title, sales, tags, searches })),
      surge: ctx.surge.find((s) => s.ingredient === ing) || null,
      broadcasts: (top.broadcasts || []).map((b) => `${b.channel} ${b.startsAt}`) };
    const result = (await callLLM(BRANDING_SYSTEM_PROMPT, JSON.stringify(payload))) || mockBranding(ing);
    if (!Array.isArray(result.seoKeywords) || result.seoKeywords.length !== 2) result.seoKeywords = (result.seoKeywords || []).slice(0, 2);
    const tags = related.flatMap((p) => p.tags).slice(0, 3);
    const imagePrompts = buildImagePrompts(result.productName, ing, tags);
    const imageUrls = [];
    for (const p of imagePrompts) imageUrls.push({ type: p.type, url: await callImageAI(p.prompt) });
    return (ctx.brand = { ingredient: ing, ...result, imagePrompts, imageUrls });
  },
};
const INTENT_PLANS = {
  research: { steps: ['coupang.scrape', 'imports.fetch', 'homeshopping.scrape', 'match.build'], stages: ['collecting'] },
  design: { steps: ['brand.generate'], needs: 'research', stages: ['designing'] },
  full: { steps: ['coupang.scrape', 'imports.fetch', 'homeshopping.scrape', 'match.build', 'brand.generate'] },
};
function classifyIntent(cmd) {
  const wantsDesign = /(상세|디자인|네이밍|이름|카피|이미지|배너)/.test(cmd);
  const wantsResearch = /(리서치|분석|트렌드|수집|매칭|홈쇼핑|쿠팡)/.test(cmd);
  if (wantsDesign && wantsResearch) return 'full';
  if (wantsDesign) return 'design';
  return wantsResearch ? 'research' : 'full';
}
async function planWithOpenClaw(command) {
  if (!OPENCLAW_URL) return null;
  const r = await fetch(`${OPENCLAW_URL}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, tools: Object.keys(TOOLS) }) });
  if (!r.ok) return null;
  const { steps } = await r.json();
  return Array.isArray(steps) ? steps.filter((s) => TOOLS[s]) : null;
}
const lastContext = new Map(); // userId -> 직전 리서치 컨텍스트 (design만 요청할 때 재사용)

async function runAgent(job) {
  const ctx = lastContext.get(job.userId) || {};
  const intent = classifyIntent(job.command);
  job.intent = intent;
  let steps = (await planWithOpenClaw(job.command).catch(() => null)) || INTENT_PLANS[intent].steps;
  if (steps.includes('brand.generate') && !ctx.match && !steps.includes('match.build')) steps = INTENT_PLANS.full.steps;
  for (const step of steps) {
    setStatus(job, step === 'brand.generate' ? 'designing' : 'collecting');
    const out = await TOOLS[step](ctx);
    const source = step.split('.')[0];
    collected.push({ jobId: job.id, source, payload: out, collectedAt: new Date().toISOString() });
  }
  lastContext.set(job.userId, ctx);
  if (ctx.brand) outputs.set(job.id, { jobId: job.id, userId: job.userId, createdAt: new Date().toISOString(), ...ctx.brand });
  return { match: ctx.match, brand: ctx.brand || null };
}

// ── 원격 명령 큐 + 비동기 워커 ──
function setStatus(job, status) {
  job.status = status;
  pushToUser(job.userId, { type: 'job.status', jobId: job.id, status });
}
let working = false;
async function drain() {
  if (working) return;
  working = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      job.result = await runAgent(job);
      setStatus(job, 'done');
      job.finishedAt = new Date().toISOString();
      const n = { id: notifications.length + 1, userId: job.userId, jobId: job.id, title: '작업 완료', body: `"${job.command}" 처리가 끝났어요.`, read: false, createdAt: job.finishedAt };
      notifications.push(n);
      pushToUser(job.userId, { type: 'job.done', jobId: job.id, title: n.title, body: n.body, summary: { top: job.result.match[0] || null, productName: job.result.brand && job.result.brand.productName } });
    } catch (e) {
      console.error('[job failed]', e);
      job.error = e.message;
      setStatus(job, 'failed');
      pushToUser(job.userId, { type: 'job.failed', jobId: job.id, message: '작업 중 오류가 발생했어요.' });
    }
  }
  working = false;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

// ── API: Auth ────────────────────────────────
app.post('/api/auth/request', wrap(async (req, res) => {
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: '올바른 이메일이 아닙니다.' });
  const recent = (rateLimit.get(email) || []).filter((t) => Date.now() - t < 10 * 60e3);
  if (recent.length >= 3) return res.status(429).json({ success: false, message: '잠시 후 다시 시도해 주세요.' });
  rateLimit.set(email, [...recent, Date.now()]);
  const token = crypto.randomBytes(32).toString('hex');
  authTokens.set(sha256(token), { email, kind: 'magic', expiresAt: Date.now() + 10 * 60e3 });
  const link = `${APP_URL}/?token=${token}`;
  try { await sendMagicLinkEmail(email, link); }
  catch (e) { return res.status(502).json({ success: false, message: e.message }); }
  // 계정 존재 여부를 노출하지 않도록 항상 동일 응답. 개발 모드에서만 링크 반환
  res.json({ success: true, message: '인증 링크를 발송했습니다.', ...(IS_PROD ? {} : { devLink: link }) });
}));

app.post('/api/auth/verify', wrap(async (req, res) => {
  const rec = authTokens.get(sha256(String((req.body || {}).token || '')));
  if (!rec || rec.kind !== 'magic' || rec.usedAt || rec.expiresAt < Date.now())
    return res.status(401).json({ success: false, message: '만료되었거나 유효하지 않은 링크입니다.' });
  rec.usedAt = Date.now(); // 1회용
  let user = usersByEmail.get(rec.email);
  if (!user) { user = { id: uid(), email: rec.email, pushToken: null }; users.set(user.id, user); usersByEmail.set(user.email, user); }
  res.json({ success: true, data: { user: { id: user.id, email: user.email }, ...issueSession(user) } });
}));

app.post('/api/auth/refresh', wrap(async (req, res) => {
  const key = sha256(String((req.body || {}).refreshToken || ''));
  const rec = authTokens.get(key);
  if (!rec || rec.kind !== 'refresh' || rec.expiresAt < Date.now()) return res.status(401).json({ success: false, message: '세션이 만료되었습니다.' });
  authTokens.delete(key); // 리프레시 토큰 회전
  res.json({ success: true, data: issueSession(users.get(rec.userId)) });
}));

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const key = sha256(String((req.body || {}).refreshToken || ''));
  authTokens.delete(key);
  res.json({ success: true });
});

app.put('/api/me/push-token', requireAuth, (req, res) => {
  const { pushToken } = req.body || {};
  if (typeof pushToken !== 'string' || !pushToken) return res.status(400).json({ success: false, message: 'pushToken이 필요합니다.' });
  req.user.pushToken = pushToken;
  res.json({ success: true });
});

// ── API: 원격 명령 / 작업 ─────────────────────
app.post('/api/commands', requireAuth, (req, res) => {
  const command = String((req.body || {}).command || '').trim();
  if (!command || command.length > 500) return res.status(400).json({ success: false, message: '명령은 1~500자여야 합니다.' });
  const active = [...jobs.values()].filter((j) => j.userId === req.user.id && ['queued', 'collecting', 'designing'].includes(j.status));
  if (active.length >= 3) return res.status(429).json({ success: false, message: '진행 중인 작업이 너무 많습니다.' });
  const job = { id: uid(), userId: req.user.id, command, intent: null, status: 'queued', createdAt: new Date().toISOString() };
  jobs.set(job.id, job);
  queue.push(job);
  setImmediate(drain);
  res.status(202).json({ success: true, data: { jobId: job.id, status: job.status } });
});

app.get('/api/jobs', requireAuth, (req, res) => {
  const list = [...jobs.values()].filter((j) => j.userId === req.user.id).map(({ result, ...j }) => j).reverse();
  res.json({ success: true, data: list });
});
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.userId !== req.user.id) return res.status(404).json({ success: false, message: '작업을 찾을 수 없습니다.' });
  res.json({ success: true, data: job });
});

// ── API: 수집 데이터 / 매칭 / 결과물 ───────────
const latest = (userId, source) => {
  const mine = new Set([...jobs.values()].filter((j) => j.userId === userId).map((j) => j.id));
  return [...collected].reverse().find((c) => mine.has(c.jobId) && c.source === source);
};
app.get('/api/market', requireAuth, (req, res) => {
  const c = latest(req.user.id, 'coupang');
  const s = latest(req.user.id, 'imports');
  if (!c) return res.status(404).json({ success: false, message: '수집된 데이터가 없습니다. 리서치를 먼저 실행하세요.' });
  res.json({ success: true, data: { coupang: c.payload, importSurge: s ? s.payload : [], collectedAt: c.collectedAt } });
});
app.get('/api/match', requireAuth, (req, res) => {
  const m = latest(req.user.id, 'match');
  if (!m) return res.status(404).json({ success: false, message: '매칭 결과가 없습니다.' });
  res.json({ success: true, data: { rows: m.payload, months: ['4개월 전', '3개월 전', '2개월 전', '1개월 전'] } });
});
app.get('/api/outputs', requireAuth, (req, res) => {
  res.json({ success: true, data: [...outputs.values()].filter((o) => o.userId === req.user.id).reverse() });
});
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({ success: true, data: notifications.filter((n) => n.userId === req.user.id).reverse() });
});
app.get('/api/health', (_req, res) => res.json({ success: true, data: { llm: OPENAI_KEY ? 'openai' : 'mock', openclaw: OPENCLAW_URL ? 'gateway' : 'builtin' } }));
app.get('/api/schema', (_req, res) => res.type('text/plain').send(IS_PROD ? '' : SCHEMA_SQL));

// ── Error handling ───────────────────────────
app.use('/api', (_req, res) => res.status(404).json({ success: false, message: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Startup & WebSocket (로컬/상시 서버 전용; Vercel 서버리스는 WS 미지원 → 폴링 또는 FCM 사용) ──
if (require.main === module) {
  const server = http.createServer(app);
  try {
    const { WebSocketServer } = require('ws');
    const wss = new WebSocketServer({ server, path: '/ws' });
    wss.on('connection', (ws, req) => {
      const token = new URL(req.url, 'http://x').searchParams.get('token');
      const p = verifyJwt(token);
      if (!p || !users.has(p.sub)) return ws.close(4401, 'unauthorized');
      if (!sockets.has(p.sub)) sockets.set(p.sub, new Set());
      sockets.get(p.sub).add(ws);
      ws.send(JSON.stringify({ type: 'hello' }));
      ws.on('close', () => sockets.get(p.sub).delete(ws));
    });
  } catch (e) {
    console.warn('ws 모듈이 없어 WebSocket이 비활성화됩니다. (npm install ws)');
  }
  server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
