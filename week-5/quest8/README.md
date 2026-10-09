# YOU 모의투자 자동 매매 에이전트

실제 시세(yfinance, 미국은 Alpaca 선택)로 움직이는 **가상 자금 1,000만원** 모의투자 대시보드입니다. 10개 종목을 5분마다 점검해 매수·매도 규칙에 맞으면 가상 주문을 내고, 로그인 후 대시보드와 대화형 어시스턴트 **YOU**로 확인합니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 프론트엔드(React·Tailwind·Recharts CDN). 로그인/회원가입, 대시보드, 차트, YOU 채팅 |
| `api_server.py` | FastAPI 서버. JWT 인증, 5초 주기 REST/WebSocket, 어시스턴트 API |
| `trader.py` | 매매 코어. 바닥 패턴(완바닥/쌍바닥/다중바닥), 매수 4규칙, 매도 3규칙, 가상 장부 |
| `screener.py` | 자산 규모·매집세력 강도 지수로 유망 3종목 선별 |
| `launch.ps1`, `launch.vbs` | 서버를 숨김 창으로 켜고 브라우저를 여는 런처 |

## 실행

```powershell
pip install fastapi "uvicorn[standard]" alpaca-trade-api yfinance pandas numpy pyjwt
pip install -U "websockets>=13" "urllib3>=2"   # alpaca-trade-api 설치 후 충돌 시
uvicorn api_server:app --port 8000
```

`http://localhost:8000`에 접속해 회원가입(이메일 또는 3~20자 아이디, 비밀번호 8자 이상) 후 로그인합니다.
`launch.vbs`를 더블클릭하면 서버 실행과 브라우저 열기를 한 번에 합니다. 이 파일의 바로가기를 바탕화면과 시작프로그램(`shell:startup`)에 두면 컴퓨터를 켤 때 자동 실행됩니다.

## 동작 규칙

- **자동 매매**: 에이전트 스위치를 ON으로 하면 5분마다 신호를 점검합니다. 수동 매수/매도 버튼은 없습니다. 상태는 `agent_state.json`에 저장되어 재시작해도 유지되며, 로그아웃이나 브라우저 종료와 무관하게 서버가 돌아가는 동안 계속됩니다. PC가 꺼지거나 절전이면 멈춥니다.
- **체결**: 한국 종목은 가상 체결 로그만 남깁니다. 미국 종목은 환경변수 `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`(Paper 키)가 있으면 Alpaca 모의 계좌로 주문하고, 없으면 내부 장부에만 기록합니다.
- **로그인**: JWT(HS256, 7일). 비밀번호는 scrypt 해시로 `users.db`에 저장하고, 서명 키는 `.jwt_secret`에 자동 생성합니다. 로그인 5회 실패 시 60초 잠금.
- **YOU**: 로그인 직후 먼저 인사하고 질문합니다. 규칙 기반이라 정해진 표현(종목명, 자산, 매매 내역, 추천, 에이전트 켜기/끄기)에 반응하며, 외부 AI 모델은 쓰지 않습니다.

## Git에 올리지 않는 파일

`users.db`, `.jwt_secret`, `agent_state.json`, `server.log`, `server.err`, `trader_state.json`, `trades.jsonl`은 로컬 운영 데이터와 비밀 값이라 `.gitignore`로 제외합니다.

## 한계

- 투자 권유가 아니며 가상 자금으로만 동작하는 학습용 프로젝트입니다.
- 실제 Alpaca 키 연동과 재부팅 후 자동 시작은 이 PC에서 끝까지 검증하지 않았습니다.
- 배포는 하지 않았고, 로컬(127.0.0.1) 전용입니다.
