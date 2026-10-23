// 뉴스 릴스 자동화 (week7 quest2) — 파일 하나로 전부 처리
//   node server.js              관리 화면 서버 켜기 (http://localhost:3000)
//   node server.js --make       오늘 뉴스 찾기 → 영상 만들기 (배경 영상 → 목소리·자막·효과음)
//   node server.js --post       만든 영상을 인스타·페이스북에 올리기 (--dry-run 이면 점검만)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ── 설정 ──────────────────────────────────────
const ROOT = __dirname;
const OUT = path.join(ROOT, 'output');
const LOGS = path.join(ROOT, 'logs');
const BG = path.join(ROOT, 'bg'); // 직접 모은 무료 스톡 영상(mp4)을 넣는 곳
const PORT = process.env.PORT || 3000;
const VOICE = 'ko-KR-SunHiNeural';
const BRAND = 'VitaNoa';
const TARGET_SEC = 19, MIN_PAD = 0.35; // 영상 길이는 항상 19초에 맞춘다
// 방송국·언론사 이름은 영상·문구 어디에도 넣지 않는다
const OUTLET = /MBC|KBS|SBS|YTN|JTBC|MBN|EBS|CBS|CNN|BBC|NHK|FOX|NBC|ABC|TV\s?조선|채널\s?A|연합뉴스(?:TV)?|뉴시스|뉴스1|한겨레|경향신문|조선일보|중앙일보|동아일보|한국일보|매일경제|한국경제|세계일보|문화일보|[가-힣A-Za-z0-9]+(?:방송|일보|신문)/gi;
const noOutlet = (t) => String(t || '').replace(OUTLET, '').replace(/[\[(][\s·,]*[\])]/g, '').replace(/\s{2,}/g, ' ').trim();
const hasOutlet = (t) => { OUTLET.lastIndex = 0; return OUTLET.test(String(t || '')); };
const env = (n) => (process.env[n] || '').trim();
const SKY = '#4fb0f0', PINK = '#ff9fc6'; // 소라(연한 하늘색)·연핑크
const PALETTES = [[SKY, PINK]]; // [강조색, 보조색]

// ── 공통 도구 ─────────────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const log = (...a) => console.log(`[${new Date().toLocaleString('ko-KR')}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

function works(cmd, args) {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 }).status === 0; } catch { return false; }
}
function wingetBin(name) { // PATH에 없을 때 winget 설치 위치에서 찾기
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(base)) {
      const walk = (dir, depth) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isFile() && e.name.toLowerCase() === name + '.exe') return p;
          if (e.isDirectory() && depth < 3) { const r = walk(p, depth + 1); if (r) return r; }
        }
        return null;
      };
      const hit = walk(path.join(base, pkg), 0);
      if (hit) return hit;
    }
  } catch { /* 없으면 null */ }
  return null;
}
function findBin(name, versionArg = '-version') {
  if (works(name, [versionArg])) return name;
  return wingetBin(name);
}
function chromePath() {
  return ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find((p) => fs.existsSync(p)) || null;
}
function pythonCmd() {
  if (works('python', ['--version'])) return 'python';
  const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
  return fs.existsSync(p) ? p : null;
}
const need = (v, label) => { if (!v) throw new Error(`${label} 프로그램을 찾을 수 없습니다`); return v; };

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split('?')[0]}`);
  return r.json();
}
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${label} 실패: ${(r.stderr || '').split('\n').slice(-6).join(' ')}`);
  return r;
}
function duration(ffprobe, file) {
  return parseFloat(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout);
}

// ══════════════════════════════════════════════
// 1. 뉴스 모으기 (NewsAPI.org · NewsData.io · GNews, 키 없으면 구글뉴스 RSS로 대신)
// ══════════════════════════════════════════════
const NEWS_SOURCES = [
  {
    name: 'GNews', key: 'GNEWS_KEY', run: async (k) => (await getJson(`https://gnews.io/api/v4/top-headlines?category=general&lang=ko&country=kr&max=10&apikey=${k}`))
      .articles.map((a) => ({ title: a.title, desc: a.description, url: a.url, image: a.image, media: a.source && a.source.name })),
  },
  {
    name: 'NewsData', key: 'NEWSDATA_KEY', run: async (k) => (await getJson(`https://newsdata.io/api/1/latest?apikey=${k}&country=kr&language=ko&category=top`))
      .results.map((a) => ({ title: a.title, desc: a.description, url: a.link, image: a.image_url, media: a.source_name })),
  },
  {
    name: 'NewsAPI', key: 'NEWSAPI_KEY', run: async (k) => (await getJson(`https://newsapi.org/v2/top-headlines?country=us&pageSize=10&apiKey=${k}`))
      .articles.map((a) => ({ title: a.title, desc: (a.description || '').replace(/\s*\[\+\d+ chars\]$/, ''), url: a.url, image: a.urlToImage, media: a.source && a.source.name })),
  },
];

async function googleNewsRss() {
  const res = await fetch('https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const t = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const l = (m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const s = (m[1].match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    const title = t.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+-\s+[^-]+$/, '').trim();
    if (title && l) out.push({ title, desc: '', url: l.trim(), image: '', media: s });
  }
  return out.slice(0, 12);
}

async function collectNews() {
  let all = [];
  for (const s of NEWS_SOURCES) {
    const k = env(s.key);
    if (!k) { log(`${s.name}: 키(${s.key}) 없음 → 건너뜀`); continue; }
    try { const r = (await s.run(k)).filter((a) => a.title && a.url); log(`${s.name}: ${r.length}건`); all = all.concat(r.map((a) => ({ ...a, from: s.name }))); }
    catch (e) { log(`${s.name} 실패: ${e.message}`); }
  }
  if (all.length < 5) {
    try { const r = await googleNewsRss(); log(`구글뉴스 RSS(대체): ${r.length}건`); all = all.concat(r.map((a) => ({ ...a, from: 'GoogleNews' }))); }
    catch (e) { log('구글뉴스 RSS 실패: ' + e.message); }
  }
  const seen = new Set();
  return all.filter((a) => { const k = a.title.replace(/\W/g, '').slice(0, 24); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ══════════════════════════════════════════════
// 2. 요약·대본 (Gemini → 실패 시 claude 명령)
// ══════════════════════════════════════════════
async function askGemini(prompt) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY 없음');
  for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest']) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
      });
      if (res.ok) return (await res.json()).candidates[0].content.parts[0].text;
      log(`${model} 응답 ${res.status} (${attempt}번째)`);
      if (res.status === 429) break;
      await sleep(4000 * attempt);
    }
  }
  throw new Error('Gemini 모든 모델 실패');
}
function askClaude(prompt) {
  const r = spawnSync('claude', ['-p', '--model', 'haiku'], { input: prompt, encoding: 'utf8', timeout: 180000, shell: true });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('claude 명령 실패');
  return r.stdout;
}
function parseJson(t) {
  const s = t.replace(/```json|```/g, '').trim();
  return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
}
const numbersOk = (texts, source) => {
  const src = source.replace(/[\s,]/g, '');
  return (texts.join(' ').match(/\d[\d,.]*/g) || []).map((x) => x.replace(/[,.]+$/g, '').replace(/,/g, '')).every((n) => src.includes(n));
};

async function writeScript(list) {
  const listing = list.map((a, i) => `${i + 1}. ${noOutlet(a.title)}${a.desc ? ' — ' + noOutlet(a.desc).slice(0, 200) : ''}`).join('\n');
  const prompt = `너는 뉴스를 15~30초 세로 영상(릴스) 대본으로 줄이는 작가다. 아래 뉴스 목록에서 오늘 가장 화제가 될 만한 1건을 고르고, 그 기사의 제목·설명에 적힌 내용만 근거로 쓴다.
규칙:
- 목록에 없는 사실·숫자·날짜·이름을 절대 넣지 않는다. 숫자는 그대로 쓴다.
- 방송국·신문사·언론사 이름(MBC, KBS, 연합뉴스 등)은 어디에도 절대 쓰지 않는다.
- 비판·추측·선정적 표현 금지. 쉽고 짧은 말투(~해요, ~입니다).
- bgPrompt는 영어로, 배경 영상 장면 묘사 한 문장. 실존 인물의 얼굴·모습은 묘사하지 말고 상징물(연단 실루엣, 국기, 자유의 여신상, 도시 야경, 국회 건물 등)로 표현. 글자·로고 금지. 밝고 선명한 색감.
JSON만 출력:
{"pick":번호,"hook":"시선 끄는 한 줄(18자 이내)",
 "lines":[{"head":"제목(14자 이내)","big":"핵심 숫자·키워드(10자 이내, 없으면 빈 문자열)","say":"낭독 문장(30자 이내)"}],
 "bgPrompt":"...","hashtags":["#...","#..."]}
lines는 3개. hashtags는 3~4개.

[뉴스 목록]
${listing}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try { raw = await askGemini(prompt); } catch (e) { log('Gemini 실패:', e.message, '→ claude로 시도'); raw = askClaude(prompt); }
    const d = parseJson(raw);
    const item = list[(+d.pick || 0) - 1];
    if (!item) { log('고른 번호가 목록에 없음'); continue; }
    const src = `${noOutlet(item.title)} ${noOutlet(item.desc)}`;
    const lines = (d.lines || []).filter((l) => l.head && l.say && !hasOutlet(`${l.head} ${l.big} ${l.say}`) && numbersOk([l.head, l.big || '', l.say], src)).slice(0, 3);
    if (!d.hook || hasOutlet(d.hook) || !numbersOk([d.hook], src) || lines.length < 2) { log(`대본이 규칙에 맞지 않아 다시 시도 (${attempt}번째)`); continue; }
    return { item, hook: d.hook, lines, bgPrompt: d.bgPrompt || 'bright colorful abstract city lights, cinematic', hashtags: (d.hashtags || []).filter((h) => !hasOutlet(h)) };
  }
  throw new Error('규칙에 맞는 대본을 만들지 못했습니다');
}

// ══════════════════════════════════════════════
// 3. 1단계: 배경 영상 만들기 (fal.ai → 내 스톡 영상 → 기사 사진 → 색 그라데이션)
// ══════════════════════════════════════════════
async function falVideo(prompt, file) {
  const model = env('FAL_MODEL') || 'fal-ai/bytedance/seedance/v1/lite/text-to-video'; // 쓰려는 모델 이름으로 바꾸려면 FAL_MODEL 설정
  const H = { Authorization: 'Key ' + env('FAL_KEY'), 'Content-Type': 'application/json' };
  let extra = {}; try { extra = JSON.parse(env('FAL_EXTRA') || '{}'); } catch { /* 무시 */ }
  const sub = await getJson(`https://queue.fal.run/${model}`, { method: 'POST', headers: H, body: JSON.stringify({ prompt, aspect_ratio: '9:16', duration: '5', ...extra }) });
  for (let i = 0; i < 60; i++) { // 최대 약 8분
    await sleep(8000);
    const st = await getJson(sub.status_url, { headers: H });
    if (st.status === 'COMPLETED') {
      const out = await getJson(sub.response_url, { headers: H });
      const url = out.video && out.video.url;
      if (!url) throw new Error('fal 응답에 영상 주소가 없음');
      fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
      return;
    }
    if (st.status === 'FAILED' || st.error) throw new Error('fal 생성 실패');
  }
  throw new Error('fal 시간 초과');
}

async function makeBackground(ffmpeg, work, sec, script) {
  const out = path.join(work, 'bg.mp4');
  const fit = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,eq=brightness=0.03:saturation=1.2,format=yuv420p';
  const enc = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-t', sec.toFixed(2), out];
  const clip = (src) => run(ffmpeg, ['-y', '-loglevel', 'error', '-stream_loop', '-1', '-i', src, '-vf', fit, ...enc], '배경 영상 맞추기');

  if (env('FAL_KEY')) {
    try { const f = path.join(work, 'fal.mp4'); log('배경: fal.ai로 AI 영상 생성 중…'); await falVideo(script.bgPrompt, f); clip(f); return '배경: fal.ai AI 영상'; }
    catch (e) { log('fal.ai 실패: ' + e.message); }
  }
  const mine = fs.existsSync(BG) ? fs.readdirSync(BG).filter((f) => /\.(mp4|mov|webm)$/i.test(f)) : [];
  if (mine.length) {
    const pick = mine[Math.floor(Math.random() * mine.length)];
    clip(path.join(BG, pick)); return `배경: 내 스톡 영상(${pick})`;
  }
  if (script.item.image) {
    try {
      const r = await fetch(script.item.image, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const img = path.join(work, 'article.jpg');
      fs.writeFileSync(img, Buffer.from(await r.arrayBuffer()));
      run(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '30', '-loop', '1', '-i', img, '-vf',
        `scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,zoompan=z='min(zoom+0.0005,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30,eq=brightness=0.03:saturation=1.2,format=yuv420p`,
        ...enc], '기사 사진 배경');
      return '배경: 기사 사진 + 천천히 확대';
    } catch (e) { log('기사 사진 실패: ' + e.message); }
  }
    run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `gradients=s=1080x1920:d=${sec.toFixed(2)}:c0=0xbfe8ff:c1=0xffd6e8:c2=0xd4efff:nb_colors=3:speed=0.03:rate=30`,
    '-vf', 'format=yuv420p', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', out], '그라데이션 배경');
  return '배경: 움직이는 색 그라데이션';
}

// ══════════════════════════════════════════════
// 4. 2단계: 목소리(Edge-TTS) + 자막 화면 + 효과음 + VitaNoa 올리기
// ══════════════════════════════════════════════
function buildScenes(script) {
  const scenes = [{ kind: 'hook', tag: 'TODAY NEWS', h1: script.hook, big: '', say: script.hook }];
  script.lines.forEach((l, i) => scenes.push({ kind: 'point', tag: `POINT ${i + 1}`, h1: l.head, big: l.big || '', say: l.say }));
  scenes.push({ kind: 'outro', tag: 'SOURCE', h1: '자세한 내용은 원문 링크에서 확인하세요', big: '', say: '자세한 내용은 원문 링크에서 확인하세요.' });
  return scenes;
}

function makeVoice(py, text, file, rate) {
  const txt = file.replace(/\.mp3$/, '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync(py, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${rate}`, '--file', txt, '--write-media', file], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(file)) return;
    log(`음성 만들기 실패 (${i}번째)`);
  }
  throw new Error('Edge-TTS 음성 생성 실패');
}

const CSS_BASE = `*{margin:0;padding:0;box-sizing:border-box}html,body{width:360px;height:640px;background:transparent;overflow:hidden;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif}.f{position:absolute;left:0;top:0;width:360px;height:640px;overflow:hidden}`;
function sceneHtml(s, [acc, acc2]) {
  const hook = s.kind === 'hook';
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS_BASE}
.tag{position:absolute;top:46px;left:22px;background:${acc};color:#fff;font-weight:900;font-size:13px;letter-spacing:1.5px;padding:7px 15px;border-radius:99px;box-shadow:0 4px 14px rgba(0,0,0,.28)}
.card{position:absolute;left:20px;right:20px;top:${hook ? 190 : 130}px;background:rgba(255,255,255,.92);border-radius:28px;padding:${hook ? '34px 24px' : '24px 22px'};box-shadow:0 14px 40px rgba(0,0,0,.28);border-left:9px solid ${acc}}
.h1{font-size:${hook ? 36 : 29}px;font-weight:900;color:#14213d;line-height:1.3;word-break:keep-all}
.big{font-size:54px;font-weight:900;color:${acc};margin-top:10px;line-height:1.1;word-break:keep-all;text-shadow:3px 3px 0 ${acc2}}
.cap{position:absolute;left:16px;right:16px;bottom:112px;text-align:center;color:#fff;font-size:23px;font-weight:900;line-height:1.45;word-break:keep-all;text-shadow:0 3px 0 rgba(20,40,80,.65),0 0 16px rgba(20,40,80,.6)}
.cap u{text-decoration:none;background:linear-gradient(transparent 62%,${acc} 62%)}
</style></head><body><div class="f">
<div class="tag">${esc(s.tag)}</div>
<div class="card"><div class="h1">${esc(s.h1)}</div>${s.big ? `<div class="big">${esc(s.big)}</div>` : ''}</div>
<div class="cap"><u>${esc(s.say)}</u></div>
</div></body></html>`;
}
function watermarkHtml([acc]) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS_BASE}
.wm{position:absolute;left:50%;bottom:36px;transform:translateX(-50%);background:${acc};color:#fff;font-weight:900;font-size:19px;letter-spacing:3px;padding:7px 20px;border-radius:99px;box-shadow:0 3px 12px rgba(0,0,0,.22)}
</style></head><body><div class="f"><div class="wm">${BRAND}</div></div></body></html>`;
}
function shot(chrome, html, png) {
  spawnSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--window-size=360,640',
    '--force-device-scale-factor=3', '--virtual-time-budget=1500', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 60000 });
  if (!fs.existsSync(png)) throw new Error('화면 캡처 실패');
}

function compose(ffprobe, py, work, scenes) {
  // 가장 천천히 읽어도 19초 안에 들어오는 속도를 고르고, 남는 시간은 장면마다 고르게 나눠 정확히 19초로 맞춘다
  let audio, sum = 0, ok = false;
  for (const rate of ['-10%', '+0%', '+10%', '+20%', '+30%', '+40%']) {
    audio = scenes.map((s, i) => { const f = path.join(work, `voice${i}.mp3`); makeVoice(py, s.say, f, rate); return { f, sec: duration(ffprobe, f) }; });
    sum = audio.reduce((a, x) => a + x.sec, 0);
    log(`음성 속도 ${rate} → 말하는 시간 ${sum.toFixed(1)}초`);
    if (sum + MIN_PAD * scenes.length <= TARGET_SEC) { ok = true; break; }
  }
  if (!ok) return null; // 너무 길다 → 호출한 쪽에서 문장을 줄인다
  const gap = (TARGET_SEC - sum) / scenes.length;
  const durs = audio.map((a) => a.sec + gap);
  const starts = durs.map((_, i) => durs.slice(0, i).reduce((a, b) => a + b, 0));
  return { audio, durs, starts, total: TARGET_SEC };
}

function finish(ffmpeg, work, plan, scenes, pal, chrome, bgFile, outFile) {
  // 장면 화면(투명 PNG) + 이름표
  const pngs = scenes.map((s, i) => {
    const h = path.join(work, `scene${i}.html`), p = path.join(work, `scene${i}.png`);
    fs.writeFileSync(h, sceneHtml(s, pal), 'utf8'); shot(chrome, h, p); return p;
  });
  const wh = path.join(work, 'wm.html'), wp = path.join(work, 'wm.png');
  fs.writeFileSync(wh, watermarkHtml(pal), 'utf8'); shot(chrome, wh, wp);

  // 목소리 한 줄로 이어붙이기 (장면 시작 직후 0.15초 뒤에 말 시작)
  const wavs = plan.audio.map((a, i) => {
    const w = path.join(work, `voice${i}.wav`);
    run(ffmpeg, ['-y', '-loglevel', 'error', '-i', a.f, '-af', `adelay=150|150,apad,atrim=0:${plan.durs[i].toFixed(3)}`, '-ar', '44100', '-ac', '2', w], '목소리 정리');
    return w;
  });
  const lst = path.join(work, 'voices.txt');
  fs.writeFileSync(lst, wavs.map((w) => `file '${w.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const voice = path.join(work, 'voice.wav');
  run(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', voice], '목소리 이어붙이기');

  // 입력: 0 배경, 1 목소리, 2.. 장면 화면, 마지막 이름표
  const args = ['-y', '-loglevel', 'error', '-i', bgFile, '-i', voice];
  pngs.forEach((p, i) => args.push('-loop', '1', '-t', plan.durs[i].toFixed(3), '-i', p));
  args.push('-loop', '1', '-t', plan.total.toFixed(3), '-i', wp);
  const f = [];
  let last = '0:v';
  pngs.forEach((_, i) => {
    const s = plan.starts[i].toFixed(3), e = (plan.starts[i] + plan.durs[i]).toFixed(3);
    f.push(`[${i + 2}:v]scale=1080:1920,format=rgba,fade=t=in:st=0:d=0.3:alpha=1,setpts=PTS+${s}/TB[o${i}]`);
    f.push(`[${last}][o${i}]overlay=enable='between(t,${s},${e})'[v${i}]`);
    last = `v${i}`;
  });
  f.push(`[${pngs.length + 2}:v]scale=1080:1920,format=rgba[wm]`, `[${last}][wm]overlay=0:0,format=yuv420p[vout]`);
  // 효과음: 장면마다 "쉬익" 바람소리 + 맑은 "띵" (파일 없이 FFmpeg로 합성)
  const mix = ['[1:a]'];
  plan.starts.forEach((st, i) => {
    const ms = Math.round(st * 1000);
    f.push(`anoisesrc=d=0.45:c=pink:a=0.6:r=44100,highpass=f=500,lowpass=f=7000,afade=t=in:d=0.14,afade=t=out:st=0.18:d=0.27,volume=0.45,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[w${i}]`);
    mix.push(`[w${i}]`);
    if (scenes[i].kind !== 'outro') {
      f.push(`sine=f=1760:d=0.22:r=44100,afade=t=out:st=0.03:d=0.19,volume=0.22,aformat=channel_layouts=stereo,adelay=${ms + 230}|${ms + 230}[d${i}]`);
      mix.push(`[d${i}]`);
    }
  });
  f.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
  args.push('-filter_complex', f.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', plan.total.toFixed(3), outFile);
  run(ffmpeg, args, '목소리·자막 입히기');
}

// ══════════════════════════════════════════════
// 5. 영상 만들기 전체 (--make)
// ══════════════════════════════════════════════
async function make() {
  const today = process.env.TARGET_DATE || ymd();
  const dir = path.join(OUT, today), work = path.join(dir, 'work');
  const ffmpeg = need(findBin('ffmpeg'), 'ffmpeg'), ffprobe = need(findBin('ffprobe'), 'ffprobe');
  const chrome = need(chromePath(), '크롬/엣지'), py = need(pythonCmd(), 'python(edge-tts)');
  log(`=== 뉴스 릴스 만들기 시작 (${today}) ===`);

  const usedFile = path.join(OUT, 'used.json');
  fs.mkdirSync(OUT, { recursive: true });
  const used = readJson(usedFile, []);
  const fresh = (await collectNews()).filter((a) => !used.includes(a.url));
  if (!fresh.length) { log('새 뉴스가 없어 오늘은 건너뜁니다'); process.exit(2); }

  const script = await writeScript(fresh.slice(0, 20));
  log(`선택: ${noOutlet(script.item.title)}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const pal = PALETTES[0];
  log('1단계: 배경 영상 만들기');
  let scenes, plan;
  for (;;) { // 19초에 안 들어가면 마지막 핵심 문장을 하나 줄인다
    scenes = buildScenes(script);
    plan = compose(ffprobe, py, work, scenes);
    if (plan) break;
    if (script.lines.length <= 2) throw new Error('문장을 줄여도 19초에 들어가지 않습니다');
    script.lines.pop(); log('길어서 핵심 문장 1개 제외');
  }
  const bgNote = await makeBackground(ffmpeg, work, plan.total, script);
  log(bgNote);
  log('2단계: 목소리·자막·효과음·VitaNoa 입히기');
  const reel = path.join(dir, 'reel.mp4');
  finish(ffmpeg, work, plan, scenes, pal, chrome, path.join(work, 'bg.mp4'), reel);

  const it = script.item;
  const caption = [script.hook, '', ...script.lines.map((l) => `• ${l.say}`), '', `원문: ${noOutlet(it.title)}`, it.url,
    '※ 뉴스 제목·설명을 요약한 내용입니다. 정확한 내용은 원문을 확인하세요.', '', [...script.hashtags, `#${BRAND}`].join(' ')].join('\n');
  fs.writeFileSync(path.join(dir, 'caption.txt'), caption, 'utf8');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    madeAt: new Date().toISOString(), date: today, seconds: duration(ffprobe, reel), title: noOutlet(it.title), source: it.url,
    api: it.from, background: bgNote, scenes: scenes.map((s) => s.say),
  }, null, 2), 'utf8');
  fs.copyFileSync(path.join(work, 'scene1.png'), path.join(dir, 'preview.png'));
  fs.writeFileSync(usedFile, JSON.stringify([...used, it.url].slice(-300), null, 2), 'utf8');
  log(`완료: ${reel} (${duration(ffprobe, reel).toFixed(1)}초)`);
}

// ══════════════════════════════════════════════
// 6. 인스타·페이스북 올리기 (--post) — Meta 키 3개 필요
// ══════════════════════════════════════════════
const V = 'v21.0', GRAPH = `https://graph.facebook.com/${V}`;
async function meta(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!res.ok || j.error) { const e = j.error || j; throw new Error(`HTTP ${res.status} ${e.message || e.raw || ''} (코드 ${e.code || '-'})`); }
  return j;
}
async function post(dry) {
  const T = env('META_ACCESS_TOKEN'), IG = env('IG_USER_ID'), PAGE = env('FB_PAGE_ID');
  const form = (o) => new URLSearchParams({ ...o, access_token: T });
  const upload = (u, buf) => meta(u, { method: 'POST', headers: { Authorization: `OAuth ${T}`, offset: '0', file_size: String(buf.length) }, body: buf });
  const today = ymd(), dir = path.join(OUT, today);
  const mp4 = path.join(dir, 'reel.mp4'), capFile = path.join(dir, 'caption.txt'), doneFile = path.join(dir, 'posted.json');
  log(`=== 게시 시작 (${today})${dry ? ' [점검만]' : ''} ===`);
  if (!fs.existsSync(mp4) || !fs.existsSync(capFile)) { log('오늘 만든 영상이 없어 게시하지 않습니다'); process.exit(2); }
  const missing = [['META_ACCESS_TOKEN', T], ['IG_USER_ID', IG], ['FB_PAGE_ID', PAGE]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) { log('Meta 키가 없어 게시할 수 없습니다. 없는 것: ' + missing.join(', ')); process.exit(3); }
  if (dry) { log('점검 통과: 영상·문구·키 모두 준비됨'); return; }
  const buf = fs.readFileSync(mp4), caption = fs.readFileSync(capFile, 'utf8');
  const state = readJson(doneFile, {});
  let failed = false;

  if (!state.instagram) {
    try {
      const c = await meta(`${GRAPH}/${IG}/media`, { method: 'POST', body: form({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true' }) });
      await upload(`https://rupload.facebook.com/ig-api-upload/${V}/${c.id}`, buf);
      for (let i = 0; i < 40; i++) {
        await sleep(9000);
        const s = await meta(`${GRAPH}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(T)}`);
        log('인스타 처리 상태:', s.status_code);
        if (s.status_code === 'FINISHED') break;
        if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('처리 실패 ' + (s.status || ''));
        if (i === 39) throw new Error('처리 시간 초과');
      }
      state.instagram = (await meta(`${GRAPH}/${IG}/media_publish`, { method: 'POST', body: form({ creation_id: c.id }) })).id;
      log('인스타 게시 완료: ' + state.instagram);
    } catch (e) { failed = true; log('인스타 게시 실패: ' + e.message); }
  }
  if (!state.facebook) {
    try {
      const s = await meta(`${GRAPH}/${PAGE}/video_reels`, { method: 'POST', body: form({ upload_phase: 'start' }) });
      await upload(s.upload_url, buf);
      await sleep(5000);
      const f = await meta(`${GRAPH}/${PAGE}/video_reels`, { method: 'POST', body: form({ upload_phase: 'finish', video_id: s.video_id, video_state: 'PUBLISHED', description: caption }) });
      state.facebook = f.post_id || s.video_id;
      log('페이스북 게시 완료: ' + state.facebook);
    } catch (e) { failed = true; log('페이스북 게시 실패: ' + e.message); }
  }
  fs.writeFileSync(doneFile, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2), 'utf8');
  if (failed) process.exit(1);
}

// ══════════════════════════════════════════════
// 7. 관리 화면 서버 (index.html 이 사용하는 API)
// ══════════════════════════════════════════════
const SECRET_NAMES = ['NEWSAPI_KEY', 'NEWSDATA_KEY', 'GNEWS_KEY', 'GEMINI_API_KEY', 'FAL_KEY', 'META_ACCESS_TOKEN', 'IG_USER_ID', 'FB_PAGE_ID'];
let child = null, childName = '';
const json = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } }); });
const MIME = { '.html': 'text/html; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

function status() {
  const today = ymd(), dir = path.join(OUT, today);
  return {
    today, running: child ? childName : null,
    keys: Object.fromEntries(SECRET_NAMES.map((k) => [k, !!env(k)])), // 있음/없음만 알려줌 (값은 비공개)
    tools: { ffmpeg: !!findBin('ffmpeg'), ytdlp: !!findBin('yt-dlp', '--version'), edgeTts: !!pythonCmd(), chrome: !!chromePath() },
    bgClips: fs.existsSync(BG) ? fs.readdirSync(BG).filter((f) => /\.(mp4|mov|webm)$/i.test(f)).length : 0,
    todayMade: fs.existsSync(path.join(dir, 'reel.mp4')),
  };
}
function videos() {
  if (!fs.existsSync(OUT)) return [];
  return fs.readdirSync(OUT).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(path.join(OUT, d, 'reel.mp4'))).sort().reverse().slice(0, 30)
    .map((d) => ({
      date: d, url: `/output/${d}/reel.mp4`, meta: readJson(path.join(OUT, d, 'meta.json'), {}), posted: readJson(path.join(OUT, d, 'posted.json'), null),
      caption: fs.existsSync(path.join(OUT, d, 'caption.txt')) ? fs.readFileSync(path.join(OUT, d, 'caption.txt'), 'utf8') : '',
    }));
}
function startTask(name, flags) {
  if (child) throw new Error(`이미 "${childName}" 작업이 진행 중입니다`);
  fs.mkdirSync(LOGS, { recursive: true });
  const fd = fs.openSync(path.join(LOGS, `${name.startsWith('post') ? 'post' : name}.log`), 'a');
  childName = name;
  child = spawn(process.execPath, [__filename, ...flags], { stdio: ['ignore', fd, fd], windowsHide: true });
  child.on('exit', () => { child = null; childName = ''; });
}
function serveFile(req, res, file) {
  const st = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  if (m) {
    const s = m[1] ? +m[1] : 0, e = m[2] ? +m[2] : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
    return fs.createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

async function handler(req, res) {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403); return res.end('forbidden'); } // 이 컴퓨터에서만 접속
    const u = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(u.pathname);
    if (p === '/api/status') return json(res, { success: true, data: status() });
    if (p === '/api/videos') return json(res, { success: true, data: videos() });
    if (p === '/api/log') {
      const f = path.join(LOGS, (u.searchParams.get('name') === 'post' ? 'post' : 'make') + '.log');
      const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      return json(res, { success: true, data: t.slice(-6000) });
    }
    if (p === '/api/run' && req.method === 'POST') {
      const { action } = await readBody(req);
      const map = { make: ['make', ['--make']], post: ['post', ['--post']], 'post-dry': ['post-dry', ['--post', '--dry-run']] };
      if (!map[action]) return json(res, { success: false, message: '알 수 없는 작업입니다' }, 400);
      startTask(...map[action]);
      return json(res, { success: true, data: { started: action } }, 202);
    }
    if (p === '/api/key' && req.method === 'POST') { // 키는 이 컴퓨터(서버)의 사용자 환경변수에만 저장, 화면으로는 절대 돌려보내지 않음
      const { name, value } = await readBody(req);
      if (!SECRET_NAMES.includes(name)) return json(res, { success: false, message: '저장할 수 없는 이름입니다' }, 400);
      const v = String(value || '').trim();
      if (!v || /[\r\n]/.test(v)) return json(res, { success: false, message: '값이 비었거나 형식이 잘못되었습니다' }, 400);
      const r = spawnSync('powershell', ['-NoProfile', '-Command', '[Environment]::SetEnvironmentVariable($env:KN, $env:KV, "User")'],
        { env: { ...process.env, KN: name, KV: v }, encoding: 'utf8', timeout: 20000 });
      if (r.status !== 0) return json(res, { success: false, message: '저장에 실패했습니다' }, 500);
      process.env[name] = v;
      return json(res, { success: true, data: { saved: name } });
    }
    if (p === '/api/bg' && req.method === 'POST') { // yt-dlp 로 무료 스톡 영상 받기
      const { url } = await readBody(req);
      if (!/^https?:\/\//.test(url || '')) return json(res, { success: false, message: '주소는 http(s)로 시작해야 합니다' }, 400);
      const yt = findBin('yt-dlp', '--version');
      if (!yt) return json(res, { success: false, message: 'yt-dlp 가 설치되어 있지 않습니다' }, 400);
      fs.mkdirSync(BG, { recursive: true });
      const r = spawnSync(yt, ['-f', 'mp4[height<=1080]/best[height<=1080]', '--max-filesize', '150M', '--match-filter', 'duration<=180', '--no-playlist',
        '-o', path.join(BG, '%(id)s.%(ext)s'), url], { encoding: 'utf8', timeout: 300000 });
      if (r.status !== 0) return json(res, { success: false, message: '내려받기 실패: ' + (r.stderr || '').split('\n').slice(-3).join(' ') }, 500);
      return json(res, { success: true, data: status().bgClips });
    }
    if (p.startsWith('/output/')) {
      const f = path.normalize(path.join(OUT, p.slice(8)));
      if (!f.startsWith(OUT + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
      return serveFile(req, res, f);
    }
    if (p.startsWith('/api/')) return json(res, { success: false, message: '없는 주소입니다' }, 404);
    return serveFile(req, res, path.join(ROOT, 'index.html'));
  } catch (e) {
    console.error(e);
    return json(res, { success: false, message: e.message }, 500);
  }
}

// ── 시작 ─────────────────────────────────────
if (require.main === module) {
  const a = process.argv;
  const fail = (e) => { log('오류:', e.message); process.exit(1); };
  if (a.includes('--make')) make().catch(fail);
  else if (a.includes('--post')) post(a.includes('--dry-run')).catch(fail);
  else http.createServer(handler).listen(PORT, '127.0.0.1', () => console.log(`관리 화면: http://localhost:${PORT}`));
}
module.exports = handler;
