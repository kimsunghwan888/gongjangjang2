// 매일 16:30 실행: 오늘 만든 영상을 인스타그램 릴스 + 페이스북 페이지 릴스로 게시
// 사용: node post.js            (실제 게시)
//       node post.js --dry-run  (게시하지 않고 준비 상태만 점검)
// 필요한 환경변수(값은 파일에 적지 않음): META_ACCESS_TOKEN, IG_USER_ID, FB_PAGE_ID
const fs = require('fs');
const path = require('path');
const { OUT, ymd, log } = require('./common');

const V = 'v21.0';
const GRAPH = `https://graph.facebook.com/${V}`;
const dry = process.argv.includes('--dry-run');
const env = (n) => (process.env[n] || '').trim();
const TOKEN = env('META_ACCESS_TOKEN'), IG = env('IG_USER_ID'), PAGE = env('FB_PAGE_ID');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 300) }; }
  if (!res.ok || j.error) {
    const e = j.error || j;
    throw new Error(`HTTP ${res.status} ${e.message || e.raw || ''} (코드 ${e.code || '-'})`);
  }
  return j;
}

const form = (o) => new URLSearchParams({ ...o, access_token: TOKEN });

async function upload(uploadUrl, buf) {
  return api(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${TOKEN}`, offset: '0', file_size: String(buf.length) },
    body: buf,
  });
}

// 인스타그램 릴스: 컨테이너 만들기 → 파일 올리기 → 처리 대기 → 게시
async function postInstagram(buf, caption) {
  const c = await api(`${GRAPH}/${IG}/media`, {
    method: 'POST',
    body: form({ media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: 'true' }),
  });
  await upload(`https://rupload.facebook.com/ig-api-upload/${V}/${c.id}`, buf);
  for (let i = 0; i < 40; i++) {                         // 최대 약 6분 대기
    await sleep(9000);
    const s = await api(`${GRAPH}/${c.id}?fields=status_code,status&access_token=${encodeURIComponent(TOKEN)}`);
    log('인스타 처리 상태:', s.status_code);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`처리 실패 ${s.status || ''}`);
    if (i === 39) throw new Error('처리 시간 초과');
  }
  const p = await api(`${GRAPH}/${IG}/media_publish`, { method: 'POST', body: form({ creation_id: c.id }) });
  return p.id;
}

// 페이스북 페이지 릴스: 시작 → 파일 올리기 → 게시
async function postFacebook(buf, caption) {
  const s = await api(`${GRAPH}/${PAGE}/video_reels`, { method: 'POST', body: form({ upload_phase: 'start' }) });
  await upload(s.upload_url, buf);
  await sleep(5000);
  const f = await api(`${GRAPH}/${PAGE}/video_reels`, {
    method: 'POST',
    body: form({ upload_phase: 'finish', video_id: s.video_id, video_state: 'PUBLISHED', description: caption }),
  });
  return f.post_id || s.video_id;
}

(async () => {
  const today = ymd();
  const dir = path.join(OUT, today);
  const mp4 = path.join(dir, 'reel.mp4'), capFile = path.join(dir, 'caption.txt');
  const doneFile = path.join(dir, 'posted.json');
  log(`=== 게시 시작 (${today})${dry ? ' [점검만]' : ''} ===`);

  if (!fs.existsSync(mp4) || !fs.existsSync(capFile)) {
    log('오늘 만든 영상이 없어 게시하지 않습니다 (옛날 영상은 올리지 않음)');
    process.exit(2);
  }
  const state = fs.existsSync(doneFile) ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : {};
  const buf = fs.readFileSync(mp4), caption = fs.readFileSync(capFile, 'utf8');
  log(`영상 ${(buf.length / 1024 / 1024).toFixed(1)}MB, 게시 문구 ${caption.length}자`);

  const missing = ['META_ACCESS_TOKEN', 'IG_USER_ID', 'FB_PAGE_ID'].filter((n) => !env(n));
  if (missing.length) log('환경변수 없음:', missing.join(', '));
  if (dry) { log('점검 끝. 실제 게시는 하지 않았습니다.'); process.exit(missing.length ? 3 : 0); }
  if (!TOKEN) { log('META_ACCESS_TOKEN이 없어 게시할 수 없습니다 (SETUP.md 참고)'); process.exit(3); }

  const jobs = [
    ['instagram', IG, postInstagram],
    ['facebook', PAGE, postFacebook],
  ];
  let failed = 0;
  for (const [name, id, fn] of jobs) {
    if (state[name]?.ok) { log(`${name}: 이미 게시됨 → 건너뜀`); continue; }   // 재실행해도 중복 게시 안 함
    if (!id) { log(`${name}: 계정 ID가 없어 건너뜀`); failed++; continue; }
    try {
      const postId = await fn(buf, caption);
      state[name] = { ok: true, id: postId, at: new Date().toISOString() };
      log(`${name}: 게시 완료 (${postId})`);
    } catch (e) {
      state[name] = { ok: false, error: e.message, at: new Date().toISOString() };
      log(`${name}: 실패 - ${e.message}`);
      failed++;
    }
    fs.writeFileSync(doneFile, JSON.stringify(state, null, 2), 'utf8');
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { log('오류:', e.message); process.exit(1); });
