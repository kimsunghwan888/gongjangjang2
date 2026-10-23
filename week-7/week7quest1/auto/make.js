// 매일 16:00 실행: 정부 보도자료 찾기 → 요약 → 음성·화면 → 15~25초 세로 영상(MP4)
// 사용: node make.js            (오늘 자료)
//       TARGET_DATE=2026-10-22 node make.js   (날짜 지정)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, OUT, ymd, log, bin, chromePath, pythonCmd, fetchText, decode } = require('./common');

const VOICE = 'ko-KR-SunHiNeural';
const MIN_SEC = 15, MAX_SEC = 25;
const MINISTRIES = ['재정경제부', '기획재정부', '국토교통부', '국세청', '금융위원회'];
// 제목에 있으면 부처와 관계없이 대상 / 약한 단어는 해당 부처 자료일 때만 대상 ("전세계" 같은 오인 방지)
const STRONG = [/부동산/, /세금/, /세제/, /세법/, /주택/, /종부세/, /종합부동산/, /양도세|양도소득/, /재산세/, /취득세/,
  /공시가격|공시지가/, /청약/, /아파트/, /전세(?!계)/, /월세/, /분양/, /재건축|재개발/];
const WEAK = [/임대/, /대출/, /토지/, /상속|증여/, /소득세/, /부가가치세/, /연말정산/, /세무/, /국세/, /과세/, /공제/, /주거/, /택지/, /정비사업/];

// ── 1. 정책브리핑 보도자료 목록에서 부동산·세금 자료 찾기 ──
async function listDay(date) {
  const items = [], seen = new Set();
  for (let page = 1; page <= 8; page++) {
    const url = `https://www.korea.kr/briefing/pressReleaseList.do?pageIndex=${page}&startDate=${date}&endDate=${date}`;
    const html = await fetchText(url);
    const re = /pressReleaseView\.do\?newsId=(\d+)[\s\S]*?<strong>([\s\S]*?)<\/strong>[\s\S]*?<span class="source">\s*<span>([\d.]+)<\/span>\s*<span>([^<]*)<\/span>/g;
    let m, added = 0;
    while ((m = re.exec(html))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]); added++;
      items.push({ id: m[1], title: decode(m[2]).trim(), date: m[3], ministry: decode(m[4]).trim() });
    }
    if (!added) break;
  }
  return items;
}

function rank(items) {
  return items
    .map((it) => {
      const strong = STRONG.filter((k) => k.test(it.title)).length;
      const weak = WEAK.filter((k) => k.test(it.title)).length;
      const ministry = MINISTRIES.includes(it.ministry);
      return { ...it, ok: strong >= 1 || (ministry && weak >= 1), score: strong * 4 + weak * 2 + (ministry ? 3 : 0) };
    })
    .filter((it) => it.ok)
    .sort((a, b) => b.score - a.score);
}

// ── 2. 보도자료 본문 가져오기 (문서 뷰어 안에 쪽별로 들어 있음) ──
async function readBody(id) {
  const view = await fetchText(`https://www.korea.kr/briefing/pressReleaseView.do?newsId=${id}`);
  const m = view.match(/doc\.html\?fn=([a-f0-9]+)&amp;rs=([^"&]+)/);
  if (!m) throw new Error('본문 문서 주소를 찾지 못했습니다');
  const [fn, rs] = [m[1], decodeURIComponent(m[2])];
  const base = `https://www.korea.kr${rs}/${fn}`;
  let pages = 1;
  try {
    const xml = await fetchText(`${base}.xml`);
    pages = Math.min(8, +(xml.match(/<filespage_cnt>(\d+)</) || [])[1] || 1);
  } catch { /* 쪽 수를 모르면 1쪽만 */ }
  let text = '';
  for (let i = 1; i <= pages; i++) {
    try {
      const h = await fetchText(`${base}.files/${i}.html`);
      text += ' ' + h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ');
    } catch { break; }
  }
  return decode(text).replace(/\s+/g, ' ').trim();
}

// ── 3. 요약 (Gemini → 실패 시 claude 명령 → 실패 시 중단) ──
async function askGemini(prompt) {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('GEMINI_API_KEY 없음');
  for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-flash-latest']) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        }),
      });
      if (res.ok) {
        const j = await res.json();
        return j.candidates[0].content.parts[0].text;
      }
      log(`${model} 응답 ${res.status} (${attempt}번째)`);
      if (res.status === 429) break;               // 한도 소진 → 다음 모델
      await new Promise((r) => setTimeout(r, 4000 * attempt));
    }
  }
  throw new Error('Gemini 모든 모델 실패');
}

function askClaude(prompt) {
  const r = spawnSync('claude', ['-p', '--model', 'haiku'], {
    input: prompt, encoding: 'utf8', timeout: 180000, shell: true,
  });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error('claude 명령 실패');
  return r.stdout;
}

function parseJson(t) {
  const s = t.replace(/```json|```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  return JSON.parse(s.slice(a, b + 1));
}

function buildPrompt(item, body) {
  return `너는 정부 보도자료를 15~25초 세로 영상 대본으로 줄이는 작가다. 아래 보도자료만 근거로 쓴다.
규칙:
- 본문에 없는 사실·숫자·날짜·이름을 절대 넣지 않는다. 숫자는 본문 그대로 쓴다.
- 비판·부정·추측 표현 금지. 중립적이고 쉬운 말. 어려운 용어는 풀어 쓴다.
- 사람 이름(장관 등)은 쓰지 않는다.
- 시니어도 이해하는 짧은 말투(~해요, ~입니다).
JSON만 출력:
{"hook":"시선 끄는 한 줄(22자 이내)",
 "points":[{"head":"제목(14자 이내)","big":"핵심 숫자·날짜(10자 이내, 없으면 빈 문자열)","detail":"설명(28자 이내)","say":"낭독 문장(28자 이내)"}]}
points는 2~3개.

[제목] ${item.title}
[부처] ${item.ministry}
[본문]
${body.slice(0, 6000)}`;
}

function numbersOk(texts, bodyCompact) {
  const nums = (texts.join(' ').match(/\d[\d,.]*/g) || []).map((x) => x.replace(/[,.]+$/g, '').replace(/,/g, ''));
  return nums.every((n) => bodyCompact.includes(n));
}

async function summarize(item, body) {
  const prompt = buildPrompt(item, body);
  const compact = body.replace(/[\s,]/g, '');
  let raw;
  try { raw = await askGemini(prompt); }
  catch (e) { log('Gemini 실패:', e.message, '→ claude로 시도'); raw = askClaude(prompt); }
  const data = parseJson(raw);
  const pts = (data.points || []).filter((p) => {
    const ok = p.head && p.say && numbersOk([p.head, p.big || '', p.detail || '', p.say], compact);
    if (!ok) log('본문에 없는 숫자가 있어 항목 제외:', JSON.stringify(p));
    return ok;
  }).slice(0, 3);
  if (!data.hook || !numbersOk([data.hook], compact)) throw new Error('도입 문장이 규칙에 맞지 않습니다');
  if (pts.length < 2) throw new Error('쓸 수 있는 핵심 항목이 2개 미만입니다');
  return { hook: data.hook, points: pts };
}

// ── 4. 장면 구성 ──
function buildScenes(item, sum) {
  const [, mm, dd] = item.date.split('.');
  const mdText = `${+mm}월 ${+dd}일`;
  const circled = ['①', '②', '③'];
  const scenes = [{ tag: `${item.ministry} 보도자료 · ${item.date}`, h1: sum.hook, big: '', p: `핵심 ${sum.points.length}가지`, say: sum.hook }];
  sum.points.forEach((p, i) => scenes.push({ tag: `${circled[i]} 핵심`, h1: p.head, big: p.big || '', p: p.detail || '', say: p.say }));
  const outroSay = `${item.ministry} ${mdText} 보도자료입니다. 자세한 내용은 원문을 확인하세요.`;
  scenes.push({ tag: '출처', h1: `${item.ministry} 보도자료`, big: '', p: `${item.date} · 대한민국 정책브리핑`, p2: '자세한 내용은 원문을 확인하세요', say: outroSay });
  scenes.forEach((s) => { s.caption = s.say; });
  return scenes;
}

// ── 5. 음성(Edge-TTS) / 화면(크롬 캡처) / 영상(FFmpeg) ──
function durationOf(ffprobe, file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout);
}

function makeVoice(py, text, file, rate) {
  const txt = file.replace(/\.mp3$/, '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  for (let i = 1; i <= 3; i++) {
    const r = spawnSync(py, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${rate}`, '--file', txt, '--write-media', file], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(file)) return;
    log(`음성 만들기 실패 (${i}번째)`, (r.stderr || '').split('\n').slice(-2).join(' '));
  }
  throw new Error('Edge-TTS 음성 생성 실패');
}

function shot(chrome, html, png) {
  const r = spawnSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--window-size=360,640',
    '--force-device-scale-factor=3', '--virtual-time-budget=2000', `--screenshot=${png}`, 'file:///' + html.replace(/\\/g, '/')],
  { encoding: 'utf8', timeout: 60000 });
  if (!fs.existsSync(png)) throw new Error('화면 캡처 실패: ' + (r.stderr || '').slice(-200));
}

function renderVideo(scenes, dir) {
  const py = pythonCmd(), ffmpeg = bin('ffmpeg'), ffprobe = bin('ffprobe'), chrome = chromePath();
  const tpl = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8');

  // 목표 길이(15~25초)에 맞도록 음성 속도를 조절하고, 그래도 길면 마지막 핵심 항목을 뺀다
  let list = scenes.slice();
  let rates = ['+10%', '+20%', '+30%'], total, audio;
  for (;;) {
    for (const rate of rates) {
      audio = list.map((s, i) => {
        const f = path.join(dir, `voice${i}.mp3`);
        makeVoice(py, s.say, f, rate);
        return { file: f, sec: durationOf(ffprobe, f) };
      });
      total = audio.reduce((a, x) => a + x.sec, 0) + 0.5 * list.length;
      log(`음성 속도 ${rate} → 총 ${total.toFixed(1)}초`);
      if (total <= MAX_SEC) break;
    }
    if (total <= MAX_SEC || list.length <= 4) break;
    list.splice(list.length - 2, 1);                // 마지막 핵심 항목 제거 (출처 장면은 유지)
    log('길어서 핵심 항목 1개 제외');
  }
  const pad = total < MIN_SEC ? Math.min(1.5, (MIN_SEC - total) / list.length + 0.5) : 0.5;

  const parts = [];
  list.forEach((s, i) => {
    const html = path.join(dir, `scene${i}.html`);
    const inject = `<script>window.SCENE=${JSON.stringify(s)};window.INDEX=${i};window.TOTAL=${list.length};</script>`;
    fs.writeFileSync(html, tpl.replace('<body>', '<body>' + inject), 'utf8');
    const png = path.join(dir, `scene${i}.png`);
    shot(chrome, html, png);
    const dur = (audio[i].sec + pad).toFixed(2);
    const part = path.join(dir, `part${i}.mp4`);
    const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-loop', '1', '-t', dur, '-i', png, '-i', audio[i].file,
      '-filter_complex', `[1:a]apad=whole_dur=${dur},aformat=sample_rates=44100:channel_layouts=stereo[a];[0:v]scale=1080:1920,format=yuv420p[v]`,
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-t', dur, part], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('FFmpeg 장면 만들기 실패: ' + r.stderr);
    parts.push(part);
  });
  const listFile = path.join(dir, 'list.txt');
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const out = path.join(dir, 'reel.mp4');
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('FFmpeg 이어붙이기 실패: ' + r.stderr);
  return { out, seconds: durationOf(ffprobe, out), list };
}

function buildCaption(item, sum, url) {
  return [
    item.title,
    '',
    ...sum.points.map((p) => `• ${p.say}`),
    '',
    `출처: ${item.ministry} 보도자료 (대한민국 정책브리핑, ${item.date})`,
    url,
    '※ 정부 보도자료를 요약한 내용입니다. 정확한 내용은 원문을 확인하세요.',
    '',
    '#부동산 #세금 #정책 #보도자료 #정부소식',
  ].join('\n');
}

// ── 실행 ──
(async () => {
  const today = process.env.TARGET_DATE || ymd();
  const dir = path.join(OUT, today);
  fs.mkdirSync(dir, { recursive: true });
  log(`=== 보도자료 영상 만들기 시작 (${today}) ===`);

  // 오늘 자료 → 없으면 최근 3일 이내로 확장 (게시 문구에 보도 날짜가 그대로 표시됨)
  let candidates = [];
  const base = new Date(today + 'T00:00:00');
  for (let back = 0; back <= 3 && !candidates.length; back++) {
    const d = new Date(base); d.setDate(d.getDate() - back);
    const items = await listDay(ymd(d));
    candidates = rank(items);
    log(`${ymd(d)} 보도자료 ${items.length}건 중 부동산·세금 관련 ${candidates.length}건`);
  }
  if (!candidates.length) { log('쓸 만한 보도자료가 없어 오늘은 건너뜁니다'); process.exit(2); }

  // 이미 영상으로 만든 자료는 건너뛴다 (같은 내용 중복 게시 방지)
  const usedFile = path.join(OUT, 'used.json');
  const used = fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, 'utf8')) : [];
  const fresh = candidates.filter((c) => !used.includes(c.id));
  if (!fresh.length) { log('새로 쓸 보도자료가 없어 오늘은 건너뜁니다 (모두 이미 사용)'); process.exit(2); }

  let done = false;
  for (const item of fresh.slice(0, 5)) {
    try {
      log(`후보: [${item.ministry}] ${item.title} (${item.id})`);
      const body = await readBody(item.id);
      if (body.length < 300) throw new Error(`본문이 너무 짧습니다 (${body.length}자)`);
      const sum = await summarize(item, body);
      const scenes = buildScenes(item, sum);
      const work = path.join(dir, 'work');
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const r = renderVideo(scenes, work);
      const url = `https://www.korea.kr/briefing/pressReleaseView.do?newsId=${item.id}`;
      fs.copyFileSync(r.out, path.join(dir, 'reel.mp4'));
      fs.writeFileSync(path.join(dir, 'caption.txt'), buildCaption(item, sum, url), 'utf8');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        madeAt: new Date().toISOString(), date: today, seconds: r.seconds, source: url,
        title: item.title, ministry: item.ministry, releaseDate: item.date, scenes: r.list.map((s) => s.say),
      }, null, 2), 'utf8');
      // 게시 확인용 장면 그림도 남긴다
      r.list.forEach((_, i) => fs.copyFileSync(path.join(work, `scene${i}.png`), path.join(dir, `scene${i + 1}.png`)));
      fs.writeFileSync(usedFile, JSON.stringify([...used, item.id], null, 2), 'utf8');
      log(`완료: ${path.join(dir, 'reel.mp4')} (${r.seconds.toFixed(1)}초)`);
      done = true;
      break;
    } catch (e) {
      log(`이 후보는 건너뜀: ${e.message}`);
    }
  }
  if (!done) { log('모든 후보가 실패했습니다'); process.exit(1); }
})().catch((e) => { log('오류:', e.message); process.exit(1); });
