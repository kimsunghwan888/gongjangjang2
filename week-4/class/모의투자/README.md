---
version: 1.2
updated: 2026-09-21
---

# 나만의 모의투자

업비트 공개 시세(열쇠 없이 씀)로 사고파는 모의투자 앱. 지갑과 주문 기록은 Supabase(PostgreSQL)에 저장한다.

- 시작 현금 100만원 · 수수료 0.05% · 다루는 코인 3종(BTC ETH XRP)
- 코인 상세에 그래프 3개(1분봉·주봉·월봉)를 탭으로 바꿔 본다
- 지금 상태: 완성. 화면·서버·DB가 모두 연결됨 (업비트 실제 시세, 지갑은 Supabase 저장)

## 켜는 법

1. `.env`에 `DATABASE_URL` 넣기 (`.env.example` 참고, git에 안 올라감)
2. `npm install` → `npm start` (다른 앱과 겹치면 `PORT=3010 node server.js`)
3. 인터넷 창에서 http://localhost:3000

## API

| 방법 | 주소 | 하는 일 |
|---|---|---|
| GET | `/api/markets` | 코인 8종의 현재 시세 |
| GET | `/api/price?market=KRW-BTC` | 코인 하나의 현재가 |
| GET | `/api/candles` | 코인 전체의 지난 60분 가격 (목록의 작은 그래프용) |
| GET | `/api/chart?market=KRW-BTC&kind=minutes` | 코인 하나의 그래프 자료 (`kind`: `minutes`·`weeks`·`months`) |
| GET | `/api/wallet` | 현금·평가금액·수익률·보유 코인 |
| GET | `/api/orders?limit=50` | 주문 내역 (새 것부터) |
| POST | `/api/order` | 매수·매도 체결 |
| POST | `/api/wallet/reset` | 처음(100만원)으로 되돌리기 |
| GET | `/api/health` | DB 연결 확인 |

- 주문 보내는 법: `{ market, side: "buy"/"sell", amount 또는 qty, memo }` (살 때만 `amount`로 "얼마어치" 가능)
- 응답 모양: `{ success, data }` / 실패하면 `{ success: false, message }`
- 수익률 = (현금 + 코인 평가액 − 100만) ÷ 100만 × 100 (%)
- 현금·수량이 모자라거나 1,000원 미만이면 400으로 거절한다.

## DB 표

| 표 | 내용 |
|---|---|
| `mockinvest_wallet` | 지갑 한 줄 (현금 + 보유 코인 `{마켓: {수량, 평균매입가}}`) |
| `mockinvest_orders` | 주문 기록 (시간 · 마켓 · 매수/매도 · 수량 · 체결가 · 수수료 · 메모) |

- 이 DB는 다른 앱(`aichef_*`, `contacts`, `todos`)과 같이 쓴다 → 이 앱은 `mockinvest_` 이름만 쓴다.

## 시행착오

- 업비트는 초당 호출 제한이 있어 시세를 **2초간 기억(캐시)** 해서 쓴다. 주문할 때도 같은 값을 쓴다.
- 주문은 트랜잭션 + `FOR UPDATE`로 지갑 줄을 잠근다 (동시에 두 번 눌러도 꼬이지 않게).
- 화면은 현재가만 이어 붙이면 그래프가 직선이 된다 → `/api/candles`(1분봉 60개)를 처음에 받아 출발점으로 쓴다.
- 업비트 캔들은 **최신이 맨 앞**이라 뒤집어서 쓴다. 한 번에 최대 200개(월봉 200개 = 16년치라 상장 이후 전부 나온다).
- 캔들은 종류마다 기억해 두는 시간이 다르다: 1분봉 30초 · 주봉 10분 · 월봉 1시간.
- index.html을 고친 뒤 화면이 그대로여서 헤맸다 → 서버가 `Cache-Control: no-store`로 보내게 고쳤다.
