// ========================================
// 🛒 쇼핑몰 백엔드 서버 (Supabase DB + 보안 검사판)
// 실행 방법: npm install → .env 파일 채우기 → npm start → http://localhost:3001
//
// 🧭 이 서버가 하는 일 (쉽게 말하면)
//   1) 출입증 검사: 요청이 들고 온 로그인 토큰이 진짜인지 Supabase에게 물어봅니다.
//   2) 가격 검사: 상품 가격을 Supabase DB에서 직접 읽어서, 손님이 보낸 금액과 비교합니다.
//   3) 결제 확인: 토스에 승인을 요청하고, 다시 한 번 토스에 "맞지?" 하고 물어봅니다.
//   4) 주인 확인: 주문표의 주인이 지금 들어온 사람인지 확인합니다. 아니면 403.
// ========================================

// 📄 .env 파일에 적은 비밀 설정(URL, 키 등)을 읽어옵니다. 코드에 직접 쓰지 않으려고요.
require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ========================================
// ⚙️ 설정값 (.env 에서 가져옴)
// ========================================
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
// 🔴 service role key 는 "관리자 열쇠"입니다. 서버에서만 쓰고, 프론트에는 절대 넣지 않습니다.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';

const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';
const TOSS_PAYMENT_LOOKUP_URL = 'https://api.tosspayments.com/v1/payments/'; // 뒤에 paymentKey 를 붙임
const TOSS_TIMEOUT_MS = 10000;

// 🔑 두 가지 열쇠를 가진 전화기(Supabase 연결)를 만듭니다.
//   - authClient (anon key = 방문객 열쇠): "이 토큰 주인이 누구야?"를 묻는 데만 씁니다.
//   - adminClient (service role key = 관리자 열쇠): 주문 테이블을 읽고 쓰는 데 씁니다.
//     주문 테이블은 브라우저(anon)가 못 열도록 잠가 두었기 때문에, 서버만 열 수 있습니다.
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const authClient = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, clientOptions) : null;
const adminClient = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, clientOptions) : null;

// 서버를 켤 때 빠진 설정이 있으면 미리 알려줍니다.
['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'TOSS_SECRET_KEY'].forEach((name) => {
  if (!process.env[name]) console.warn(`⚠️ .env 에 ${name} 이 비어 있어요.`);
});

app.use(express.json());

// 🛡️ 기본 보안 헤더
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ========================================
// 🧰 도우미 함수
// ========================================

// 토스 서버와 통신 (시크릿 키로 인증)
async function callToss(url, options = {}) {
  const basicToken = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Basic ${basicToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// 주문번호 형식 검사 (ORDER_ + UUID 만 허용) → 이상한 값이 DB까지 가지 않게 막음
const ORDER_ID_PATTERN = /^ORDER_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 금액은 "양의 정수"만 허용
function isValidAmount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// DB 한 줄(snake_case)을 프론트가 쓰는 모양(camelCase)으로 바꿔 줍니다.
function toOrderView(row) {
  return {
    orderId: row.order_id,
    productId: row.product_id,
    productName: row.product_name,
    image: row.image_url,
    amount: row.amount,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ========================================
// 🛡️ [미들웨어 1] 출입증(JWT) 검사 — 사용자 식별
// 쉽게 말하면: 문 앞 경비원이 손님의 출입증을 Supabase 본사에 진짜인지 물어보는 과정입니다.
//   1) 요청 헤더 "Authorization: Bearer 토큰" 을 꺼냅니다.
//   2) supabase.auth.getUser(토큰) 으로 Supabase에게 확인을 받습니다.
//      (토큰이 위조됐거나 만료됐으면 Supabase가 "아니요"라고 답합니다.)
//   3) 통과하면 손님의 고유 번호(user_id)를 req.user 에 적어 둡니다.
//      이 user_id 가 이후 모든 "본인 확인"의 기준이 됩니다.
// ========================================
async function requireAuth(req, res, next) {
  if (!authClient) {
    return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요. 관리자에게 문의해 주세요.' });
  }

  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: '로그인이 필요해요.' });
  }

  try {
    const { data, error } = await authClient.auth.getUser(token);
    if (error || !data.user) {
      return res.status(401).json({ message: '로그인 정보가 올바르지 않거나 만료됐어요. 다시 로그인해 주세요.' });
    }
    req.user = { id: data.user.id, email: data.user.email }; // id = 이 손님의 user_id
    next();
  } catch (err) {
    console.error('로그인 확인 중 오류:', err.message);
    return res.status(401).json({ message: '로그인 정보를 확인할 수 없어요.' });
  }
}

// ========================================
// 🚪 [미들웨어 2] 남의 주문인지 확인 — 권한 탈취 방어
// 쉽게 말하면: 주문표(DB 한 줄)에 적힌 주인 번호와 손님의 user_id 가 같은지 보는 두 번째 경비원입니다.
//   - 주문이 없으면 404
//   - 주문의 user_id 와 손님의 user_id 가 다르면 403 Forbidden (남의 주문 차단)
//   - 같으면 req.order 에 담아 다음 단계로 통과
// 반드시 requireAuth 뒤에 와야 합니다 (먼저 "누구인지"를 알아야 하니까요).
// ========================================
async function requireOwnOrder(req, res, next) {
  if (!adminClient) {
    return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요. 관리자에게 문의해 주세요.' });
  }

  const orderId = req.params.orderId || (req.body && req.body.orderId);
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return res.status(400).json({ message: '잘못된 주문번호예요.' });
  }

  // 📦 Supabase DB의 orders 테이블에서 이 주문번호 한 줄을 찾습니다.
  const { data: row, error } = await adminClient
    .from('orders')
    .select('*')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) {
    console.error('주문 조회 오류:', error.message);
    return res.status(500).json({ message: '서버 오류가 발생했어요.' });
  }
  if (!row) return res.status(404).json({ message: '주문을 찾을 수 없어요.' });

  // ⭐ 핵심: 주문표 주인(row.user_id)과 지금 로그인한 손님(req.user.id)이 같아야 통과
  if (row.user_id !== req.user.id) {
    return res.status(403).json({ message: '본인의 주문만 조회하거나 결제할 수 있어요.' });
  }

  req.order = row;
  next();
}

// ========================================
// 🔎 [API] 상품 목록 / 상세 — Supabase 상품 테이블에서 읽기
// 상품 정보는 누구나 볼 수 있어요 (setup.sql 의 "누구나 상품 보기" 규칙).
// ========================================
app.get('/api/products', async (req, res) => {
  if (!authClient) return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요.' });

  const { data, error } = await authClient.from('products').select('*').order('id');
  if (error) {
    console.error('상품 목록 조회 오류:', error.message);
    return res.status(500).json({ message: '상품을 불러오지 못했어요.' });
  }
  res.json(data.map((p) => ({ id: p.id, name: p.name, price: p.price, image: p.image_url, description: p.description })));
});

app.get('/api/products/:id', async (req, res) => {
  if (!authClient) return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요.' });

  const { data: p, error } = await authClient.from('products').select('*').eq('id', Number(req.params.id)).maybeSingle();
  if (error) return res.status(500).json({ message: '상품을 불러오지 못했어요.' });
  if (!p) return res.status(404).json({ message: '상품을 찾을 수 없어요.' });
  res.json({ id: p.id, name: p.name, price: p.price, image: p.image_url, description: p.description });
});

// ========================================
// 🧾 [API] 주문 생성 = 결제 "전" 가격 검사 (금액 조작 방어)
// 손님이 보낸 금액은 "참고"만 합니다.
// 진짜 가격은 Supabase 상품 테이블에서 직접 읽어서, 1원이라도 다르면 결제를 막습니다.
// ========================================
app.post('/api/orders', requireAuth, async (req, res) => {
  if (!adminClient) return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요.' });

  const { productId, amount } = req.body || {};
  if (!Number.isInteger(Number(productId)) || !isValidAmount(amount)) {
    return res.status(400).json({ message: '잘못된 요청이에요.' });
  }

  // 1) 상품 테이블에서 "진짜 상품"을 찾습니다 (손님 말을 믿지 않아요)
  const { data: product, error } = await adminClient
    .from('products')
    .select('*')
    .eq('id', Number(productId))
    .maybeSingle();
  if (error) return res.status(500).json({ message: '서버 오류가 발생했어요.' });
  if (!product) return res.status(404).json({ message: '없는 상품이에요.' });

  // 2) ⭐ 손님이 보낸 금액 vs DB의 진짜 가격 비교 → 다르면 차단
  if (amount !== product.price) {
    return res.status(400).json({ message: '금액이 상품 가격과 달라요. 결제를 막았어요.' });
  }

  // 3) 주문표를 만듭니다. 주인(user_id)은 출입증에서 읽은 값으로 적습니다.
  //    손님이 보낸 user_id 는 절대 쓰지 않아요.
  const orderId = `ORDER_${crypto.randomUUID()}`;
  const { error: insertError } = await adminClient.from('orders').insert({
    order_id: orderId,
    user_id: req.user.id,
    product_id: product.id,
    product_name: product.name,
    image_url: product.image_url,
    amount: product.price, // DB에 적힌 진짜 가격
    status: '결제대기',
  });
  if (insertError) {
    console.error('주문 저장 오류:', insertError.message);
    return res.status(500).json({ message: '주문을 저장하지 못했어요.' });
  }

  res.status(201).json({ orderId, orderName: product.name, amount: product.price });
});

// ========================================
// ✅ [API] 결제 최종 승인 = 결제 "후" 검사 (서버 대 서버 교차 검증)
// 미들웨어 2개(출입증 → 남의 주문인지)를 통과해야 이 안으로 들어옵니다.
//   ① 금액이 DB 주문 금액과 같은가?
//   ② 토스에 "승인해 주세요" 요청
//   ③ 토스에 "이 결제 진짜 맞아?" 다시 조회 → 상태·주문번호·금액 대조
//   ④ 전부 맞으면 DB의 주문 상태를 "결제완료"로 바꿉니다.
// ========================================
app.post('/api/payments/confirm', requireAuth, requireOwnOrder, async (req, res) => {
  try {
    const { paymentKey, amount } = req.body || {};
    const order = req.order; // DB에서 방금 확인한 "내 주문" 한 줄

    if (typeof paymentKey !== 'string' || paymentKey.length > 200) {
      return res.status(400).json({ message: '잘못된 요청이에요.' });
    }

    // 이미 처리된 주문이면 다시 승인하지 않고 현재 상태만 돌려줌
    if (order.status !== '결제대기') return res.json(toOrderView(order));

    // ⭐ 금액 검사: 손님이 보낸 금액은 조작될 수 있으니 DB 금액과만 비교
    if (!isValidAmount(amount) || amount !== order.amount) {
      return res.status(400).json({ message: '결제 금액이 주문 금액과 달라요. 승인을 막았어요.' });
    }

    // ② 토스에 승인 요청 (금액은 DB 값으로)
    const confirmRes = await callToss(TOSS_CONFIRM_URL, {
      method: 'POST',
      body: JSON.stringify({ paymentKey, orderId: order.order_id, amount: order.amount }),
    });
    if (!confirmRes.ok) {
      return res.status(confirmRes.status).json({ message: confirmRes.data.message || '결제 승인에 실패했어요.' });
    }

    // ③ ⭐ 교차 검증: 토스 원장에 다시 물어봅니다 (프론트 말은 전혀 믿지 않아요)
    const lookupRes = await callToss(TOSS_PAYMENT_LOOKUP_URL + encodeURIComponent(paymentKey), { method: 'GET' });
    const tossPayment = lookupRes.data || {};
    const isVerified =
      lookupRes.ok &&
      tossPayment.status === 'DONE' &&
      tossPayment.orderId === order.order_id &&
      tossPayment.totalAmount === order.amount;

    if (!isVerified) {
      await adminClient.from('orders').update({ status: '검증실패' }).eq('order_id', order.order_id);
      console.error('⚠️ 교차 검증 실패', { orderId: order.order_id });
      return res.status(400).json({ message: '결제 정보 검증에 실패했어요. 고객센터에 문의해 주세요.' });
    }

    // ④ 모든 검사 통과 → DB 주문 상태 변경 (주인 번호까지 한 번 더 확인하며 수정)
    const { data: updated, error: updateError } = await adminClient
      .from('orders')
      .update({ status: '결제완료', payment_key: paymentKey })
      .eq('order_id', order.order_id)
      .eq('user_id', req.user.id)
      .select('*')
      .single();
    if (updateError) {
      console.error('주문 상태 변경 오류:', updateError.message);
      return res.status(500).json({ message: '서버 오류가 발생했어요.' });
    }

    // 데모용: 30초 뒤 "배송준비중"으로 자동 변경
    setTimeout(() => {
      adminClient.from('orders').update({ status: '배송준비중' })
        .eq('order_id', order.order_id).eq('status', '결제완료').then(() => {});
    }, 30000);

    res.json(toOrderView(updated));
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: '서버 오류가 발생했어요.' });
  }
});

// ========================================
// 📋 [API] 내 주문 목록 (마이페이지) — DB에서 "내 user_id 와 같은 것만" 가져오기
// SQL 로 말하면: SELECT * FROM orders WHERE user_id = (출입증에서 읽은 내 번호)
// 손님이 아무리 다른 번호를 보내도 그 값은 무시되고, 출입증의 번호만 사용합니다.
// ========================================
app.get('/api/orders', requireAuth, async (req, res) => {
  if (!adminClient) return res.status(500).json({ message: '서버 설정(.env)이 비어 있어요.' });

  const { data, error } = await adminClient
    .from('orders')
    .select('*')
    .eq('user_id', req.user.id) // ⭐ 핵심 필터: 내 주문만
    .order('created_at', { ascending: false });

  if (error) {
    console.error('주문 목록 조회 오류:', error.message);
    return res.status(500).json({ message: '주문 내역을 불러오지 못했어요.' });
  }
  res.json(data.map(toOrderView));
});

// ========================================
// 🔍 [API] 주문 한 건 상세 — 남의 주문번호는 403
// ========================================
app.get('/api/orders/:orderId', requireAuth, requireOwnOrder, (req, res) => {
  res.json(toOrderView(req.order));
});

// ========================================
// 🚨 [에러 처리] 맨 마지막 안전망
// ========================================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '요청 형식이 올바르지 않아요.' });
  }
  console.error(err.message);
  res.status(500).json({ message: '서버 오류가 발생했어요.' });
});

// ========================================
// 🚀 서버 시작 (node server.js 로 실행할 때만 켜짐)
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
  });
}
module.exports = app;
