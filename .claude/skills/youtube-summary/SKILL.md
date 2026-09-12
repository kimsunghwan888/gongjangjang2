---
name: youtube-summary
description: 유튜브 영상을 yt-dlp로 내려받고 자막을 뽑아 전체내용·요약 마크다운 두 개로 만든다. Whisper API로 더 정확히 받아적을 수도 있다. "영상 다운로드", "유튜브 받아줘", "자막 받아줘", "이 영상 요약/정리해줘", "음성으로 바꿔줘", "Whisper로 받아적어줘" 같은 요청에 사용.
version: 1.1
updated: 2026-09-12
---

# 유튜브 영상 받아서 요약하기

대상은 1954년생 비개발자 시니어. 쉬운 말로, 표와 짧은 문장으로.

## 순서

1. 영상 정보 확인 → 2. 영상 받기 → 3. 자막 받기 → 4. 마크다운 2개 작성 → 5. 주차 폴더에 저장

받아적기가 더 정확해야 하면 → **6. Whisper로 받아적기** (선택)

---

## 0. 준비 — 매번 PATH부터

새 PowerShell 창에서는 `yt-dlp`가 안 잡힌다. 명령 앞에 붙인다:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
```

설치·업데이트는 `winget install --id yt-dlp.yt-dlp -e` (ffmpeg가 같이 깔린다).

## 한글 출력은 콘솔에서 반드시 깨진다

PowerShell 결과를 그대로 읽으면 한글이 `����`로 나온다. `[Console]::OutputEncoding`을 바꿔도 안 된다.
→ **파일로 저장한 뒤 bash `cat`으로 읽는다.**

```powershell
yt-dlp --encoding utf-8 ... | Out-File -FilePath "<스크래치패드>\out.txt" -Encoding utf8
```
```bash
cat "<스크래치패드>/out.txt"
```

## 1. 영상 정보 확인

받기 전에 길이를 먼저 본다 (몇 시간짜리일 수 있다):

```powershell
yt-dlp --encoding utf-8 --skip-download --print "%(title)s|%(channel)s|%(duration)s|%(upload_date)s" "<URL>"
```

## 2. 영상 받기 — 반드시 H.264로

기본값으로 받으면 AV1로 내려와 **윈도우 기본 재생기에서 안 열린다.**

```powershell
yt-dlp -f "bestvideo[vcodec^=avc1][height<=720]+bestaudio[acodec^=mp4a]/best[ext=mp4]" --merge-output-format mp4 --no-progress --encoding utf-8 -o "<저장폴더>\%(title)s.%(ext)s" "<URL>"
```

확인 — `h264`가 나와야 한다:
```powershell
ffprobe -v error -show_entries stream=codec_name,width,height -show_entries format=duration -of default=noprint_wrappers=1 "<파일>"
```

## 3. 자막 받기

유튜브 자동 자막은 `ko`가 아니라 **`ko-orig`가 원본 한국어**다 (`ko`는 번역본).

```powershell
yt-dlp --skip-download --write-auto-subs --sub-langs "ko-orig" --convert-subs srt --encoding utf-8 --no-progress -o "<저장폴더>\%(title)s.%(ext)s" "<URL>"
```

- 먼저 `--list-subs`로 확인한다. 방송사가 직접 만든 자막이 없으면 `has no subtitles` + 자동 자막 목록만 나온다.
- 받은 뒤 `.ko-orig.srt` → 영상과 **같은 이름 `.srt`**로 바꾼다. 그래야 재생기가 자막을 자동으로 띄운다.
- 윈도우 기본 재생기는 외부 자막을 못 읽는다. VLC·곰플레이어를 안내한다.

## 4. 마크다운 2개

frontmatter에 `version`, `updated` 필수.

### 전체내용 — `<주제>-전체내용.md`

- 자막은 5초씩 토막 나 있다 → **문장 단위로 이어 붙여 문단으로** 만든다.
- 문단 앞에 `[00:34]` 식 시간 표시를 남긴다 (영상에서 그 대목을 찾기 쉽게).
- 자동 자막은 잘못 알아들은 말이 많다. **명백한 것만 고치고, 고친 목록을 맨 아래 표로 남긴다.** 내용을 지어내지 않는다.
- 맨 위에 출처·URL·길이와 "자동 자막이라 틀릴 수 있음" 경고.

### 요약 — `<주제>-요약.md`

- 맨 위에 **한 줄 요약**을 인용구(`>`)로.
- 핵심은 **표 3~5줄**로.
- 어려운 용어는 "배경 한마디"로 한 문장 설명.
- 맨 아래에 전체내용 파일 링크.

## 5. 저장 위치

`week-<주차>/<주제폴더>/` 에 영상·자막·마크다운을 함께 둔다.

## 6. Whisper로 받아적기 (선택)

유튜브 자동 자막보다 정확하다. 자막이 아예 없는 영상에도 쓸 수 있다.

**키** — `.claude/settings.local.json`의 `env.OPENAI_API_KEY`. 이 파일은 git 제외 대상이다.
**키를 화면에 찍지 않는다.** `echo "$KEY"` 금지. 파일에서 변수로만 꺼낸다.

```bash
KEY=$(sed -n 's/.*"OPENAI_API_KEY"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' .claude/settings.local.json)
[ -z "$KEY" ] && echo "키 없음 — 사용자에게 settings.local.json에 넣어달라고 안내"
```

### 6-1. 소리만 뽑기

```powershell
ffmpeg -y -i "<영상.mp4>" -vn -ac 1 -ar 16000 -codec:a libmp3lame -q:a 4 "<주제>.mp3"
```
2분 영상 8.4MB → 636KB. 한 시간짜리도 25MB 한도 안에 들어온다.

### 6-2. 보내기

한글 파일명은 curl에서 말썽이 난다 → **스크래치패드에 `audio.mp3`로 복사한 뒤** 보낸다.

```bash
curl -sS -w '\nHTTP_STATUS:%{http_code}\n' \
  https://api.openai.com/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F file="@<스크래치패드>/audio.mp3" \
  -F model=whisper-1 -F language=ko -F response_format=verbose_json \
  -o "<스크래치패드>/whisper.json"
```

- `verbose_json`이라야 구간별 시간(`segments[].start`)이 같이 온다. `text`만 필요하면 `-F response_format=text`.
- 파일 한도 **25MB**. 넘으면 `ffmpeg -f segment`로 잘라 여러 번 보낸다.
- 요금 1분당 약 0.006달러 (2분 ≈ 10원). 긴 영상이면 미리 알린다.

### 6-3. 결과 읽기

**이 PC의 `python`은 마이크로소프트 스토어 껍데기라 안 돌아간다.** 파워셸로 읽어 파일에 저장한 뒤 bash `cat`.

```powershell
$d = Get-Content -LiteralPath "<스크래치패드>\whisper.json" -Raw -Encoding utf8 | ConvertFrom-Json
$lines = foreach ($s in $d.segments) { "[{0:d2}:{1:d2}] {2}" -f [int][math]::Floor($s.start/60), [int][math]::Floor($s.start%60), $s.text.Trim() }
$lines | Out-File -FilePath "<스크래치패드>\segments.txt" -Encoding utf8
```

### 6-4. 마크다운 — `<주제>-Whisper전사.md`

- 본문은 **Whisper가 낸 그대로** 두고, 고치지 않는다. 틀린 곳은 아래 표로만 남긴다.
- 넣을 것: ① 이어지는 글 ② 시간 표시 표 ③ 틀린 곳 표 ④ 유튜브 자막과 비교 표

### 정확도 — 알고 있을 것

| | 결과 |
|---|---|
| Whisper가 나은 것 | 문장 나누기, 받침·조사 (군수지원**함**, **귀국**한) |
| 유튜브가 나은 것 | 가끔 있다 (**강도** 높게 → Whisper는 "양도") |
| **둘 다 약한 것** | **사람 이름** (조현→조연, 강희영→강연). 이름이 중요하면 사람이 확인하라고 안내한다 |

---

## 시행착오

- 파일명에 `[ ]`가 있으면 PowerShell `-Path`가 **실패**한다 → `Get-ChildItem -LiteralPath`, `Rename-Item -LiteralPath`를 쓴다.
- 유튜브 제목의 `"` `/`는 윈도우 파일명에 못 쓴다 → yt-dlp가 `＂` `⧸` 같은 비슷한 글자로 자동으로 바꾼다. 정상이다.
- 마크다운은 **Write 도구로** 쓴다. bash heredoc은 깨진다.
- 한글이 든 `.ps1` 스크립트 파일은 인코딩이 깨진다 (명령에 한글 경로를 넣는 건 괜찮다).
- `python`은 마이크로소프트 스토어 껍데기라 **안 돌아간다** (`python --version`이 "Python"만 찍고 끝난다). JSON은 파워셸 `ConvertFrom-Json`으로 읽는다.
- curl에 한글 파일명을 그대로 넘기지 않는다 → 스크래치패드에 **영문 이름으로 복사**한 뒤 보낸다.

## 영상 파일과 GitHub

`.mp4`는 크다. GitHub는 **50MB 넘으면 경고, 100MB 넘으면 거부**하고, 한 번 올리면 기록에 영원히 남아 저장소가 무거워진다.
→ 올리기 전에 사용자에게 묻는다. 보통 **영상은 빼고 `.md`·`.srt`만** 올린다.

## 저작권

개인 감상·학습용으로만 받는다. 다시 올리거나 배포하지 않도록 안내한다.
