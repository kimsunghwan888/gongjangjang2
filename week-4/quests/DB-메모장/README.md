---
version: 1.0.0
updated: 2026-09-17
---

# PostgreSQL 메모장

메모를 쓰고, 찾고, 고치고, 지운다. 내용은 PostgreSQL에 저장되어 서버를 껐다 켜도 남는다.

## 처음 한 번 설정

1. PostgreSQL에서 비밀번호를 충분히 길고 복잡하게 만든다.
2. 데이터베이스 `memo_app`을 만든다.
3. `.env.example`을 복사해 `.env`로 이름을 바꾼다.
4. `.env`의 `DATABASE_URL`에서 사용자 이름과 비밀번호를 채운다. 실제 주소는 절대 공유하거나 GitHub에 올리지 않는다.

## 실행

```powershell
npm install
npm start
```

브라우저에서 `http://localhost:3004`을 연다.

## 데이터베이스

서버를 처음 실행하면 `memos` 표가 자동으로 만들어진다.

| 칸 | 뜻 |
|---|---|
| `id` | 메모 번호 |
| `title` | 제목 |
| `content` | 내용 |
| `created_at` | 만든 시각 |

## API

| 방법 | 주소 | 하는 일 |
|---|---|---|
| GET | `/api/memos?search=단어` | 목록 또는 검색 |
| POST | `/api/memos` | 새 메모 저장 |
| PATCH | `/api/memos/:id` | 메모 고치기 |
| DELETE | `/api/memos/:id` | 메모 지우기 |