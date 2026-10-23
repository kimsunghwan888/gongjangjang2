// 공통 도구: 날짜, 기록, 프로그램 위치 찾기, 인터넷 가져오기
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'output');

function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function log(...a) {
  console.log(`[${new Date().toLocaleString('ko-KR')}]`, ...a);
}

function works(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    return r.status === 0;
  } catch { return false; }
}

// PATH에 없을 때를 대비해 알려진 위치도 찾는다
function findFfmpegDir() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const pkg of fs.readdirSync(base)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pdir = path.join(base, pkg);
      for (const sub of fs.readdirSync(pdir)) {
        const bin = path.join(pdir, sub, 'bin');
        if (fs.existsSync(path.join(bin, 'ffmpeg.exe'))) return bin;
      }
    }
  } catch { /* 없으면 PATH에 의존 */ }
  return null;
}

function bin(name) {
  if (works(name, ['-version'])) return name;
  const dir = findFfmpegDir();
  if (dir && fs.existsSync(path.join(dir, name + '.exe'))) return path.join(dir, name + '.exe');
  throw new Error(`${name} 프로그램을 찾을 수 없습니다`);
}

function chromePath() {
  const list = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const f = list.find((p) => fs.existsSync(p));
  if (!f) throw new Error('크롬 또는 엣지를 찾을 수 없습니다');
  return f;
}

function pythonCmd() {
  if (works('python', ['--version'])) return 'python';
  const p = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe');
  if (fs.existsSync(p)) return p;
  throw new Error('python을 찾을 수 없습니다 (edge-tts 필요)');
}

async function fetchText(url, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw new Error(`가져오기 실패 ${url} : ${last.message}`);
}

function decode(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&middot;/g, '·').replace(/&hellip;/g, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

module.exports = { ROOT, OUT, ymd, log, bin, chromePath, pythonCmd, fetchText, decode };
