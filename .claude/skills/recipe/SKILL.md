---
name: recipe
description: 레시피를 만들어 레시피북 폴더에 저장하고, 큰 글자 웹페이지로 발행하고, GitHub에 올린다. "레시피", "저녁 메뉴", "○○분 요리", "레시피북에 저장", "레시피 고쳐줘" 같은 요청에 사용.
---

# 레시피 만들기

대상은 1954년생 비개발자 시니어. 한 눈에 읽히게, 쉬운 말로. 조리 전문 용어 금지.

## 순서

1. 본문 작성 → 2. 사진 구하기 → 3. 마크다운 저장 → 4. 웹페이지 발행 → 5. 커밋·push

---

## 1. 본문 규칙

- **시간이 뼈대다.** 단계를 소요 시간으로 쪼갠다 (`0–5분`, `5–9분`, `9–13분`, `13–15분`).
- 재료는 **"꼭 필요한 것" / "있으면 좋은 것"** 두 갈래.
- 사용자가 직접 해보고 알려준 요령은 ⭐와 날짜를 붙여 요령 맨 위에 둔다.
  (예: 김치참치 덮밥 + 칠리소스, 2026-08-29)
- 사용자는 매콤달콤한 소스를 좋아한다. 곁들임 선택지를 하나 넣어주면 좋다.

## 2. 사진 — 위키미디어 공용

검색:
```bash
curl -s "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=<영문요리명>&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|size&iiurlwidth=900&format=json" | tr ',' '\n' | grep -E '"title"|thumburl'
```

라이선스 확인 — **CC BY 또는 CC BY-SA만 사용**:
```bash
curl -s "https://commons.wikimedia.org/w/api.php?action=query&titles=File:<파일명>&prop=imageinfo&iiprop=extmetadata&format=json" | tr '{},' '\n' | grep -iE 'LicenseShortName|Artist|"value"'
```

내려받기 — **User-Agent를 브라우저처럼 줘야 한다.** 기본 UA면 403 에러 HTML이 내려온다:
```bash
curl -s -L -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -o dish.jpg "<thumburl의 960px 주소>"
file dish.jpg      # JPEG 인지 반드시 확인. HTML이면 실패한 것
```

Read 도구로 사진을 눈으로 확인한 뒤 쓴다. 출처(파일명·촬영자·라이선스·Wikimedia Commons)를 문서와 페이지 양쪽에 남긴다.

### 삽화가 필요할 때

`.claude/settings.local.json`의 `env.IMAGE_API_KEY`를 환경변수로 읽는다. 이 파일은 git에서 제외되어 있으니 **키를 다른 파일·커밋·아티팩트·화면 출력에 절대 옮기지 않는다.**

```bash
if [ -n "$IMAGE_API_KEY" ]; then
  # 키 있음 → 이미지 생성 API 호출. 키는 헤더로만 넘기고 echo 하지 않는다
  curl -s -H "x-goog-api-key: $IMAGE_API_KEY" ...
else
  # 키 없음 → SVG로 직접 그린다
fi
```

키가 비어 있으면 SVG로 직접 그린다. 저작권 있는 캐릭터는 그리지 않고 분위기만 살린다.

> 아직 어느 서비스를 쓸지 정해지지 않았다. 사용자가 서비스를 알려주면 변수 이름(`IMAGE_API_KEY`)과 위 `curl` 헤더를 그 서비스에 맞게 바꾼다.

## 3. 마크다운 저장

- 경로: `레시피북/<요리이름>.md` · 그림은 `레시피북/assets/`
- frontmatter에 `version`, `updated` 필수. 고칠 때마다 올린다.
- 재료·순서는 표로. 결론만 적는다.

## 4. 웹페이지 (Artifact)

`artifact-design` 스킬을 먼저 읽는다.

**아티팩트는 외부 이미지를 못 불러온다** (CSP 차단). 사진은 base64로 심어야 한다. base64를 프롬프트에 직접 넣을 수 없으니 조각내서 합친다:

```bash
base64 -w0 dish.jpg > dish.b64
# head.html은 <img src="data:image/jpeg;base64,  에서 끝낸다
{ printf '%s' "$(cat head.html)"; tr -d '\n\r' < dish.b64; cat tail.html; } > recipe.html
```
`$(cat ...)`가 끝의 줄바꿈을 없앤다. 줄바꿈이 남으면 data URI가 깨진다. 합친 뒤 `grep -c 'base64,/9j/'`로 확인.

**디자인 기준** (기존 레시피와 통일):

| 항목 | 값 |
|---|---|
| 본문 글자 | 20px / 줄간 1.8 (시니어용으로 크게) |
| 글꼴 | 제목 Gowun Batang · 본문 Noto Sans KR · 숫자 IBM Plex Mono |
| 강조색 | `#BE3423` (밝을 때) / `#F0705A` (어두울 때) |
| 단계 | 왼쪽 시간 축 — 점 + 세로선 |
| 화면 | 밝은 화면·어두운 화면 둘 다 처리 |

### 시행착오

- 긴 HTML을 bash heredoc으로 쓰면 따옴표 때문에 깨진다 → **Write 도구로 파일에 쓴다.**
- SVG 삽화는 따로 파일로 만든 뒤 끼워 넣는다: `sed -e '/__SCENE__/r scene.svg' -e '/__SCENE__/d' head.html > head2.html`
- 사진을 다시 받았으면 **base64도 다시 만들어야 한다.** 안 하면 옛 파일이 들어가 이미지가 안 보인다.

## 5. 저장·올리기

```bash
git add -A && git commit && git push
```

- 저장소: `kimsunghwan888/gongjangjang2` (공개)
- 커밋 이메일은 가림 주소로 이미 설정됨. 실제 이메일이 들어가지 않게 유지한다.
- GitHub 저장소 이름에는 **한글을 못 쓴다.** 넣으면 글자가 지워진다.
