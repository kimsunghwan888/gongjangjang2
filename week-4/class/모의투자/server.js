// ── Module imports ───────────────────────────
const express = require('express');
const path = require('path');
const { Pool, types } = require('pg');

// ── App init & config ────────────────────────
// 내 컴퓨터에선 .env 를 읽고, Vercel 에선 설정값(환경변수)을 그대로 쓴다
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없음 = Vercel */ }

const app = express();
const PORT = process.env.PORT || 3000;

// NUMERIC 칸은 글자가 아니라 숫자로 받는다
types.setTypeParser(1700, (value) => parseFloat(value));

const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || '').trim(),
  ssl: { rejectUnauthorized: false },
  max: 3,
});

// ── 기본 설정 ─────────────────────────────────
const START_CASH = 1000000;   // 시작 현금 100만원
const FEE_RATE = 0.0005;      // 수수료 0.05% (업비트 원화 마켓과 같은 수준)
const OWNER = 'me';           // 혼자 쓰는 앱이라 지갑은 한 개

// 공용 DB 라 남의 표와 겹치지 않게 이름 앞에 mockinvest_ 를 붙인다
const WALLET_TABLE = 'mockinvest_wallet';
const ORDERS_TABLE = 'mockinvest_orders';

// 다룰 코인 목록 (업비트 원화 마켓)
const COINS = [
  { market: 'KRW-BTC', name: '비트코인', symbol: 'BTC', emoji: '🟠' },
  { market: 'KRW-ETH', name: '이더리움', symbol: 'ETH', emoji: '🔷' },
  { market: 'KRW-XRP', name: '리플', symbol: 'XRP', emoji: '💧' },
];
const COIN_MAP = Object.fromEntries(COINS.map((c) => [c.market, c]));
const ALL_MARKETS = COINS.map((c) => c.market);

// ── 업비트 시세 (열쇠 없이 쓰는 공개 API) ──────
const UPBIT_TICKER_URL = 'https://api.upbit.com/v1/ticker';
const PRICE_CACHE_MS = 2000;  // 2초 동안은 받아둔 값을 다시 쓴다 (업비트 호출 제한 보호)
let priceCache = { at: 0, data: null };

async function fetchPrices() {
  if (priceCache.data && Date.now() - priceCache.at < PRICE_CACHE_MS) return priceCache.data;

  let res;
  try {
    res = await fetch(`${UPBIT_TICKER_URL}?markets=${ALL_MARKETS.join(',')}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new UpstreamError('업비트에 연결하지 못했어요. 잠시 후 다시 해 주세요.');
  }
  if (!res.ok) throw new UpstreamError(`업비트가 시세를 주지 않았어요. (${res.status})`);

  const list = await res.json();
  const data = Object.fromEntries(list.map((t) => [t.market, {
    market: t.market,
    name: COIN_MAP[t.market]?.name || t.market,
    symbol: COIN_MAP[t.market]?.symbol || t.market.replace('KRW-', ''),
    emoji: COIN_MAP[t.market]?.emoji || '🟡',
    price: t.trade_price,
    prevClose: t.prev_closing_price,
    changePrice: t.signed_change_price,
    changeRate: t.signed_change_rate * 100,   // % 로 바꿔서 준다
    high: t.high_price,
    low: t.low_price,
    volume: t.acc_trade_price_24h,            // 24시간 거래대금
    at: new Date(t.timestamp).toISOString(),
  }]));

  priceCache = { at: Date.now(), data };
  return data;
}


// ── 그래프 자료 (업비트 캔들) ──────────────────
// 1분봉 · 주봉 · 월봉 세 가지를 받아 온다
const UPBIT_CANDLE_URL = 'https://api.upbit.com/v1/candles';
const CHART_KINDS = {
  // path: 업비트 주소 / count: 몇 개 / cacheMs: 얼마나 기억해 둘지 / label: 화면에 쓸 이름
  minutes: { path: 'minutes/1', count: 60,  cacheMs: 30 * 1000,      label: '1분봉' },
  weeks:   { path: 'weeks',     count: 200, cacheMs: 10 * 60 * 1000, label: '주봉' },
  months:  { path: 'months',    count: 200, cacheMs: 60 * 60 * 1000, label: '월봉' },
};
const chartCache = new Map();   // 'KRW-BTC:weeks' → { at, data }

async function fetchChart(market, kind) {
  const spec = CHART_KINDS[kind];
  const key = `${market}:${kind}`;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < spec.cacheMs) return hit.data;

  let res;
  try {
    res = await fetch(`${UPBIT_CANDLE_URL}/${spec.path}?market=${market}&count=${spec.count}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(7000),
    });
  } catch {
    throw new UpstreamError('업비트에서 그래프 자료를 받지 못했어요. 잠시 후 다시 해 주세요.');
  }
  if (!res.ok) throw new UpstreamError(`업비트가 그래프 자료를 주지 않았어요. (${res.status})`);

  const list = await res.json();
  // 업비트는 최신이 맨 앞에 오므로 뒤집어서 "오래된 것 → 최신" 순서로 준다
  const data = list.reverse().map((c) => ({ t: c.candle_date_time_kst, price: c.trade_price }));
  chartCache.set(key, { at: Date.now(), data });
  return data;
}

// 코인 전체의 1분봉 가격만 뽑아 준다 (목록의 작은 그래프용)
async function fetchAllMinutePrices() {
  const pairs = await Promise.all(ALL_MARKETS.map(async (market) => {
    try {
      return [market, (await fetchChart(market, 'minutes')).map((c) => c.price)];
    } catch {
      return [market, []];   // 한 코인이 실패해도 나머지는 그린다
    }
  }));
  return Object.fromEntries(pairs);
}

// 업비트(바깥 서비스) 때문에 생긴 문제는 502 로 알려 준다
class UpstreamError extends Error {
  constructor(message) { super(message); this.status = 502; }
}

// ── DB lazy init ─────────────────────────────
// 서버리스는 켜질 때마다 불릴 수 있어서 약속(Promise)을 한 번만 만든다
let initPromise = null;

async function initDB() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${WALLET_TABLE} (
      id         SERIAL PRIMARY KEY,
      owner      TEXT UNIQUE NOT NULL,
      cash       NUMERIC(20,4) NOT NULL DEFAULT ${START_CASH},
      holdings   JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${ORDERS_TABLE} (
      id         SERIAL PRIMARY KEY,
      owner      TEXT NOT NULL,
      market     TEXT NOT NULL,
      side       TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      qty        NUMERIC(24,8) NOT NULL,
      price      NUMERIC(20,4) NOT NULL,
      amount     NUMERIC(20,4) NOT NULL,
      fee        NUMERIC(20,4) NOT NULL DEFAULT 0,
      memo       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${ORDERS_TABLE}_owner_time ON ${ORDERS_TABLE} (owner, created_at DESC)`);
  // 지갑이 없으면 100만원으로 하나 만든다
  await pool.query(
    `INSERT INTO ${WALLET_TABLE} (owner, cash, holdings) VALUES ($1, $2, '{}') ON CONFLICT (owner) DO NOTHING`,
    [OWNER, START_CASH]
  );
}

function ensureDB() {
  if (!initPromise) initPromise = initDB().catch((err) => { initPromise = null; throw err; });
  return initPromise;
}

// ── 지갑 계산 도우미 ──────────────────────────
// 보유 코인 + 지금 시세로 평가금액·수익률을 계산한다
function evaluateWallet(row, prices) {
  const holdings = Object.entries(row.holdings || {}).map(([market, held]) => {
    const coin = COIN_MAP[market];
    const tick = prices[market];
    const price = tick ? tick.price : held.avgPrice;
    const value = held.qty * price;
    const cost = held.qty * held.avgPrice;
    return {
      market,
      name: coin?.name || market,
      symbol: coin?.symbol || market.replace('KRW-', ''),
      emoji: coin?.emoji || '🟡',
      qty: held.qty,
      avgPrice: held.avgPrice,
      price,
      value,
      cost,
      profit: value - cost,
      profitRate: cost > 0 ? ((value - cost) / cost) * 100 : 0,
    };
  }).sort((a, b) => b.value - a.value);

  const coinValue = holdings.reduce((sum, h) => sum + h.value, 0);
  const total = row.cash + coinValue;
  return {
    startCash: START_CASH,
    cash: row.cash,
    coinValue,
    total,
    profit: total - START_CASH,
    // (현금 + 코인 평가액 − 100만) ÷ 100만
    profitRate: ((total - START_CASH) / START_CASH) * 100,
    holdings,
    updatedAt: row.updated_at,
  };
}

const toOrder = (r) => ({
  id: r.id, market: r.market, name: COIN_MAP[r.market]?.name || r.market,
  emoji: COIN_MAP[r.market]?.emoji || '🟡', side: r.side,
  qty: r.qty, price: r.price, amount: r.amount, fee: r.fee,
  memo: r.memo || '', createdAt: r.created_at,
});

// ── 입력값 검사 도우미 ────────────────────────
const isPositiveNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const badRequest = (res, message) => res.status(400).json({ success: false, message });

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));

// API 는 DB 준비가 끝난 뒤에 처리한다
app.use('/api', async (_req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err.message);
    res.status(500).json({ success: false, message: 'DB에 연결하지 못했어요. 잠시 후 다시 해 주세요.' });
  }
});

// ── API: 상태 확인 ────────────────────────────
app.get('/api/health', async (_req, res) => {
  const { rows } = await pool.query('SELECT now() AS time');
  res.json({ success: true, data: { db: 'ok', time: rows[0].time } });
});

// ── API: 시세 (업비트 공개 API) ────────────────
// 다룰 수 있는 코인 전체 시세
app.get('/api/markets', async (_req, res) => {
  const prices = await fetchPrices();
  res.json({ success: true, data: ALL_MARKETS.map((m) => prices[m]).filter(Boolean) });
});

// 코인 하나의 현재가: /api/price?market=KRW-BTC
app.get('/api/price', async (req, res) => {
  const market = String(req.query.market || '').toUpperCase();
  if (!COIN_MAP[market]) {
    return badRequest(res, `다룰 수 없는 코인이에요. 가능한 코인: ${ALL_MARKETS.join(', ')}`);
  }
  const prices = await fetchPrices();
  const tick = prices[market];
  if (!tick) throw new UpstreamError('업비트가 그 코인 시세를 주지 않았어요.');
  res.json({ success: true, data: tick });
});


// 코인별 최근 60분 가격 (목록의 작은 그래프용)
app.get('/api/candles', async (_req, res) => {
  res.json({ success: true, data: await fetchAllMinutePrices() });
});

// 코인 하나의 그래프 자료: /api/chart?market=KRW-BTC&kind=minutes|weeks|months
app.get('/api/chart', async (req, res) => {
  const market = String(req.query.market || '').toUpperCase();
  const kind = String(req.query.kind || 'minutes');
  if (!COIN_MAP[market]) {
    return badRequest(res, `다룰 수 없는 코인이에요. 가능한 코인: ${ALL_MARKETS.join(', ')}`);
  }
  if (!CHART_KINDS[kind]) {
    return badRequest(res, `그래프 종류는 ${Object.keys(CHART_KINDS).join(', ')} 중에서 골라 주세요.`);
  }
  const candles = await fetchChart(market, kind);
  res.json({ success: true, data: { market, kind, label: CHART_KINDS[kind].label, candles } });
});

// ── API: 내 지갑 ──────────────────────────────
app.get('/api/wallet', async (_req, res) => {
  const [{ rows }, prices] = await Promise.all([
    pool.query(`SELECT * FROM ${WALLET_TABLE} WHERE owner = $1`, [OWNER]),
    fetchPrices(),
  ]);
  res.json({ success: true, data: evaluateWallet(rows[0], prices) });
});

// 처음부터 다시 (현금 100만원, 코인·주문내역 지움)
app.post('/api/wallet/reset', async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ${ORDERS_TABLE} WHERE owner = $1`, [OWNER]);
    const { rows } = await client.query(
      `UPDATE ${WALLET_TABLE} SET cash = $2, holdings = '{}', updated_at = now() WHERE owner = $1 RETURNING *`,
      [OWNER, START_CASH]
    );
    await client.query('COMMIT');
    res.json({ success: true, data: evaluateWallet(rows[0], {}) });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// ── API: 주문 내역 ────────────────────────────
app.get('/api/orders', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT * FROM ${ORDERS_TABLE} WHERE owner = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [OWNER, limit]
  );
  res.json({ success: true, data: rows.map(toOrder) });
});

// ── API: 매수 · 매도 ──────────────────────────
// body: { market, side: 'buy'|'sell', qty } 또는 살 때는 { market, side:'buy', amount }
app.post('/api/order', async (req, res) => {
  const { market: rawMarket, side, qty, amount, memo } = req.body || {};
  const market = String(rawMarket || '').toUpperCase();

  if (!COIN_MAP[market]) return badRequest(res, `다룰 수 없는 코인이에요. 가능한 코인: ${ALL_MARKETS.join(', ')}`);
  if (side !== 'buy' && side !== 'sell') return badRequest(res, "사기는 'buy', 팔기는 'sell' 로 보내 주세요.");
  if (qty !== undefined && !isPositiveNumber(qty)) return badRequest(res, '수량은 0보다 큰 숫자여야 해요.');
  if (amount !== undefined && !isPositiveNumber(amount)) return badRequest(res, '금액은 0보다 큰 숫자여야 해요.');
  if (side === 'buy' && qty === undefined && amount === undefined) return badRequest(res, '살 금액(amount)이나 수량(qty)을 보내 주세요.');
  if (side === 'sell' && qty === undefined) return badRequest(res, '팔 수량(qty)을 보내 주세요.');
  if (memo !== undefined && (typeof memo !== 'string' || memo.length > 100)) return badRequest(res, '메모는 100글자까지 적을 수 있어요.');

  // 체결가는 업비트 현재가 (DB 를 건드리기 전에 먼저 받아 둔다)
  const prices = await fetchPrices();
  const price = prices[market]?.price;
  if (!isPositiveNumber(price)) throw new UpstreamError('지금은 시세를 받지 못해 주문할 수 없어요.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 같은 순간에 두 번 주문해도 꼬이지 않게 지갑 줄을 잠근다
    const { rows: walletRows } = await client.query(
      `SELECT * FROM ${WALLET_TABLE} WHERE owner = $1 FOR UPDATE`, [OWNER]
    );
    const wallet = walletRows[0];
    const holdings = { ...(wallet.holdings || {}) };
    const held = holdings[market] || { qty: 0, avgPrice: 0 };

    let orderQty = qty;
    if (side === 'buy' && orderQty === undefined) orderQty = amount / price;  // 금액으로 살 때
    let orderAmount = orderQty * price;
    let fee = orderAmount * FEE_RATE;
    let newCash;

    if (side === 'buy') {
      if (orderAmount < 1000) { await client.query('ROLLBACK'); return badRequest(res, '1,000원 이상부터 살 수 있어요.'); }
      if (orderAmount + fee > wallet.cash + 1e-6) {
        await client.query('ROLLBACK');
        return badRequest(res, `현금이 모자라요. 쓸 수 있는 돈은 ${Math.floor(wallet.cash).toLocaleString('ko-KR')}원이에요.`);
      }
      newCash = wallet.cash - orderAmount - fee;
      const totalQty = held.qty + orderQty;
      holdings[market] = {
        qty: totalQty,
        // 평균 매입가 = 전체 산 돈 ÷ 전체 개수
        avgPrice: (held.qty * held.avgPrice + orderQty * price) / totalQty,
      };
    } else {
      if (orderQty > held.qty + 1e-8) {
        await client.query('ROLLBACK');
        // 소수점 8자리까지만 (뒤에 붙는 0은 지움)
        return badRequest(res, `가진 수량이 모자라요. 지금 가진 개수는 ${Number(held.qty.toFixed(8))}개예요.`);
      }
      const sellQty = Math.min(orderQty, held.qty);
      orderAmount = sellQty * price;
      fee = orderAmount * FEE_RATE;
      orderQty = sellQty;
      newCash = wallet.cash + orderAmount - fee;
      const leftQty = held.qty - sellQty;
      if (leftQty <= 1e-8) delete holdings[market];
      else holdings[market] = { ...held, qty: leftQty };
    }

    const { rows: orderRows } = await client.query(
      `INSERT INTO ${ORDERS_TABLE} (owner, market, side, qty, price, amount, fee, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [OWNER, market, side, orderQty, price, orderAmount, fee, memo || null]
    );
    const { rows: updatedRows } = await client.query(
      `UPDATE ${WALLET_TABLE} SET cash = $2, holdings = $3, updated_at = now() WHERE owner = $1 RETURNING *`,
      [OWNER, newCash, JSON.stringify(holdings)]
    );
    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: { order: toOrder(orderRows[0]), wallet: evaluateWallet(updatedRows[0], prices) },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
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
  if (err.status === 502) return res.status(502).json({ success: false, message: err.message });
  console.error(err);
  res.status(500).json({ success: false, message: '서버에 문제가 생겼어요. 잠시 후 다시 해 주세요.' });
});

// ── Startup & export ─────────────────────────
// 내 컴퓨터: 서버 켜기 / Vercel: app 을 내보내기만
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
module.exports = app;
