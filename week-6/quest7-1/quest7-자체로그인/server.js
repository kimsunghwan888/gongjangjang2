// ========================================
// 🛒 쇼핑몰 백엔드 서버 (보안·검증 강화판)
// 실행 방법: npm install → npm start → 브라우저에서 http://localhost:3001
//
// 🔐 이 서버가 막는 두 가지 해킹
//   ① 금액 조작: 프론트가 보낸 금액은 믿지 않고, 서버의 진짜 가격과 비교
//   ② 권한 탈취: 로그인한 "본인 주문"만 조회·결제 가능 (남의 주문번호는 403)
// ========================================
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // 🔐 비밀번호를 암호화(해시)하는 도구

const app = express();
const PORT = process.env.PORT || 3001;

// ========================================
// ⚙️ 설정값
// ========================================
// ⚠️ 토스페이먼츠 "시크릿 키" (테스트용 공식 예제 키)
// 시크릿 키는 서버에만 두고, 프론트(index.html)에는 절대 넣지 않습니다.
const TOSS_SECRET_KEY = 'test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6';
const TOSS_CONFIRM_URL = 'https://api.tosspayments.com/v1/payments/confirm';
const TOSS_PAYMENT_LOOKUP_URL = 'https://api.tosspayments.com/v1/payments/'; // 뒤에 paymentKey 를 붙임

// 🔑 로그인 토큰(출입증)을 서명하는 비밀 키
// 실제 배포에서는 환경변수(JWT_SECRET)로 주입하세요. 없으면 서버 시작 때 무작위로 만듭니다.
// (무작위이므로 서버를 껐다 켜면 기존 로그인은 풀립니다. 과제용이라 괜찮습니다.)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_EXPIRES_IN = '2h'; // 로그인 유효 시간

// 토스 호출 시 무한 대기 방지 (10초 넘으면 포기)
const TOSS_TIMEOUT_MS = 10000;

app.use(express.json());

// 🛡️ 기본 보안 헤더: 브라우저가 파일 종류를 멋대로 판단하거나, 다른 사이트에 화면이 끼워지는 것을 막음
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.static(path.join(__dirname, 'public'))); // public 폴더 안의 index.html 을 보여줌

// ========================================
// 📦 가짜 데이터 (과제용 샘플 상품 / 회원)
// ========================================
const products = [
  { id: 1, name: '원목 라운지 체어', price: 189000, image: 'https://picsum.photos/seed/chair/600/600', description: '따뜻한 원목 프레임에 부드러운 쿠션을 더한 라운지 체어입니다.' },
  { id: 2, name: '북유럽 패브릭 소파', price: 690000, image: 'https://picsum.photos/seed/sofa/600/600', description: '3인용 패브릭 소파. 어떤 거실에도 잘 어울립니다.' },
  { id: 3, name: '미니멀 원형 테이블', price: 129000, image: 'https://picsum.photos/seed/table/600/600', description: '지름 80cm 원형 테이블. 작은 공간에 알맞습니다.' },
  { id: 4, name: '감성 조명 스탠드', price: 58000, image: 'https://picsum.photos/seed/lamp/600/600', description: '은은한 빛을 내는 무드등 스탠드입니다.' },
];

// 🔒 회원 정보 (🔐 비밀번호는 bcrypt로 암호화해서 "해시"만 저장합니다)
// 쉽게 말하면: 비밀번호를 믹서기에 갈아서 저장하는 것과 같습니다.
//   - 갈아 놓은 결과(해시)만 보관하고, 원래 비밀번호는 어디에도 남기지 않습니다.
//   - 로그인할 때는 입력한 비밀번호를 같은 방식으로 갈아서 결과가 같은지만 비교합니다.
// 숫자 10 = 암호화를 얼마나 여러 번 반복할지(클수록 해킹이 어려우나 느려짐). 10이 보통 값입니다.
const BCRYPT_ROUNDS = 10;
const PASSWORD_MIN_LENGTH = 6;

// 데모 계정 (테스트용): kim@example.com / pw1234 , lee@example.com / pw5678
// 회원가입으로 만든 계정은 서버를 껐다 켜면 사라집니다 (메모리 저장).
const users = [
  { id: 'u1', email: 'kim@example.com', passwordHash: bcrypt.hashSync('pw1234', BCRYPT_ROUNDS) },
  { id: 'u2', email: 'lee@example.com', passwordHash: bcrypt.hashSync('pw5678', BCRYPT_ROUNDS) },
];

// 🕵️ 가짜 해시: 없는 이메일로 로그인해도 같은 시간이 걸리도록 비교하는 데 씁니다.
// (그래야 "이메일이 존재하는지"를 응답 속도로 눈치채지 못합니다)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_ROUNDS);

// 🚧 로그인 실패 횟수 기록 (무차별 대입 공격 방어: 5번 틀리면 1분간 잠금)
const loginFailures = new Map(); // key: 이메일, value: { count, lockedUntil }

// 이메일 형식 검사 (간단한 검사: 글자@글자.글자)
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 주문 저장소 (서버를 끄면 사라지는 임시 저장소)
// key: orderId, value: 주문 정보 (주문한 사람의 userId 포함 → 본인 확인에 사용)
const orders = new Map();

// ========================================
// 🧰 도우미 함수들
// ========================================

// 토스 서버와 통신할 때 쓰는 공통 함수 (시크릿 키로 인증)
async function callToss(url, options = {}) {
  // 인증 방식: 시크릿 키 + ":" 를 base64로 바꾼 값 (토스 공식 방식)
  const basicToken = Buffer.from(`${TOSS_SECRET_KEY}:`).toString('base64');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Basic ${basicToken}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({})); // 응답이 JSON이 아니어도 죽지 않게
  return { ok: res.ok, status: res.status, data };
}

// 입력값 검사: 주문번호는 우리가 만든 형식(ORDER_ + UUID)만 허용
const ORDER_ID_PATTERN = /^ORDER_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 입력값 검사: 금액은 "양의 정수"만 허용 (문자열, 소수, 음수, 0 전부 거절)
function isValidAmount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ========================================
// 🛡️ [미들웨어] 로그인 확인 (권한 검사의 1단계)
// 요청 헤더의 "Authorization: Bearer 토큰" 을 확인합니다.
// 토큰이 없거나 위조/만료됐으면 401(로그인 필요)로 막습니다.
// 통과하면 req.user 에 "지금 요청한 사람"의 정보를 담아 둡니다.
// ========================================
function requireAuth(req, res, next) {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: '로그인이 필요해요.' });
  }
  try {
    // algorithms 를 HS256 으로 고정해서 "알고리즘 바꿔치기" 공격을 막습니다.
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (err) {
    return res.status(401).json({ message: '로그인 정보가 올바르지 않거나 만료됐어요. 다시 로그인해 주세요.' });
  }
}

// ========================================
// 🚪 [미들웨어] 본인 주문인지 확인 (권한 검사의 2단계)
// 쉽게 말하면: "이 주문표가 지금 들어온 사람의 것인지" 문 앞에서 확인하는 경비원입니다.
// 주문번호는 주소(/api/orders/주문번호)나 요청 본문(body)에서 찾습니다.
//   - 주문이 없으면 404
//   - 주문은 있는데 내 것이 아니면 403 (남의 주문 접근 차단)
//   - 내 것이면 req.order 에 담아 두고 다음 단계로 통과
// 반드시 requireAuth 뒤에 와야 합니다 (먼저 "누구인지"를 알아야 하니까요).
// ========================================
function requireOwnOrder(req, res, next) {
  const orderId = req.params.orderId || (req.body && req.body.orderId);

  // 주문번호 모양이 맞는지 먼저 확인 (이상한 값은 아예 조회하지 않음)
  if (!ORDER_ID_PATTERN.test(orderId)) {
    return res.status(400).json({ message: '잘못된 주문번호예요.' });
  }

  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ message: '주문을 찾을 수 없어요.' });

  // ⭐ 핵심: 주문의 주인(userId)과 지금 로그인한 사람(req.user.id)이 같아야 통과
  if (order.userId !== req.user.id) {
    return res.status(403).json({ message: '본인의 주문만 조회하거나 결제할 수 있어요.' });
  }

  req.order = order; // 다음 단계에서 쓸 수 있도록 주문 정보를 붙여 둠
  next();
}

// 🎫 토큰(출입증) 만들기: 사용자 번호(sub)와 이메일을 담아 서명합니다.
function issueToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: TOKEN_EXPIRES_IN,
  });
}

// ========================================
// 📝 [API] 회원가입: 이메일 + 비밀번호로 계정 만들기
// 성공하면 바로 토큰을 돌려줘서 별도 로그인 없이 들어갈 수 있게 합니다.
// ========================================
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body || {};

  // 1) 입력값 검사: 이메일 형식, 비밀번호 최소 길이
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim())) {
    return res.status(400).json({ message: '이메일 형식이 올바르지 않아요.' });
  }
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return res.status(400).json({ message: `비밀번호는 ${PASSWORD_MIN_LENGTH}자 이상이어야 해요.` });
  }

  // 2) 같은 이메일이 이미 있는지 확인 (이메일은 대소문자 구분 없이 소문자로 통일)
  const normalizedEmail = email.trim().toLowerCase();
  if (users.some((u) => u.email === normalizedEmail)) {
    return res.status(409).json({ message: '이미 가입된 이메일이에요.' });
  }

  // 3) 🔐 비밀번호 암호화: bcrypt가 자동으로 무작위 소금(salt)을 섞어서 해시를 만듭니다.
  //    같은 비밀번호라도 매번 다른 해시가 나옵니다. 원래 비밀번호는 저장하지 않습니다.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: `u${users.length + 1}_${crypto.randomUUID()}`,
    email: normalizedEmail,
    passwordHash,
  };
  users.push(user);

  // 4) 가입 완료 → 토큰 발급
  res.status(201).json({ token: issueToken(user), email: user.email });
});

// ========================================
// 🔐 [API] 로그인: 이메일·비밀번호 확인 후 토큰(출입증) 발급
// ========================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ message: '이메일과 비밀번호를 입력해 주세요.' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  // 1) 너무 많이 틀렸는지 먼저 확인 (잠금 중이면 바로 거절)
  const failure = loginFailures.get(normalizedEmail);
  if (failure && failure.lockedUntil > Date.now()) {
    return res.status(429).json({ message: '로그인을 여러 번 틀려서 잠시 잠겼어요. 1분 뒤에 다시 시도해 주세요.' });
  }

  // 2) 이메일로 회원 찾기 → 🔐 입력한 비밀번호를 암호화해서 저장된 해시와 비교
  //    회원이 없어도 가짜 해시(DUMMY_HASH)와 비교해서 응답 시간을 비슷하게 맞춥니다.
  const user = users.find((u) => u.email === normalizedEmail);
  const passwordOk = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

  if (!user || !passwordOk) {
    // 실패 횟수 기록: 5번이면 1분 잠금
    const count = (failure ? failure.count : 0) + 1;
    loginFailures.set(normalizedEmail, { count, lockedUntil: count >= 5 ? Date.now() + 60000 : 0 });
    // 이메일이 틀렸는지 비밀번호가 틀렸는지 알려주지 않음 (해커에게 힌트를 주지 않기 위해)
    return res.status(401).json({ message: '이메일 또는 비밀번호가 맞지 않아요.' });
  }

  // 3) 성공 → 실패 기록 지우고 토큰 발급
  loginFailures.delete(normalizedEmail);
  res.json({ token: issueToken(user), email: user.email });
});

// ========================================
// 🔎 [API] 상품 목록 / 상품 상세 (누구나 볼 수 있음)
// ========================================
app.get('/api/products', (req, res) => {
  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const product = products.find((p) => p.id === Number(req.params.id));
  if (!product) return res.status(404).json({ message: '상품을 찾을 수 없어요.' });
  res.json(product);
});

// ========================================
// 🧾 [API] 주문 생성 = 결제 "전" 검증 (🛡️ 금액 조작 방어 ①)
// 프론트가 보낸 금액(amount)은 "참고만" 합니다.
// 진짜 가격은 서버 상품 목록에서 꺼내서, 1원이라도 다르면 결제를 막습니다.
// ========================================
app.post('/api/orders', requireAuth, (req, res) => {
  const { productId, amount } = req.body || {};

  // 1) 입력값 형식 검사 (숫자인지, 금액이 정상 범위인지)
  if (!Number.isInteger(Number(productId)) || !isValidAmount(amount)) {
    return res.status(400).json({ message: '잘못된 요청이에요.' });
  }

  // 2) 상품이 실제로 있는지 확인
  const product = products.find((p) => p.id === Number(productId));
  if (!product) return res.status(404).json({ message: '없는 상품이에요.' });

  // 3) ⭐ 핵심: 프론트가 보낸 금액 vs 서버의 진짜 가격 비교 → 다르면 차단
  if (amount !== product.price) {
    return res.status(400).json({ message: '금액이 상품 가격과 달라요. 결제를 막았어요.' });
  }

  // 4) 주문 생성: 주문자(req.user.id)를 함께 저장 → 나중에 "본인 주문" 확인에 씀
  //    금액·상품명은 전부 서버 값으로 저장합니다 (프론트 값 사용 안 함).
  const orderId = `ORDER_${crypto.randomUUID()}`;
  const order = {
    orderId,
    userId: req.user.id,
    productId: product.id,
    productName: product.name,
    image: product.image,
    amount: product.price, // 서버가 정한 진짜 금액
    status: '결제대기',
    createdAt: new Date().toISOString(),
  };
  orders.set(orderId, order);

  // 5) 결제창을 열 때 필요한 정보만 돌려줌
  res.status(201).json({ orderId, orderName: product.name, amount: product.price });
});

// ========================================
// ✅ [API] 결제 최종 승인 = 결제 "후" 검증 (🛡️ 금액 조작 방어 ②)
// 토스 결제창이 성공하면 프론트가 paymentKey, orderId, amount 를 보냅니다.
// 서버는 이 값들을 믿지 않고, 아래 순서로 전부 다시 확인합니다.
//   ① 내 주문인가? (남의 결제를 승인하지 못하게)
//   ② 금액이 서버 주문 금액과 같은가?
//   ③ 토스에 승인 요청 (토스가 실제 결제를 확정)
//   ④ 토스에 "이 결제 정말 맞아?" 재조회 → 금액·주문번호·상태를 서버 대 서버로 교차 검증
// ========================================
// 🚪 미들웨어 2개를 차례로 통과해야 이 안으로 들어옵니다.
//    requireAuth: 로그인했는지 확인 → requireOwnOrder: 내 주문인지 확인 (남의 주문이면 403)
app.post('/api/payments/confirm', requireAuth, requireOwnOrder, async (req, res) => {
  try {
    const { paymentKey, amount } = req.body || {};
    const order = req.order; // 미들웨어가 이미 찾아 둔 "내 주문"
    const orderId = order.orderId;

    // 0) 입력값 형식 검사
    if (typeof paymentKey !== 'string' || paymentKey.length > 200) {
      return res.status(400).json({ message: '잘못된 요청이에요.' });
    }

    // 3) 이미 결제된 주문이면 다시 승인하지 않고 현재 상태만 돌려줌 (새로고침·중복 요청 대비)
    if (order.status !== '결제대기') return res.json(order);

    // 4) ⭐ 금액 검증: 프론트가 보낸 금액 vs 서버 주문 금액
    //    (프론트 URL 의 amount 는 조작될 수 있으므로, 서버 값만 믿습니다)
    if (!isValidAmount(amount) || amount !== order.amount) {
      return res.status(400).json({ message: '결제 금액이 주문 금액과 달라요. 승인을 막았어요.' });
    }

    // 5) 토스에 "이 결제 승인해 주세요" 요청 (금액은 서버 주문 금액을 보냄)
    const confirmRes = await callToss(TOSS_CONFIRM_URL, {
      method: 'POST',
      body: JSON.stringify({ paymentKey, orderId, amount: order.amount }),
    });
    if (!confirmRes.ok) {
      return res.status(confirmRes.status).json({ message: confirmRes.data.message || '결제 승인에 실패했어요.' });
    }

    // 6) ⭐ 서버 대 서버 교차 검증: 토스에 결제 정보를 다시 조회해서 진짜 돈이 맞게 들어왔는지 확인
    //    프론트가 뭐라고 했든 "토스 원장"의 값을 기준으로 판단합니다.
    const lookupRes = await callToss(TOSS_PAYMENT_LOOKUP_URL + encodeURIComponent(paymentKey), { method: 'GET' });
    const tossPayment = lookupRes.data || {};
    const isVerified =
      lookupRes.ok &&
      tossPayment.status === 'DONE' &&               // 결제 완료 상태인가
      tossPayment.orderId === order.orderId &&       // 같은 주문번호인가
      tossPayment.totalAmount === order.amount;      // 진짜 결제된 금액이 맞는가

    if (!isVerified) {
      // 검증 실패: 주문을 "검증실패"로 표시하고 완료 처리하지 않음 (운영자가 확인해야 함)
      order.status = '검증실패';
      console.error('⚠️ 교차 검증 실패', { orderId, paymentKey });
      return res.status(400).json({ message: '결제 정보 검증에 실패했어요. 고객센터에 문의해 주세요.' });
    }

    // 7) 모든 검증 통과 → 주문 완료 처리
    order.status = '결제완료';
    order.paymentKey = paymentKey;

    // 📦 데모용: 30초 뒤에 "배송준비중"으로 자동 변경 (주문 상태가 바뀌는 모습 확인용)
    setTimeout(() => {
      if (order.status === '결제완료') order.status = '배송준비중';
    }, 30000);

    res.json(order);
  } catch (err) {
    // 에러 내용(스택)은 서버 화면에만 찍고, 사용자에게는 짧은 문구만 보냅니다.
    console.error(err.message);
    res.status(500).json({ message: '서버 오류가 발생했어요.' });
  }
});

// ========================================
// 📋 [API] 내 주문 목록 (🛡️ 권한 탈취 방어 ①)
// 전체 주문이 아니라 "로그인한 사람의 주문"만 골라서 보여줍니다.
// ========================================
app.get('/api/orders', requireAuth, (req, res) => {
  const mine = [...orders.values()]
    .filter((order) => order.userId === req.user.id) // 본인 것만 남김
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // 최신순
  res.json(mine);
});

// ========================================
// 🔍 [API] 주문 한 건 상세 (🛡️ 권한 탈취 방어 ②)
// 주소창이나 개발자 도구에서 "남의 주문번호"를 직접 넣어도 403으로 차단합니다.
// ========================================
// 🚪 requireAuth(로그인 확인) → requireOwnOrder(내 주문 확인, 남의 주문이면 403) 순서로 검사합니다.
app.get('/api/orders/:orderId', requireAuth, requireOwnOrder, (req, res) => {
  res.json(req.order); // 여기까지 왔다면 "내 주문"이 확실합니다
});

// ========================================
// 🚨 [에러 처리] 맨 마지막에 두는 "안전망"
// 잘못된 JSON이 들어오거나 예상 못 한 에러가 나도 서버가 멈추지 않고 JSON으로 응답합니다.
// ========================================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ message: '요청 형식이 올바르지 않아요.' });
  }
  console.error(err.message);
  res.status(500).json({ message: '서버 오류가 발생했어요.' });
});

// ========================================
// 🚀 서버 시작
// 로컬에서 "node server.js"로 실행하면 서버가 켜지고,
// 다른 파일에서 require 하면 켜지지 않고 app 만 빌려 쓸 수 있습니다.
// ========================================
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
  });
}
module.exports = app;
