import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: '../../.env' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// DB 연결 풀
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on('error', err => {
  console.error('Unexpected error on idle client', err);
});

// ========================================
// API 엔드포인트
// ========================================

// 1. 지갑 정보 조회
app.get('/api/wallet', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, user_id, cash, stocks, created_at, updated_at FROM wallet WHERE user_id = $1',
      ['demo_user']
    );

    if (result.rows.length === 0) {
      // 지갑이 없으면 생성
      const newWallet = await pool.query(
        'INSERT INTO wallet (user_id, cash, stocks) VALUES ($1, $2, $3) RETURNING *',
        ['demo_user', 1000, JSON.stringify({TSLA: 0, GOOGL: 0, AAPL: 0, AMZN: 0})]
      );
      return res.json(newWallet.rows[0]);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching wallet:', error);
    res.status(500).json({ error: error.message });
  }
});

// 2. 매매 실행
app.post('/api/trade', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { type, symbol, quantity, price } = req.body;
    const totalAmount = quantity * price;

    // 지갑 정보 조회
    const walletResult = await client.query(
      'SELECT * FROM wallet WHERE user_id = $1 FOR UPDATE',
      ['demo_user']
    );

    if (walletResult.rows.length === 0) {
      throw new Error('Wallet not found');
    }

    const wallet = walletResult.rows[0];
    const stocks = wallet.stocks;

    if (type === 'buy') {
      // 매수
      if (wallet.cash < totalAmount) {
        throw new Error('잔액이 부족합니다');
      }

      stocks[symbol] = (stocks[symbol] || 0) + quantity;

      await client.query(
        'UPDATE wallet SET cash = cash - $1, stocks = $2, updated_at = NOW() WHERE user_id = $3',
        [totalAmount, JSON.stringify(stocks), 'demo_user']
      );
    } else if (type === 'sell') {
      // 매도
      if ((stocks[symbol] || 0) < quantity) {
        throw new Error('보유 주식이 부족합니다');
      }

      stocks[symbol] -= quantity;

      await client.query(
        'UPDATE wallet SET cash = cash + $1, stocks = $2, updated_at = NOW() WHERE user_id = $3',
        [totalAmount, JSON.stringify(stocks), 'demo_user']
      );
    }

    // 거래 기록 저장
    await client.query(
      'INSERT INTO orders (wallet_id, symbol, type, quantity, price, total_amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [wallet.id, symbol, type, quantity, price, totalAmount]
    );

    await client.query('COMMIT');

    // 업데이트된 지갑 반환
    const updatedWallet = await client.query(
      'SELECT id, user_id, cash, stocks FROM wallet WHERE user_id = $1',
      ['demo_user']
    );

    res.json(updatedWallet.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error executing trade:', error);
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

// 3. 거래 내역 조회
app.get('/api/orders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.id, o.symbol, o.type, o.quantity, o.price, o.total_amount, o.trade_timestamp
       FROM orders o
       JOIN wallet w ON o.wallet_id = w.id
       WHERE w.user_id = $1
       ORDER BY o.created_at DESC`,
      ['demo_user']
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching orders:', error);
    res.status(500).json({ error: error.message });
  }
});

// 기본 라우트
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`🚀 서버가 포트 ${PORT}에서 실행 중입니다`);
  console.log(`📊 브라우저에서 http://localhost:${PORT} 접속하세요`);
});
