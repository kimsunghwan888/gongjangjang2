const express = require('express');
const path = require('path');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 없음 = Vercel */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
const START_CASH = 1000;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

class UserError extends Error {}

// ── 저장창고(Supabase) 부르기 ────────────────────────
// 표를 직접 만지지 않고, supabase-setup.sql 로 만든 함수(usinvest_...)만 부른다
async function rpc(name, args = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('저장창고(Supabase) 접속 정보가 없어요. .env 에 SUPABASE_URL 과 SUPABASE_PUBLISHABLE_KEY 를 넣어 주세요.');
  }
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

  if (body?.code === 'P0001') throw new UserError(body.message);   // 함수가 일부러 낸 안내 (잔액이 모자라요 등)
  console.error('Supabase 오류', res.status, body);
  if (body?.code === 'PGRST202' || body?.code === 'PGRST205') {
    throw new Error('저장창고에 표와 함수가 아직 없어요. supabase-setup.sql 을 Supabase 의 SQL Editor 에서 한 번 실행해 주세요.');
  }
  throw new Error(`저장창고(Supabase)가 요청을 받아주지 않았어요. (${res.status})`);
}

const round2 = (n) => Math.round(n * 100) / 100;

function sendError(res, err, fallback) {
  if (err instanceof UserError) return res.status(400).json({ success: false, message: err.message });
  console.error(fallback, err.message);
  res.status(500).json({ success: false, message: err.message || fallback });
}

const STOCKS = {
  'TSLA': { name: '테슬라', base: 250 },
  'GOOGL': { name: '구글', base: 140 },
  'AAPL': { name: '애플', base: 190 },
  'AMZN': { name: '아마존', base: 170 }
};

// ── Helper: Get Stock Price (Alpaca or Demo) ────────
async function getStockPrice(symbol) {
  // Alpaca API 키가 있으면 호출 시도
  if (process.env.ALPACA_API_KEY) {
    try {
      const response = await fetch(
        `https://api.alpaca.markets/v2/assets/${symbol}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.ALPACA_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      // Alpaca /v2/assets는 기본 주식 정보만 반환
      // 실제 현재가는 market data API 필요 (유료 subscription)
      // 이를 위해 demo 모드에서는 기본가격 사용
      if (response.ok) {
        const data = await response.json();
        // Alpaca 연결 성공: demo price 반환
      }
    } catch (err) {
      console.error(`Alpaca API 오류 (${symbol}):`, err.message);
    }
  }

  // Demo 모드: 변동성 있는 기본 가격
  const basePrice = STOCKS[symbol]?.base || 100;
  const variation = (Math.random() - 0.5) * 0.1; // ±5%
  return Math.round(basePrice * (1 + variation) * 100) / 100;
}

// ── Generate Chart Data (Demo) ───────────────────────
function generateChartData(symbol, timeframe) {
  const basePrice = STOCKS[symbol]?.base || 100;
  const data = [];

  let points = 0;
  switch (timeframe) {
    case '1m': points = 60; break;   // 60분
    case '1d': points = 24; break;   // 24시간
    case '1w': points = 7; break;    // 7일
    case '1mo': points = 30; break;  // 30일
  }

  for (let i = 0; i < points; i++) {
    const variation = (Math.random() - 0.5) * 0.15;
    data.push(Math.round(basePrice * (1 + variation) * 100) / 100);
  }

  return {
    labels: Array.from({ length: points }, (_, i) => `${i}`),
    values: data
  };
}

// ── API: Get Price ──────────────────────────────────
app.get('/api/price', async (req, res) => {
  const { symbol } = req.query;

  if (!symbol || !STOCKS[symbol]) {
    return res.status(400).json({ success: false, message: '유효하지 않은 종목' });
  }

  try {
    const price = await getStockPrice(symbol);
    res.json({
      success: true,
      data: {
        symbol,
        name: STOCKS[symbol].name,
        price
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: '가격 조회 실패' });
  }
});

// ── API: Get Wallet ─────────────────────────────────
app.get('/api/wallet', async (req, res) => {
  try {
    const wallet = await rpc('usinvest_get_wallet');
    let totalValue = 0;

    for (const [symbol, quantity] of Object.entries(wallet.holdings)) {
      if (quantity > 0) {
        const price = await getStockPrice(symbol);
        totalValue += price * quantity;
      }
    }

    const totalAsset = wallet.cash + totalValue;
    const profitRate = ((totalAsset - START_CASH) / START_CASH) * 100;

    res.json({
      success: true,
      data: {
        cash: round2(wallet.cash),
        holdings: wallet.holdings,
        totalValue: round2(totalValue),
        totalAsset: round2(totalAsset),
        profitRate: round2(profitRate)
      }
    });
  } catch (err) {
    sendError(res, err, '지갑 조회 실패');
  }
});

// ── API: Get Chart Data ─────────────────────────────
app.get('/api/chart', (req, res) => {
  const { symbol, timeframe } = req.query;

  if (!symbol || !STOCKS[symbol] || !['1m', '1d', '1w', '1mo'].includes(timeframe)) {
    return res.status(400).json({ success: false, message: '유효하지 않은 파라미터' });
  }

  const data = generateChartData(symbol, timeframe);
  res.json({ success: true, data });
});

// ── API: Get Orders ────────────────────────────────
app.get('/api/orders', async (_req, res) => {
  try {
    const rows = await rpc('usinvest_list_orders', { p_limit: 50 });
    // 화면은 오래된 것 → 새 것 순서를 기대한다 (저장창고는 새 것부터 준다)
    const data = rows.reverse().map((o) => ({
      timestamp: o.created_at,
      symbol: o.symbol,
      name: STOCKS[o.symbol]?.name || o.symbol,
      type: o.side,
      quantity: o.qty,
      price: o.price,
      totalCost: o.amount,
      memo: ''
    }));
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, '주문 내역 조회 실패');
  }
});

// ── API: Place Order ────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { symbol, type, quantity } = req.body;

  // 검증
  if (!symbol || !STOCKS[symbol]) {
    return res.status(400).json({ success: false, message: '유효하지 않은 종목' });
  }

  if (!['buy', 'sell'].includes(type)) {
    return res.status(400).json({ success: false, message: '매수/매도 구분 오류' });
  }

  if (!quantity || quantity <= 0 || !Number.isInteger(quantity)) {
    return res.status(400).json({ success: false, message: '유효하지 않은 수량' });
  }

  try {
    // 잔액·보유 수량 검사와 기록은 저장창고 함수가 한 번에 처리한다
    const price = round2(await getStockPrice(symbol));
    const { order: o, wallet } = await rpc('usinvest_trade', {
      p_symbol: symbol, p_side: type, p_qty: quantity, p_price: price
    });

    res.status(201).json({
      success: true,
      data: {
        order: {
          timestamp: o.created_at,
          symbol: o.symbol,
          name: STOCKS[o.symbol].name,
          type: o.side,
          quantity: o.qty,
          price: o.price,
          totalCost: o.amount,
          memo: ''
        },
        wallet: { cash: round2(wallet.cash), holdings: wallet.holdings }
      }
    });
  } catch (err) {
    sendError(res, err, '주문 처리 실패');
  }
});

// ── SPA Fallback ────────────────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error Handler ───────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, message: '서버 오류' });
});

// ── Startup ─────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 미국주식 모의투자 서버 시작`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`\n⚠️  Alpaca API 키: ${process.env.ALPACA_API_KEY ? '연결됨' : '미설정 (데모 모드)'}`);
    console.log(`🗄️  저장창고(Supabase): ${SUPABASE_URL && SUPABASE_KEY ? '접속 정보 있음' : '접속 정보 없음 (.env 확인)'}\n`);
  });
}

module.exports = app;
