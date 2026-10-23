---
version: 1.0
updated: 2026-10-23
---

# 뉴스 릴스 공장 (VitaNoa)

매일 18:30 영상 만들기 → 19:20 인스타·페이스북 릴스 게시 (작업 스케줄러 `week7-news-make`, `week7-news-post`).

## 파일

| 파일 | 역할 |
|---|---|
| `server.js` | 전부 담당 (뉴스 → 대본 → 영상 → 게시 → 관리 화면) |
| `index.html` | 관리 화면 (`node server.js` 후 http://localhost:3000) |
| `register-tasks.ps1` / `run-task.ps1` | 매일 자동 실행 등록 / 화면 없이 실행하는 도우미 |
| `bg\` | 내 무료 스톡 영상(mp4) 넣는 곳 |

## 만드는 순서

1. 뉴스 모으기 (NewsAPI · NewsData · GNews, 키 없으면 구글뉴스 무료)
2. 요약·대본 (Gemini → 안 되면 claude)
3. **1단계 배경 영상**: fal.ai AI 영상 → `bg\` 영상 → 기사 사진 → 색 그라데이션 (순서대로 시도)
4. **2단계**: Edge-TTS 목소리 + 큰 자막 카드 + 효과음(FFmpeg 합성) + 하단 `VitaNoa`

## 직접 해야 할 일

| 환경변수 | 용도 | 없으면 |
|---|---|---|
| `NEWSAPI_KEY` `NEWSDATA_KEY` `GNEWS_KEY` | 뉴스 3곳 | 구글뉴스 무료로 대체 |
| `FAL_KEY` (+ `FAL_MODEL`) | AI 배경 영상 | 그라데이션 배경 |
| `META_ACCESS_TOKEN` `IG_USER_ID` `FB_PAGE_ID` | 인스타·페이스북 게시 | **게시 안 됨** (방법: week7quest1\auto\SETUP.md) |

- 점검: `node server.js --post --dry-run`
- 직접 영상 받기: 관리 화면 또는 `yt-dlp`로 `bg\`에 저장 (저작권은 본인 책임)

## 알아둘 점

- 길이는 항상 19초. 방송국·언론사 이름은 넣지 않음. 바탕 연소라·연핑크, VitaNoa 흰 글씨+소라 바탕.
- 본문에 없는 숫자는 자동 제외. 실존 인물 얼굴은 AI 영상에 쓰지 않고 상징물(국기·자유의 여신상 등)로 표현.
- 시행착오: 크롬 캡처 폭이 360px보다 넓게 잡혀 자막이 잘림 → 360×640 틀 안에 배치해 해결.
- 시행착오: Whisk는 공식 연결 방법이 없어 자동화 제외 (손으로 만든 이미지/영상은 `bg\`에 넣기).
- 시행착오: fal 모델 이름은 시험 못 함 (키 없음). 안 되면 `FAL_MODEL`을 바꿔 보기.
- 컴퓨터가 켜져 있어야 실행됩니다.
- 키 보관: 이 컴퓨터 사용자 환경변수에만 저장. 관리 화면의 "키 저장"으로 넣을 수 있고, 값은 화면에 다시 보이지 않음. 이 컴퓨터(localhost)에서만 접속 가능.
- fal 키는 등록됨. 단 **잔액 소진(403)** 상태라 fal.ai/dashboard/billing 에서 충전해야 AI 배경이 생성됨. 모델 이름은 `fal-ai/bytedance/seedance/v1/lite/text-to-video` (`bytedance/...`만 쓰면 404).
- 시행착오: 작업 스케줄러에서 cmd로 직접 실행하면 시작 직후 Ctrl+C로 종료됨(결과 3221225786) → `run-task.ps1`(숨김 실행)로 해결.
