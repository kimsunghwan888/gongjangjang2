// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');

// ── App init & config ────────────────────────
// 내 컴퓨터에선 .env 를 읽고, Vercel 에선 설정값(환경변수)을 그대로 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없음 = Vercel */ }

const app = express();
const PORT = process.env.PORT || 3000;

// ── 저장창고(Supabase) 접속 정보 ───────────────
// 공개용(publishable) 열쇠라서 화면(index.html)에는 절대 넣지 않고 서버에서만 쓴다
// 주소는 끝에 /rest/v1/ 이 붙어 있어도 되고 없어도 된다
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

// ── 기본 설정 ─────────────────────────────────
const START_CASH = 1000000;   // 시작 현금 100만엔 (수수료는 없다 — 요즘 일본 온라인 증권사는 무료)
// 지갑은 한 개 (혼자 쓰는 앱). 표 이름·주인 이름은 supabase-setup.sql 안에 있다

// 다룰 종목 (도쿄 증권거래소 · 코드 뒤에 .T 를 붙이면 야후 파이낸스 이름)
const STOCKS = [
  { code: '7203', name: '도요타자동차', sub: '자동차', emoji: '🚗' },
  { code: '6758', name: '소니그룹', sub: '전자·게임·영화', emoji: '🎧' },
  { code: '7974', name: '닌텐도', sub: '게임', emoji: '🎮' },
  { code: '6861', name: '키엔스', sub: '센서·자동화 장비', emoji: '🔬' },
  { code: '9984', name: '소프트뱅크그룹', sub: '통신·투자', emoji: '📡' },
  { code: '9983', name: '유니클로', sub: '패스트리테일링 · 옷', emoji: '👕' },
  { code: '7267', name: '혼다', sub: '자동차·오토바이', emoji: '🏍️' },
  { code: '8306', name: '미쓰비시UFJ', sub: '은행', emoji: '🏦' },
  { code: '9432', name: 'NTT', sub: '통신', emoji: '📞' },
];
const STOCK_MAP = Object.fromEntries(STOCKS.map((s) => [s.code, s]));
const ALL_CODES = STOCKS.map((s) => s.code);

// 바깥 서비스(야후·Supabase) 때문에 생긴 문제는 502 로 알려 준다
class UpstreamError extends Error {
  constructor(message) { super(message); this.status = 502; }
}

// 사용자가 고칠 수 있는 문제(돈이 모자람 등)는 400 으로 알려 준다
class UserError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// ── 잠깐 기억해 두기 (야후에 너무 자주 묻지 않도록) ──
// 같은 것을 동시에 여러 번 물어도 한 번만 묻고, 야후가 실패하면 30분 안에 받아 둔 값을 대신 쓴다
const STALE_OK_MS = 30 * 60 * 1000;
const cache = new Map();   // 이름 → { at, data, loading }

function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && hit.data && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data);
  if (hit && hit.loading) return hit.loading;

  const entry = hit || { at: 0, data: null, loading: null };
  entry.loading = loader()
    .then((data) => { entry.data = data; entry.at = Date.now(); return data; })
    .catch((err) => {
      if (entry.data && Date.now() - entry.at < STALE_OK_MS) return entry.data;
      throw err;
    })
    .finally(() => { entry.loading = null; });
  cache.set(key, entry);
  return entry.loading;
}

// ── 진짜 일본주식 시세 (야후 파이낸스 · 열쇠 없이 쓰는 공개 주소) ──
// 도쿄 증권거래소 시세는 약 20분 늦게 온다 (무료라서)
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

// kind: 그래프 종류 / range: 얼마 동안 / interval: 한 칸이 얼마 / cacheMs: 얼마나 기억해 둘지
const CHART_KINDS = {
  today:   { range: '1d',  interval: '5m',  cacheMs: 15 * 1000,       label: '오늘 (5분)' },
  months3: { range: '3mo', interval: '1d',  cacheMs: 10 * 60 * 1000,  label: '3개월 (하루)' },
  year1:   { range: '1y',  interval: '1wk', cacheMs: 30 * 60 * 1000,  label: '1년 (일주일)' },
  year5:   { range: '5y',  interval: '1mo', cacheMs: 60 * 60 * 1000,  label: '5년 (한 달)' },
};

// 상장 후(야후가 가진 가장 옛날)부터 지금까지 전부 — 일봉 · 주봉 · 월봉 (range 가 없는 것이 "전부"라는 뜻)
// ⚠️ range=max 로 물으면 야후가 일봉·주봉도 월봉으로 뭉뚱그려 주므로, 기간을 직접(period1=0) 지정한다
const HISTORY_KINDS = {
  day:   { interval: '1d',  cacheMs: 60 * 60 * 1000,      label: '일봉' },
  week:  { interval: '1wk', cacheMs: 6 * 60 * 60 * 1000,  label: '주봉' },
  month: { interval: '1mo', cacheMs: 12 * 60 * 60 * 1000, label: '월봉' },
};

async function askYahoo(code, spec) {
  let lastStatus = 0;
  const span = spec.range ? `range=${spec.range}` : `period1=0&period2=${Math.floor(Date.now() / 1000)}`;
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`https://${host}/v8/finance/chart/${code}.T?${span}&interval=${spec.interval}`, {
        headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' },
        signal: AbortSignal.timeout(spec.range ? 6000 : 15000),   // 전체 기간은 자료가 커서 더 기다린다
      });
      lastStatus = res.status;
      if (!res.ok) continue;                       // 한 주소가 안 되면 다른 주소로 다시 물어 본다
      const result = (await res.json())?.chart?.result?.[0];
      if (result?.meta) return result;
    } catch { /* 연결 실패 — 다음 주소로 */ }
  }
  throw new UpstreamError(`야후 파이낸스에서 시세를 받지 못했어요. 잠시 후 다시 해 주세요.${lastStatus ? ` (${lastStatus})` : ''}`);
}

// 야후가 준 원본 (종목 + 그래프 종류별로 기억)
const fetchRaw = (code, kind) =>
  cached(`${code}:${kind}`, CHART_KINDS[kind].cacheMs, () => askYahoo(code, CHART_KINDS[kind]));

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// 야후 원본 → 우리 앱이 쓰는 시세 모양
function toQuote(stock, raw) {
  const m = raw.meta;
  const price = m.regularMarketPrice;
  const prev = m.previousClose ?? m.chartPreviousClose;
  if (!Number.isFinite(price) || !Number.isFinite(prev)) return null;
  return {
    code: stock.code, name: stock.name, sub: stock.sub, emoji: stock.emoji,
    price,
    prevClose: prev,
    change: round2(price - prev),
    changeRate: ((price - prev) / prev) * 100,   // % 로 바꿔서 준다
    high: m.regularMarketDayHigh ?? price,
    low: m.regularMarketDayLow ?? price,
    volume: m.regularMarketVolume ?? 0,
    at: new Date(m.regularMarketTime * 1000).toISOString(),
    spark: (raw.indicators?.quote?.[0]?.close || []).filter(Number.isFinite),   // 오늘 5분 간격 가격
  };
}

// 도쿄 증권거래소가 열려 있나: 'open' | 'lunch' | 'closed'
function marketState(meta) {
  const nowSec = Date.now() / 1000;
  const { start, end } = meta.currentTradingPeriod?.regular || {};
  if (!start || nowSec < start || nowSec > end) return 'closed';
  // 문 연 지 30분이 지났는데 오늘 시세가 하나도 없으면 휴장일이다
  if (meta.regularMarketTime < start && nowSec - start > 30 * 60) return 'closed';
  const jst = new Date(Date.now() + 9 * 3600 * 1000);   // 도쿄 시각
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return minutes >= 11 * 60 + 30 && minutes < 12 * 60 + 30 ? 'lunch' : 'open';
}

// 종목 하나의 현재 시세
async function getQuote(code) {
  const quote = toQuote(STOCK_MAP[code], await fetchRaw(code, 'today'));
  if (!quote) throw new UpstreamError('야후가 그 종목 시세를 주지 않았어요.');
  return quote;
}

// 종목 전체의 현재 시세 (한두 개 실패해도 나머지는 준다)
async function getAllQuotes() {
  const results = await Promise.allSettled(ALL_CODES.map((code) => fetchRaw(code, 'today')));
  const stocks = [];
  let firstMeta = null;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const quote = toQuote(STOCKS[i], r.value);
    if (!quote) return;
    stocks.push(quote);
    firstMeta = firstMeta || r.value.meta;
  });
  if (!stocks.length) throw new UpstreamError('야후 파이낸스에서 시세를 받지 못했어요. 잠시 후 다시 해 주세요.');
  return { market: { state: marketState(firstMeta) }, stocks };
}

// 그래프 자료: [{ t: 도쿄 시각('2026-09-24T14:25:00'), price }] (오래된 것 → 최신)
async function getChart(code, kind) {
  const raw = await fetchRaw(code, kind);
  const times = raw.timestamp || [];
  const closes = raw.indicators?.quote?.[0]?.close || [];
  const candles = [];
  times.forEach((ts, i) => {
    if (Number.isFinite(closes[i])) {
      candles.push({ t: new Date((ts + 9 * 3600) * 1000).toISOString().slice(0, 19), price: closes[i] });
    }
  });
  return candles;
}

// 전체 기간 봉: [{ t:'2026-09-24', open, high, low, close, volume }] (오래된 것 → 최신)
// 선그래프는 close(종가), 막대그래프는 volume(거래량)으로 그린다. 값이 빈 날은 빼고, 같은 날짜가 또 오면 나중 것만 쓴다
function getHistory(code, kind) {
  return cached(`${code}:history:${kind}`, HISTORY_KINDS[kind].cacheMs, async () => {
    const raw = await askYahoo(code, HISTORY_KINDS[kind]);
    const q = raw.indicators?.quote?.[0] || {};
    const byDay = new Map();
    (raw.timestamp || []).forEach((ts, i) => {
      const close = q.close?.[i];
      if (!Number.isFinite(close)) return;
      const t = new Date((ts + 9 * 3600) * 1000).toISOString().slice(0, 10);
      const open = round2(q.open?.[i] ?? close);
      const high = round2(q.high?.[i] ?? close);
      const low = round2(q.low?.[i] ?? close);
      const volume = q.volume?.[i] ?? 0;
      // 시장이 쉬는 날을 야후가 채워 넣은 빈 봉(거래량 0, 시가=고가=저가=종가)은 뺀다
      if (volume === 0 && open === high && high === low && low === round2(close)) return;
      byDay.set(t, { t, open, high, low, close: round2(close), volume });
    });
    return [...byDay.values()];
  });
}

// ── 입력값 검사 도우미 ────────────────────────
const badRequest = (res, message) => res.status(400).json({ success: false, message });

function checkCode(req, res) {
  const code = String(req.query.code || '');
  if (STOCK_MAP[code]) return code;
  badRequest(res, `다룰 수 없는 종목이에요. 가능한 종목 코드: ${ALL_CODES.join(', ')}`);
  return null;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));

// ── API: 시세 (DB 없이 되는 것들) ───────────────
// 종목 전체 시세 + 장이 열려 있는지
app.get('/api/markets', async (_req, res) => {
  res.json({ success: true, data: await getAllQuotes() });
});

// 종목 하나의 현재가: /api/price?code=7203
app.get('/api/price', async (req, res) => {
  const code = checkCode(req, res);
  if (code) res.json({ success: true, data: await getQuote(code) });
});

// 종목 하나의 그래프 자료: /api/chart?code=7203&kind=today|months3|year1|year5
app.get('/api/chart', async (req, res) => {
  const code = checkCode(req, res);
  if (!code) return;
  const kind = String(req.query.kind || 'today');
  if (!CHART_KINDS[kind]) return badRequest(res, `그래프 종류는 ${Object.keys(CHART_KINDS).join(', ')} 중에서 골라 주세요.`);
  res.json({ success: true, data: { code, kind, label: CHART_KINDS[kind].label, candles: await getChart(code, kind) } });
});

// 종목 하나의 상장 후 전체 기간 일봉·주봉·월봉: /api/history?code=7203&interval=day|week|month
app.get('/api/history', async (req, res) => {
  const code = checkCode(req, res);
  if (!code) return;
  const interval = String(req.query.interval || 'day');
  if (!HISTORY_KINDS[interval]) {
    return badRequest(res, `봉 종류는 ${Object.keys(HISTORY_KINDS).join(', ')} 중에서 골라 주세요. (일봉 day · 주봉 week · 월봉 month)`);
  }
  const candles = await getHistory(code, interval);
  res.json({
    success: true,
    data: {
      code, name: STOCK_MAP[code].name, interval, label: HISTORY_KINDS[interval].label,
      count: candles.length, from: candles[0]?.t, to: candles[candles.length - 1]?.t, candles,
    },
  });
});

// ── 저장창고(Supabase) 부르기 ──────────────────
// 표를 직접 만지지 않고, supabase-setup.sql 로 만든 함수(jpinvest_...)만 부른다
async function rpc(name, args = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new UpstreamError('저장창고(Supabase) 접속 정보가 없어요. .env 에 SUPABASE_URL 과 SUPABASE_PUBLISHABLE_KEY 를 넣어 주세요.');
  }
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new UpstreamError('저장창고(Supabase)에 연결하지 못했어요. 잠시 후 다시 해 주세요.');
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return body;

  if (body?.code === 'P0001') throw new UserError(body.message);   // 함수가 일부러 낸 안내 (현금이 모자라요 등)
  console.error('Supabase 오류', res.status, body);
  if (body?.code === 'PGRST202' || body?.code === 'PGRST205') {
    throw new UpstreamError('저장창고에 표와 함수가 아직 없어요. supabase-setup.sql 을 Supabase 의 SQL Editor 에서 한 번 실행해 주세요.');
  }
  throw new UpstreamError(`저장창고(Supabase)가 요청을 받아주지 않았어요. (${res.status})`);
}

// ── 지갑 계산 도우미 ──────────────────────────
// 종목별 현재 시세 (야후가 안 되면 빈 값 → 산 가격으로 계산한다)
async function getPriceMap() {
  try {
    const { stocks } = await getAllQuotes();
    return Object.fromEntries(stocks.map((s) => [s.code, s]));
  } catch {
    return {};
  }
}

// 보유 주식 + 지금 시세로 평가금액·수익률을 계산한다
function evaluateWallet(row, prices) {
  const holdings = Object.entries(row.holdings || {}).map(([code, held]) => {
    const stock = STOCK_MAP[code];
    const price = prices[code] ? prices[code].price : held.avgPrice;
    const value = held.qty * price;
    const cost = held.qty * held.avgPrice;
    return {
      code,
      name: stock?.name || code,
      emoji: stock?.emoji || '📄',
      qty: held.qty,
      avgPrice: held.avgPrice,
      price,
      value,
      cost,
      profit: value - cost,
      profitRate: cost > 0 ? ((value - cost) / cost) * 100 : 0,
    };
  }).sort((a, b) => b.value - a.value);

  const stockValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const total = row.cash + stockValue;
  return {
    startCash: START_CASH,
    cash: row.cash,
    stockValue,
    total,
    profit: total - START_CASH,
    // (현금 + 주식 평가액 − 100만) ÷ 100만
    profitRate: ((total - START_CASH) / START_CASH) * 100,
    holdings,
    updatedAt: row.updated_at,
  };
}

const toOrder = (r) => ({
  id: r.id, code: r.code, name: STOCK_MAP[r.code]?.name || r.code,
  emoji: STOCK_MAP[r.code]?.emoji || '📄', side: r.side,
  qty: r.qty, price: r.price, amount: r.amount, profit: r.profit,
  createdAt: r.created_at,
});

// ── API: 상태 확인 ────────────────────────────
app.get('/api/health', async (_req, res) => {
  await rpc('jpinvest_get_wallet');   // 저장창고에 닿고, 표·함수가 준비돼 있어야 통과
  res.json({ success: true, data: { db: 'ok' } });
});

// ── API: 내 지갑 ──────────────────────────────
app.get('/api/wallet', async (_req, res) => {
  const [row, prices] = await Promise.all([rpc('jpinvest_get_wallet'), getPriceMap()]);
  res.json({ success: true, data: evaluateWallet(row, prices) });
});

// 처음부터 다시 (현금 100만엔, 주식·주문내역 지움)
app.post('/api/wallet/reset', async (_req, res) => {
  res.json({ success: true, data: evaluateWallet(await rpc('jpinvest_reset'), {}) });
});

// ── API: 주문 내역 ────────────────────────────
app.get('/api/orders', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = await rpc('jpinvest_list_orders', { p_limit: limit });
  res.json({ success: true, data: rows.map(toOrder) });
});

// ── API: 매수 · 매도 ──────────────────────────
// body: { code: '7203', side: 'buy'|'sell', qty: 몇 주(정수) }
app.post('/api/order', async (req, res) => {
  const { code: rawCode, side, qty } = req.body || {};
  const code = String(rawCode || '');

  if (!STOCK_MAP[code]) return badRequest(res, `다룰 수 없는 종목이에요. 가능한 종목 코드: ${ALL_CODES.join(', ')}`);
  if (side !== 'buy' && side !== 'sell') return badRequest(res, "사기는 'buy', 팔기는 'sell' 로 보내 주세요.");
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000000) return badRequest(res, '주 수는 1 이상의 정수(소수점 없는 숫자)여야 해요.');

  // 체결가는 야후 현재가 (저장창고를 부르기 전에 먼저 받아 둔다)
  const price = round4((await getQuote(code)).price);

  // 돈·주식이 모자란지 확인하고 지갑·주문내역을 고치는 일은 저장창고의 함수 하나가 한 번에 한다
  const { order, wallet } = await rpc('jpinvest_trade', { p_code: code, p_side: side, p_qty: qty, p_price: price });
  res.status(201).json({
    success: true,
    data: { order: toOrder(order), wallet: evaluateWallet(wallet, await getPriceMap()) },
  });
});

// 없는 API 주소는 화면(index.html) 대신 JSON 으로 알려 준다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 API 주소예요.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
// 폴더 전체를 공개하지 않고 index.html 하나만 보낸다 (server.js·.env 노출 방지)
app.get('/{*splat}', (_req, res) => {
  // 화면 파일을 고치면 바로 보이도록, 브라우저가 옛 파일을 쌓아 두지 않게 한다
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return badRequest(res, '보낸 자료(JSON) 모양이 올바르지 않아요.');
  if (err instanceof UserError || err instanceof UpstreamError) return res.status(err.status).json({ success: false, message: err.message });
  console.error(err);
  res.status(500).json({ success: false, message: '서버에 문제가 생겼어요. 잠시 후 다시 해 주세요.' });
});

// ── Startup & export ─────────────────────────
// 내 컴퓨터: 서버 켜기 / Vercel: app 을 내보내기만
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
