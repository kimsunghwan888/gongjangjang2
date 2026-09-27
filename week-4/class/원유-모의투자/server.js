const express = require('express');
const path = require('path');

// .env 를 읽는다 (이미 정해진 환경값이 있으면 그것이 우선). .env 없음 = Vercel
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const START_CASH = 1000;   // 시작 현금 (달러)

const app = express();
const PORT = process.env.PORT || 3000;

// ── 원유 목록 · 시세 출처 ─────────────────────────────
// 시세는 야후 파이낸스의 원유 선물 가격 (파이썬 yfinance 라이브러리가 부르는 것과 같은 주소, 열쇠 없음, 약 15분 늦게 온다)
// Dubai유는 야후에 시세가 없어서 symbol 을 비워 뒀다
const BARREL = '1배럴(약 159리터)';
const OILS = {
  wti:   { name: 'WTI',      symbol: 'CL=F', unit: BARREL },
  brent: { name: '브렌트유', symbol: 'BZ=F', unit: BARREL },
  dubai: { name: 'Dubai유',  symbol: null,   unit: BARREL }
};
const oilOf = (id) => (Object.hasOwn(OILS, id) ? OILS[id] : null);

// 그래프 기간: 야후에서 받을 기간 · 봉 하나의 길이 · 화면에 보여줄 봉 개수
// (이동평균선 60개를 계산할 앞쪽 자료가 필요해서 보여줄 것보다 더 많이 받는다)
const TIMEFRAMES = {
  day:   { range: '1y',  interval: '1d',  show: 120 },   // 일봉: 최근 120일
  week:  { range: '5y',  interval: '1wk', show: 104 },   // 주봉: 최근 2년
  month: { range: '15y', interval: '1mo', show: 84 }     // 월봉: 최근 7년
};
const MA_PERIODS = [5, 20, 60];   // 이동평균선: 최근 5개, 20개, 60개 종가의 평균

// ── 기억 창고(캐시) ───────────────────────────────────
const cache = new Map();
const STALE_MS = 30 * 60 * 1000;   // 야후가 막히면 30분 안에 받은 값을 대신 쓴다

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  try {
    const value = await loader();
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    if (hit && Date.now() - hit.at < STALE_MS) return hit.value;
    throw err;
  }
}

// ── 안내 문구 · 오류 종류 ─────────────────────────────
class UserError extends Error {}

const NEED_SETUP = '저장창고에 표와 함수가 아직 없어요. supabase-setup.sql 을 Supabase 의 SQL Editor 에서 한 번 실행해 주세요.';
const NO_SUPABASE = '저장창고(Supabase) 접속 정보가 없어요. .env 에 SUPABASE_URL 과 SUPABASE_PUBLISHABLE_KEY 를 넣어 주세요.';
const NO_PRICE = '지금 원유 시세를 가져오지 못했어요. 잠시 후 다시 해 주세요.';

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

// ── 야후 파이낸스에서 시세 받기 ───────────────────────
function symbolOf(id) {
  if (!OILS[id].symbol) throw new UserError(`야후 파이낸스에는 ${OILS[id].name} 시세가 없어서 아직 지원하지 못해요.`);
  return OILS[id].symbol;
}

async function yahooChart(symbol, range, interval) {
  let lastErr;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
        { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = (await res.json())?.chart?.result?.[0];
      if (!result?.timestamp) throw new Error('시세 없음');
      return result;
    } catch (err) {
      lastErr = err;
    }
  }
  console.error('야후 시세 오류', symbol, lastErr?.message);
  throw new Error(NO_PRICE);
}

// 야후 답을 "날짜+시가·고가·저가·종가 목록(bars)"과 "지금 가격"으로 정리한다
function readChart(r) {
  const dateOf = new Intl.DateTimeFormat('en-CA', { timeZone: r.meta.exchangeTimezoneName || 'America/New_York' });
  const q = r.indicators.quote[0];
  const bars = [];
  r.timestamp.forEach((t, i) => {
    const [open, high, low, close] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if ([open, high, low, close].some((v) => v == null)) return;   // 값이 빈 봉
    if (q.volume[i] === 0) return;                                  // 거래가 없던 날(휴장) 봉
    // 계약이 바뀌는 날엔 야후가 시가를 고가보다 높게 줄 때가 있어서, 고가·저가가 네 값을 모두 품도록 바로잡는다
    bars.push({
      date: dateOf.format(new Date(t * 1000)),
      open: round2(open),
      high: round2(Math.max(open, high, low, close)),
      low: round2(Math.min(open, high, low, close)),
      close: round2(close)
    });
  });
  if (!bars.length) throw new Error(NO_PRICE);
  const price = round2(r.meta.regularMarketPrice ?? bars.at(-1).close);
  const asOf = new Date((r.meta.regularMarketTime || r.timestamp.at(-1)) * 1000);
  return { bars, price, asOf, priceDate: dateOf.format(asOf) };
}

// 지금 가격 (20초 기억). 어제 마감가와 비교한 등락도 함께
const getQuote = (id) => cached(`quote:${id}`, 20 * 1000, async () => {
  const { bars, price, asOf, priceDate } = readChart(await yahooChart(symbolOf(id), '5d', '1d'));
  // 마지막 봉이 오늘 것이면 그 앞 봉이 어제 마감, 아직 오늘 봉이 없으면 마지막 봉이 어제 마감
  const prevClose = (bars.at(-1).date === priceDate ? bars.at(-2) : bars.at(-1))?.close ?? null;
  const change = prevClose == null ? null : round2(price - prevClose);
  const changePct = prevClose ? round2((change / prevClose) * 100) : null;
  return { id, name: OILS[id].name, unit: OILS[id].unit, price, prevClose, change, changePct, asOf: asOf.toISOString() };
});

// 같은 주(달)인지 알아보는 표: 주봉은 그 주 월요일, 월봉은 "2026-09"
function periodOf(date, tf) {
  if (tf === 'month') return date.slice(0, 7);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// 봉마다 이동평균선 값(ma5, ma20, ma60)을 붙인다. 앞쪽 자료가 모자란 봉은 null
function withAverages(bars) {
  return bars.map((bar, i) => {
    const row = { ...bar };
    for (const p of MA_PERIODS) {
      row[`ma${p}`] = i + 1 < p ? null : round2(bars.slice(i + 1 - p, i + 1).reduce((sum, b) => sum + b.close, 0) / p);
    }
    return row;
  });
}

// 일봉·주봉·월봉 캔들 + 이동평균선 자료 (10분 기억)
const getSeries = (id, tf) => cached(`series:${id}:${tf}`, 10 * 60 * 1000, async () => {
  const { range, interval, show } = TIMEFRAMES[tf];
  const { bars } = readChart(await yahooChart(symbolOf(id), range, interval));
  // 야후는 이번 주(달) 봉을 "주(달) 첫날 것"과 "오늘 것" 두 줄로 줄 때가 있다 → 한 봉으로 합친다
  const n = bars.length;
  if (tf !== 'day' && n >= 2 && periodOf(bars[n - 1].date, tf) === periodOf(bars[n - 2].date, tf)) {
    const [first, latest] = bars.splice(n - 2, 2);
    bars.push({
      date: first.date,
      open: first.open,
      high: Math.max(first.high, latest.close),
      low: Math.min(first.low, latest.close),
      close: latest.close
    });
  }
  return withAverages(bars).slice(-show);
});

// ── 저장창고(Supabase) 부르기 ─────────────────────────
// 표를 직접 만지지 않고, supabase-setup.sql 로 만든 함수(oil_...)만 부른다
async function rpc(name, args = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error(NO_SUPABASE);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error('저장창고(Supabase)에 연결하지 못했어요. 잠시 후 다시 해 주세요.');
  }
  const body = await res.json().catch(() => null);
  if (res.ok) return body;

  if (body?.code === 'P0001') throw new UserError(body.message);   // 함수가 일부러 낸 안내 (돈이 모자라요 등)
  console.error('Supabase 오류', res.status, body);
  if (res.status === 401 || res.status === 403 || ['PGRST202', 'PGRST205', '42501', '42883'].includes(body?.code)) throw new Error(NEED_SETUP);
  throw new Error(`저장창고(Supabase)가 요청을 받아주지 않았어요. (${res.status})`);
}

function sendError(res, err, fallback) {
  if (err instanceof UserError) return res.status(400).json({ success: false, message: err.message });
  console.error(fallback, err.message);
  res.status(500).json({ success: false, message: err.message || fallback });
}

// 지갑 = 저장창고의 현금·원유 수량 + 지금 가격으로 계산한 평가액·수익률
async function buildWallet(raw) {
  const held = Object.entries(raw.holdings || {}).filter(([id, qty]) => oilOf(id) && qty > 0);
  const positions = await Promise.all(held.map(async ([id, qty]) => {
    const q = await getQuote(id);
    return { market: id, name: q.name, unit: q.unit, qty, price: q.price, value: round2(q.price * qty) };
  }));
  const cash = Number(raw.cash);
  const holdingsValue = positions.reduce((sum, p) => sum + p.price * p.qty, 0);
  const totalAsset = cash + holdingsValue;
  return {
    cash: round2(cash),
    holdings: raw.holdings || {},
    positions,
    holdingsValue: round2(holdingsValue),
    totalAsset: round2(totalAsset),
    startCash: START_CASH,
    profit: round2(totalAsset - START_CASH),
    profitRate: round4((totalAsset - START_CASH) / START_CASH)   // (현금 + 원유 평가액 - 1000) / 1000, 0.05 = +5%
  };
}

const toOrder = (o) => ({
  id: o.id,
  time: o.created_at,
  market: o.market,
  name: oilOf(o.market)?.name || o.market,
  side: o.side,
  qty: o.qty,
  price: Number(o.price),
  amount: Number(o.amount),
  memo: o.memo || ''
});

// ── Middleware ───────────────────────────────────────
app.use(express.json({ limit: '10kb' }));

// ── API: 조회 (GET) ──────────────────────────────────
// 원유 하나의 현재가와 어제보다 등락
app.get('/api/price', async (req, res) => {
  if (!oilOf(req.query.oil)) return res.status(400).json({ success: false, message: '원유 이름이 올바르지 않아요.' });
  try {
    res.json({ success: true, data: await getQuote(req.query.oil) });
  } catch (err) {
    sendError(res, err, '현재가를 가져오지 못했어요.');
  }
});

// 원유 하나의 일봉·주봉·월봉 캔들 + 이동평균선 자료
app.get('/api/chart', async (req, res) => {
  const { oil, tf } = req.query;
  if (!oilOf(oil)) return res.status(400).json({ success: false, message: '원유 이름이 올바르지 않아요.' });
  if (!Object.hasOwn(TIMEFRAMES, tf)) return res.status(400).json({ success: false, message: 'tf 는 day, week, month 중 하나예요.' });
  try {
    res.json({ success: true, data: { id: oil, tf, maPeriods: MA_PERIODS, candles: await getSeries(oil, tf) } });
  } catch (err) {
    sendError(res, err, '그래프 자료를 가져오지 못했어요.');
  }
});

// 내 지갑: 현금 + 원유 평가액 + 수익률 (현금 + 원유 평가액 - 1000) / 1000
app.get('/api/wallet', async (_req, res) => {
  try {
    res.json({ success: true, data: await buildWallet(await rpc('oil_get_wallet')) });
  } catch (err) {
    sendError(res, err, '지갑을 불러오지 못했어요.');
  }
});

// 주문 내역 (새 것부터)
app.get('/api/orders', async (_req, res) => {
  try {
    const rows = await rpc('oil_list_orders', { p_limit: 50 });
    res.json({ success: true, data: rows.map(toOrder) });
  } catch (err) {
    sendError(res, err, '주문 내역을 불러오지 못했어요.');
  }
});

// ── API: 매매 (POST) ─────────────────────────────────
// 현재가로 체결 → 지갑 갱신 → 주문 한 줄 기록. 돈이나 원유가 모자라면 거절(400)
app.post('/api/order', async (req, res) => {
  const { market, side, qty, memo } = req.body || {};
  if (!oilOf(market)) return res.status(400).json({ success: false, message: '원유 이름이 올바르지 않아요.' });
  if (!['buy', 'sell'].includes(side)) return res.status(400).json({ success: false, message: '사기(buy)나 팔기(sell) 중 하나를 골라 주세요.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 100000) return res.status(400).json({ success: false, message: '수량은 1 이상의 정수로 넣어 주세요.' });
  if (memo != null && typeof memo !== 'string') return res.status(400).json({ success: false, message: '메모는 글자로 넣어 주세요.' });

  try {
    // 가격은 화면이 보낸 값을 믿지 않고 서버가 직접 받은 현재가를 쓴다
    const { price } = await getQuote(market);
    const { order, wallet } = await rpc('oil_place_order', {
      p_market: market, p_side: side, p_qty: qty, p_price: price, p_memo: (memo || '').trim().slice(0, 200)
    });
    res.status(201).json({ success: true, data: { order: toOrder(order), wallet: await buildWallet(wallet) } });
  } catch (err) {
    sendError(res, err, '주문을 처리하지 못했어요.');
  }
});

app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '없는 주소예요.' });
});

// ── 화면 (index.html 만 내보낸다: server.js 나 .sql 이 인터넷에 보이지 않게) ──
app.get('/{*splat}', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error Handler ────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.status === 400) return res.status(400).json({ success: false, message: '보낸 내용의 모양이 올바르지 않아요.' });
  console.error('Server error:', err);
  res.status(500).json({ success: false, message: '서버 오류' });
});

// ── Startup ──────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🛢️ 6번 원유 모의투자 앱 서버 시작`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🗄️  저장창고(Supabase): ${SUPABASE_URL && SUPABASE_KEY ? '접속 정보 있음' : '접속 정보 없음 (.env 확인)'}\n`);
  });
}

module.exports = app;
