// ============================================================
// 날씨앱 서버 — API 키를 숨겨 주는 중계(中繼) 서버
//
// 하는 일: 브라우저 화면 대신 이 서버가 OpenWeatherMap 에 날씨를 물어본다.
//          키는 .env 파일에만 있고 브라우저로는 절대 나가지 않는다.
//
// 실행 방법: 이 폴더에서  node server.js
// 설치할 것 없음 (Node.js 에 기본으로 들어있는 기능만 사용)
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------
// ⚙️ 설정 읽기
// ------------------------------------------------------------

// .env 파일을 한 줄씩 읽어 KEY=값 형태를 꺼낸다
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return {};

  const result = {};
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text || text.startsWith('#')) return;

    const eq = text.indexOf('=');
    if (eq === -1) return;

    // 값에 따옴표가 붙어 있으면 벗겨 준다
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  });
  return result;
}

const env = { ...loadEnvFile(), ...process.env };
const API_KEY = env.OPENWEATHER_API_KEY || '';
const PORT = Number(env.PORT) || 3000;

const OWM_BASE = 'https://api.openweathermap.org/data/2.5';
const CACHE_MS = 10 * 60 * 1000; // 같은 도시는 10분 동안 다시 물어보지 않는다

// 조회를 허용하는 도시 목록.
// 여기 적힌 도시만 조회되므로, 다른 사람이 이 서버로 아무 요청이나 보낼 수 없다.
const CITIES = {
  '서울': { lat: 37.5665, lon: 126.9780 },
  '부산': { lat: 35.1796, lon: 129.0756 },
  '대구': { lat: 35.8714, lon: 128.6014 },
  '인천': { lat: 37.4563, lon: 126.7052 },
  '광주': { lat: 35.1595, lon: 126.8526 },
  '제주': { lat: 33.4996, lon: 126.5312 },
};

// ------------------------------------------------------------
// 📡 OpenWeatherMap 호출
// ------------------------------------------------------------

const cache = new Map(); // 도시 이름 -> { at, data }

async function callOwm(kind, city) {
  const url = `${OWM_BASE}/${kind}?lat=${city.lat}&lon=${city.lon}&appid=${API_KEY}&units=metric`;
  const res = await fetch(url);

  if (!res.ok) {
    const error = new Error(`OpenWeatherMap ${kind} 요청 실패`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

// 날씨 서버가 보낸 오류를 사람이 읽을 수 있는 안내로 바꾼다.
// (키가 섞여 나갈 수 있으므로 원본 오류 문구는 그대로 전달하지 않는다)
function describeUpstream(status) {
  if (status === 401) return 'API 키가 아직 활성화되지 않았거나 올바르지 않습니다.';
  if (status === 429) return '무료 사용량을 넘었습니다. 잠시 뒤에 다시 시도해 주세요.';
  if (status === 404) return '요청한 지역의 날씨를 찾지 못했습니다.';
  return '날씨 서버가 응답하지 않습니다.';
}

// ------------------------------------------------------------
// 🧰 응답 도우미
// ------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendIndex(res) {
  fs.readFile(path.join(__dirname, 'index.html'), (err, buffer) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 파일을 찾지 못했습니다.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buffer);
  });
}

// ------------------------------------------------------------
// 🌤️ /api/weather — 화면이 부르는 유일한 주소
// ------------------------------------------------------------

async function handleWeather(res, query) {
  const name = query.get('city');
  const city = CITIES[name];

  if (!city) {
    sendJson(res, 400, { error: 'unknown_city', message: '조회할 수 없는 도시입니다.' });
    return;
  }

  if (!API_KEY) {
    sendJson(res, 500, {
      error: 'no_key',
      message: '서버에 API 키가 없습니다. .env 파일에 OPENWEATHER_API_KEY 를 적어 주세요.',
    });
    return;
  }

  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_MS) {
    sendJson(res, 200, { ...cached.data, cached: true });
    return;
  }

  try {
    const [current, forecast, air] = await Promise.all([
      callOwm('weather', city),
      callOwm('forecast', city),
      // 대기질은 실패해도 나머지는 그대로 보여 준다
      callOwm('air_pollution', city).catch(() => null),
    ]);

    const data = { city: name, current, forecast, air };
    cache.set(name, { at: Date.now(), data });
    sendJson(res, 200, { ...data, cached: false });
  } catch (error) {
    const status = error.status || 502;
    console.error(`[날씨 조회 실패] ${name} — 상태 ${status}`);
    sendJson(res, status, { error: 'upstream', status, message: describeUpstream(status) });
  }
}

// ------------------------------------------------------------
// 🚀 서버 시작
// ------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed', message: '허용되지 않는 방식입니다.' });
    return;
  }

  if (url.pathname === '/api/weather') {
    handleWeather(res, url.searchParams);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendIndex(res);
    return;
  }

  // 그 밖의 주소는 열어 주지 않는다 (폴더 안의 다른 파일 보호)
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('없는 주소입니다.');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ ${PORT}번 문(포트)을 다른 프로그램이 이미 쓰고 있습니다.`);
    console.error(`   그 프로그램을 끄거나, .env 파일에 PORT=3001 처럼 다른 번호를 적어 주세요.\n`);
  } else {
    console.error('\n❌ 서버를 시작하지 못했습니다:', error.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('\n🌤️  날씨앱 서버가 켜졌습니다.');
  console.log(`   브라우저에서 열기 →  http://localhost:${PORT}`);
  console.log(`   끄기 →  이 창에서 Ctrl + C`);

  if (!API_KEY) {
    console.log('\n⚠️  아직 API 키가 없습니다.');
    console.log('   이 폴더의 .env 파일에  OPENWEATHER_API_KEY=발급받은키  를 적어 주세요.');
  } else {
    console.log(`\n🔑 API 키를 불러왔습니다. (뒤 4자리: ****${API_KEY.slice(-4)})`);
    console.log('   키는 이 서버 안에만 있고 브라우저로 나가지 않습니다.');
  }
  console.log('');
});
