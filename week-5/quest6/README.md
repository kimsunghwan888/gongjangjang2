# 헬시 에이전트 리모컨

스마트폰으로 건강식품 리서치와 상세페이지 제작 에이전트를 원격 제어하는 모바일 웹 대시보드와 백엔드입니다.

## 시작하기

1. Node.js를 설치합니다.
2. [start.bat](start.bat)을 더블클릭합니다. 서버(3100 포트)가 켜지고 브라우저가 열립니다.
3. 이메일을 입력하고 "인증 링크 발송"을 누르면 개발 모드에서는 메일 없이 바로 로그인됩니다.

수동 실행은 아래와 같습니다.

```
npm.cmd install
$env:PORT=3100; node server.js
```

`index.html`을 파일로 직접 열면 안 되고 서버 주소(`http://localhost:3100`)로 접속해야 합니다.

## 구성

| 파일 | 역할 |
|------|------|
| `index.html` | React + Tailwind(CDN) 모바일 대시보드. 명령, 시장, 매칭, AI결과 4개 탭 |
| `server.js` | Express 5 백엔드. 인증, 명령 큐, 수집, 매칭, LLM 브랜딩, WebSocket 푸시 |

## 주요 기능

- **인증:** 이메일 매직 링크, JWT 액세스 15분, 리프레시 30일(회전). 개발 모드에서는 링크를 응답으로 돌려 자동 로그인합니다.
- **명령 큐:** 자연어 명령을 큐에 넣고 처리하며, 상태(수집중 → 디자인중 → 완료)를 WebSocket(`/ws?token=`)으로 실시간 전달합니다.
- **수집 파이프라인:** 쿠팡 상위 상품, 원료 수입량, 홈쇼핑 편성표를 수집하고 LLM(없으면 규칙 파서)으로 정제합니다.
- **매칭 엔진:** 수입 급증(신규 포함) 원료와 홈쇼핑 편성을 14일 창에서 조인해 점수를 매깁니다.
- **AI 레이어:** 상품명, 쿠팡 SEO 키워드 2개, 상세페이지 Markdown, 이미지 프롬프트를 만듭니다. OpenAI 키가 없으면 목업 결과와 placehold.co 이미지를 씁니다.

## API

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/auth/request` | 인증 링크 요청 `{email}` |
| POST | `/api/auth/verify` | 링크 토큰 검증 `{token}` |
| POST | `/api/auth/refresh`, `/api/auth/logout` | 세션 갱신, 종료 |
| POST | `/api/commands` | 원격 명령 `{command}` |
| GET | `/api/jobs`, `/api/jobs/:id` | 작업 상태 |
| GET | `/api/market`, `/api/match`, `/api/outputs`, `/api/notifications` | 결과 조회 |
| GET | `/api/health`, `/api/schema` | 상태, DB 스키마(개발용) |

## 환경변수

| 이름 | 설명 |
|------|------|
| `PORT` | 기본 3000. start.bat은 3100 사용 |
| `JWT_SECRET`, `APP_URL`, `NODE_ENV` | 운영 시 필수 |
| `RESEND_API_KEY`, `MAIL_FROM` | 실제 인증 메일 발송(Resend). 없으면 개발 모드 |
| `OPENAI_API_KEY`, `LLM_MODEL` | LLM과 이미지(DALL-E 3). 없으면 목업 |
| `OPENCLAW_GATEWAY_URL` | OpenClaw 계획 위임. 요청 규격은 가정이며 `planWithOpenClaw`에서 조정 |
| `IMPORT_API_KEY`, `IMPORT_API_URL`, `IMPORT_HS_MAP` | 공공데이터포털 무료 API(관세청 품목별 수출입실적, 15101609)로 수입량 조회. 없으면 목업 |

## 현재 한계

- 쿠팡과 홈쇼핑 데이터는 가상 데이터입니다. 쿠팡의 차단·캡차를 우회하는 방식(프록시, User-Agent 롤링)은 구현하지 않았고, 파트너스 API 같은 허용된 소스로 교체하는 것을 전제로 합니다.
- 수입량 실제 API는 키 발급 전이라 호출을 검증하지 못했습니다. 응답 필드명(`year`, `impWgt`)과 HS코드는 확인이 필요합니다.
- 데이터는 모두 메모리에 저장되어 서버를 재시작하면 초기화됩니다.
- WebSocket은 상시 서버에서만 동작하며 Vercel 서버리스에서는 쓸 수 없습니다.
