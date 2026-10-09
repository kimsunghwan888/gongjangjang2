"""FastAPI 서버: 매매 엔진(trader.py) 상태를 React 대시보드로 전달.

실행:
    pip install fastapi "uvicorn[standard]" alpaca-trade-api yfinance pandas numpy pyjwt
    (alpaca-trade-api 설치 후 충돌 시: pip install -U "websockets>=13" "urllib3>=2")
    uvicorn api_server:app --port 8000
    -> http://localhost:8000          (로그인/회원가입 화면, index.html 도 같은 서버에서 서빙)
    -> http://localhost:8000/docs     (API 문서)

모든 /api/* 는 JWT(Authorization: Bearer ...) 필요, /ws 는 ?token=JWT. 회원은 users.db(SQLite, scrypt 해시)에 저장.
환경변수(선택): ALPACA_API_KEY, ALPACA_SECRET_KEY (Paper 키), AGENT_ON=1, JWT_SECRET (없으면 .jwt_secret 자동 생성)
"""
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import screener
import trader

try:
    import alpaca_trade_api as tradeapi
except ImportError:
    tradeapi = None

BASE = Path(__file__).parent
PUSH_SEC = 5                 # WebSocket 푸시 / 시세 갱신 주기
DAILY_TTL = 300              # 일봉 캐시(초)
DIAG_TTL = 600               # 진단 캐시(초)

# ── 종목 (id는 프론트와 동일) ─────────────────
FIXED = [
    ("samsung", "삼성전자", "005930.KS", "KR"), ("hynix", "SK하이닉스", "000660.KS", "KR"),
    ("pharao", "파두", "440110.KQ", "KR"), ("googl", "구글", "GOOGL", "US"),
    ("aapl", "애플", "AAPL", "US"), ("tsla", "테슬라", "TSLA", "US"), ("amzn", "아마존", "AMZN", "US"),
]
RESEARCH = [  # 추천 3종목 (POST /api/research/refresh 로 screener 결과로 교체 가능)
    ("alteogen", "알테오젠", "196170.KQ", "KR", "바이오 추천"),
    ("isu", "이수페타시스", "007660.KS", "KR", "IT 추천"),
    ("medipost", "메디포스트", "078160.KQ", "KR", "줄기세포 추천"),
]
STOCKS = [{"id": i, "name": n, "ticker": t, "market": m, "group": "고정"} for i, n, t, m in FIXED] + \
         [{"id": i, "name": n, "ticker": t, "market": m, "group": g} for i, n, t, m, g in RESEARCH]

# ── 공유 상태 ─────────────────────────────────
lock = threading.RLock()
api = None
state = trader.load_state()
quotes = {}                  # ticker -> {price, prev, change, updated}
daily_cache = {}             # ticker -> (ts, df)
diag_cache = {}              # ticker -> (ts, dict)
AGENT_FILE = BASE / "agent_state.json"


def load_agent_on():
    if os.getenv("AGENT_ON") == "1":
        return True
    try:
        return bool(json.loads(AGENT_FILE.read_text(encoding="utf-8")).get("on"))
    except (OSError, ValueError):
        return False


def set_agent_on(on):
    engine["on"] = bool(on)
    try:
        AGENT_FILE.write_text(json.dumps({"on": engine["on"]}), encoding="utf-8")
    except OSError:
        pass


engine = {"on": load_agent_on(), "last_cycle": None, "error": None}
stop_evt = threading.Event()


def sync_watchlist():
    trader.WATCHLIST[:] = [(s["ticker"], s["market"]) for s in STOCKS]


def clean(v):
    """NaN/Inf/numpy 타입을 JSON 안전한 값으로."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    return None if f != f or f in (float("inf"), float("-inf")) else f


def get_daily(ticker, market):
    now = time.time()
    hit = daily_cache.get(ticker)
    if hit and now - hit[0] < DAILY_TTL:
        return hit[1]
    df = trader.load_daily(ticker, market, api)
    daily_cache[ticker] = (now, df)
    return df


# ── 백그라운드: 시세 갱신 ─────────────────────
def refresh_quotes():
    tickers = [s["ticker"] for s in STOCKS]
    data = yf.download(tickers, period="5d", group_by="ticker", progress=False, auto_adjust=True, threads=True)
    out = {}
    for s in STOCKS:
        t = s["ticker"]
        try:
            c = data[t]["Close"].dropna()
            price, prev = float(c.iloc[-1]), float(c.iloc[-2])
            if s["market"] == "US" and api is not None:
                try:
                    price = float(api.get_latest_trade(t, feed="iex").price)
                except Exception:
                    pass
            out[t] = {"price": price, "prev": prev, "change": (price / prev - 1) * 100,
                      "updated": datetime.now().isoformat(timespec="seconds")}
        except Exception:
            if t in quotes:
                out[t] = quotes[t]
    with lock:
        quotes.update(out)


def quote_loop():
    while not stop_evt.is_set():
        try:
            refresh_quotes()
        except Exception as e:
            print("[quotes]", e)
        stop_evt.wait(PUSH_SEC)


def engine_loop():
    while not stop_evt.is_set():
        if engine["on"]:
            try:
                with lock:
                    trader.run_cycle(api, state, False, False)
                engine["error"] = None
            except Exception as e:
                engine["error"] = str(e)
                print("[engine]", e)
            engine["last_cycle"] = datetime.now().isoformat(timespec="seconds")
            stop_evt.wait(trader.INTERVAL_SEC)
        else:
            stop_evt.wait(1)


# ── 집계 함수 ─────────────────────────────────
def read_trades(limit=100):
    if not trader.TRADE_LOG.exists():
        return []
    rows = []
    for line in trader.TRADE_LOG.read_text(encoding="utf-8").splitlines()[-limit:]:
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows[::-1]


def build_account():
    fx = trader.get_fx() if not hasattr(build_account, "fx") else build_account.fx
    build_account.fx = fx
    with lock:
        cash, realized = state["cash_krw"], state["realized_krw"]
        positions = []
        total = cash
        for sym, p in state["positions"].items():
            q = quotes.get(sym)
            px = (q["price"] * (fx if p["market"] == "US" else 1.0)) if q else p["avg_krw"]
            total += px * p["qty"]
            positions.append({"ticker": sym, "qty": p["qty"], "avg_krw": clean(p["avg_krw"]), "price_krw": clean(px),
                              "pnl_pct": clean((px / p["avg_krw"] - 1) * 100)})
        pending = [{k: p[k] for k in ("sym", "side", "qty", "done", "limit", "rule")} for p in state["pending"]]
    today = datetime.now().strftime("%Y-%m-%d")
    t_today = [t for t in read_trades(500) if t["t"].startswith(today)]
    return {"budget_krw": trader.BUDGET_KRW, "cash_krw": clean(cash), "total_krw": clean(total),
            "return_pct": clean((total / trader.BUDGET_KRW - 1) * 100), "realized_krw": clean(realized),
            "trades_today": len(t_today), "buys_today": sum(t["side"] == "buy" for t in t_today),
            "sells_today": sum(t["side"] == "sell" for t in t_today),
            "positions": positions, "pending": pending, "fx": clean(fx)}


def build_stocks():
    out = []
    with lock:
        for s in STOCKS:
            q = quotes.get(s["ticker"], {})
            out.append({**s, "price": clean(q.get("price")), "change": clean(q.get("change")),
                        "holding": s["ticker"] in state["positions"],
                        "diagnosis": (diag_cache.get(s["ticker"]) or (0, None))[1]})
    return out


def snapshot():
    return {"time": datetime.now().isoformat(timespec="seconds"),
            "agent": {"on": engine["on"], "last_cycle": engine["last_cycle"], "error": engine["error"],
                      "alpaca_connected": api is not None},
            "account": build_account(), "stocks": build_stocks(), "trades": read_trades(30)}


# ── 진단(점수/패턴/배열): 무거워서 캐시 ───────
def compute_diagnosis(stock):
    t, m = stock["ticker"], stock["market"]
    daily = get_daily(t, m)
    acc = screener.accumulation_index(t)
    wk, mo = trader.to_tf(daily, "W"), trader.to_tf(daily, "M")
    pat = trader.detect_bottom(mo, trader.BOTTOM_LOOKBACK["M"]) or trader.detect_bottom(wk, trader.BOTTOM_LOOKBACK["W"])
    d = trader.add_ma(daily).iloc[-1]
    ma5 = daily["Close"].rolling(5).mean().iloc[-1]
    ok_bull = d["Close"] > d["ma20"] > d["ma60"] > d["ma120"] if not d[["ma20", "ma60", "ma120"]].isna().any() else False
    ok_bear = d["Close"] < d["ma20"] < d["ma60"] < d["ma120"] if not d[["ma20", "ma60", "ma120"]].isna().any() else False
    return {"score": acc.get("score", 0), "vol_ratio": acc.get("vol_ratio"),
            "pattern": pat["pattern"] if pat else "없음", "pattern_detail": pat,
            "align": "정배열" if ok_bull else ("역배열" if ok_bear else "혼조"),
            "ma": {"ma5": clean(ma5), "ma20": clean(d["ma20"]), "ma60": clean(d["ma60"]), "ma120": clean(d["ma120"])},
            "buy_signal": trader.evaluate_buy(daily), "sell_signal": trader.evaluate_sell(daily)}


def diagnosis_loop():
    """종목을 순차 갱신 (yfinance 부하 분산)."""
    while not stop_evt.is_set():
        for s in list(STOCKS):
            if stop_evt.is_set():
                return
            hit = diag_cache.get(s["ticker"])
            if hit and time.time() - hit[0] < DIAG_TTL:
                continue
            try:
                diag_cache[s["ticker"]] = (time.time(), compute_diagnosis(s))
            except Exception as e:
                print(f"[diag {s['ticker']}]", e)
                diag_cache[s["ticker"]] = (time.time() - DIAG_TTL + 60, {"score": 0, "pattern": "없음", "align": "혼조", "error": str(e)})
            stop_evt.wait(1)
        stop_evt.wait(10)


# ── FastAPI ───────────────────────────────────
@asynccontextmanager
async def lifespan(_app):
    global api
    sync_watchlist()
    key, secret = os.getenv("ALPACA_API_KEY", "").strip(), os.getenv("ALPACA_SECRET_KEY", "").strip()
    if key and secret and tradeapi:
        api = tradeapi.REST(key, secret, base_url=trader.PAPER_URL, api_version="v2")
    for fn in (quote_loop, engine_loop, diagnosis_loop):
        threading.Thread(target=fn, daemon=True).start()
    yield
    stop_evt.set()


app = FastAPI(title="모의투자 에이전트 API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
                   allow_methods=["*"], allow_headers=["*"])


# ── 인증 (회원가입/로그인, JWT HS256) ─────────
DB_PATH = BASE / "users.db"
SECRET_FILE = BASE / ".jwt_secret"
TOKEN_DAYS = 7
USERNAME_RE = re.compile(r"^([A-Za-z0-9_가-힣]{3,20}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,})$")
fail_log = {}                # username -> (실패 횟수, 잠금 해제 시각)


def jwt_secret():
    env = os.getenv("JWT_SECRET", "").strip()
    if env:
        return env
    if not SECRET_FILE.exists():
        SECRET_FILE.write_text(secrets.token_hex(32))
    return SECRET_FILE.read_text().strip()


SECRET = jwt_secret()


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                 "username TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, created_at TEXT NOT NULL)")
    return conn


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return f"{salt.hex()}:{h.hex()}"


def verify_pw(pw, stored):
    salt_hex, h_hex = stored.split(":")
    h = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt_hex), n=2 ** 14, r=8, p=1, dklen=32)
    return hmac.compare_digest(h.hex(), h_hex)


def make_token(uid, username):
    exp = datetime.now(timezone.utc) + timedelta(days=TOKEN_DAYS)
    return jwt.encode({"sub": str(uid), "name": username, "exp": exp}, SECRET, algorithm="HS256")


def decode_token(token):
    try:
        return jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


@app.middleware("http")
async def require_auth(request: Request, call_next):
    p = request.url.path
    if p.startswith("/api/") and not p.startswith("/api/auth/") and request.method != "OPTIONS":
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer ") or not decode_token(auth[7:].strip()):
            return JSONResponse({"success": False, "message": "로그인이 필요합니다"}, status_code=401)
    return await call_next(request)


class AuthBody(BaseModel):
    username: str
    password: str


@app.post("/api/auth/register", status_code=201)
def auth_register(body: AuthBody):
    name, pw = body.username.strip(), body.password
    if not USERNAME_RE.match(name):
        raise HTTPException(400, "아이디는 3~20자의 한글/영문/숫자/_ 만 가능합니다")
    if len(pw) < 8 or len(pw) > 128:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 합니다")
    with db() as conn:
        try:
            cur = conn.execute("INSERT INTO users (username, pw, created_at) VALUES (?, ?, ?)",
                               (name, hash_pw(pw), datetime.now().isoformat(timespec="seconds")))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "이미 사용 중인 아이디입니다")
    return {"success": True, "data": {"token": make_token(cur.lastrowid, name), "username": name}}


@app.post("/api/auth/login")
def auth_login(body: AuthBody):
    name = body.username.strip()
    cnt, until = fail_log.get(name, (0, 0))
    if until > time.time():
        raise HTTPException(429, f"로그인 시도가 너무 많습니다. {int(until - time.time())}초 후 다시 시도하세요")
    with db() as conn:
        row = conn.execute("SELECT id, username, pw FROM users WHERE username = ?", (name,)).fetchone()
    ok = bool(row) and verify_pw(body.password, row["pw"])
    if not row:
        raise HTTPException(404, "가입되지 않은 아이디예요. 회원가입 탭에서 먼저 가입해 주세요")
    if not ok:
        cnt += 1
        fail_log[name] = (cnt, time.time() + 60 if cnt >= 5 else 0)
        raise HTTPException(401, "비밀번호가 올바르지 않습니다")
    fail_log.pop(name, None)
    return {"success": True, "data": {"token": make_token(row["id"], row["username"]), "username": row["username"]}}


@app.get("/api/auth/me")
def auth_me(request: Request):
    payload = decode_token(request.headers.get("authorization", "")[7:].strip())
    if not payload:
        raise HTTPException(401, "토큰이 유효하지 않습니다")
    return {"success": True, "data": {"username": payload["name"]}}


@app.exception_handler(HTTPException)
async def http_exc(_req, exc: HTTPException):
    return JSONResponse({"success": False, "message": exc.detail}, status_code=exc.status_code)


def find_stock(key):
    for s in STOCKS:
        if key in (s["id"], s["ticker"]):
            return s
    raise HTTPException(404, f"종목 없음: {key}")


@app.get("/api/snapshot")
def api_snapshot():
    """5초 폴링용 통합 응답: agent / account / stocks / trades."""
    return {"success": True, "data": snapshot()}


@app.get("/api/stocks")
def api_stocks():
    return {"success": True, "data": build_stocks()}


@app.get("/api/account")
def api_account():
    return {"success": True, "data": build_account()}


@app.get("/api/trades")
def api_trades(limit: int = Query(100, ge=1, le=500)):
    return {"success": True, "data": read_trades(limit)}


@app.get("/api/diagnosis/{key}")
def api_diagnosis(key: str):
    s = find_stock(key)
    hit = diag_cache.get(s["ticker"])
    if not hit:
        hit = (time.time(), compute_diagnosis(s))
        diag_cache[s["ticker"]] = hit
    return {"success": True, "data": hit[1]}


@app.get("/api/chart/{key}")
def api_chart(key: str, tf: str = Query("day", pattern="^(day|week|month)$")):
    """차트용 OHLCV + 이동평균(20/60/120) + 매매 마커(실제 체결 + 규칙 재현 신호)."""
    s = find_stock(key)
    daily = get_daily(s["ticker"], s["market"])
    show = {"day": 120, "week": 104, "month": 60}[tf]
    bars = trader.add_ma(daily) if tf == "day" else trader.to_tf(daily, "W" if tf == "week" else "M")
    view = bars.tail(show)
    candles = [{"date": idx.strftime("%Y-%m-%d"), "open": clean(r.Open), "high": clean(r.High), "low": clean(r.Low),
                "close": clean(r.Close), "volume": clean(r.Volume), "ma20": clean(r.ma20), "ma60": clean(r.ma60),
                "ma120": clean(r.ma120)} for idx, r in view.iterrows()]
    signals, last = [], -99
    for i in range(20, len(view)):
        r, p = view.iloc[i], view.iloc[i - 1]
        if i - last < 6 or pd.isna(r.ma20) or pd.isna(p.ma20):
            continue
        if r.Close > view["Close"].iloc[i - 20:i].max() and r.Close > r.ma20:
            signals.append({"date": view.index[i].strftime("%Y-%m-%d"), "type": "buy", "why": "신고가 돌파"}); last = i
        elif p.Close >= p.ma20 and r.Close < r.ma20:
            signals.append({"date": view.index[i].strftime("%Y-%m-%d"), "type": "sell", "why": "20선 이탈"}); last = i
    fills = [{"date": t["t"][:10], "type": t["side"], "price": t["price"], "rule": t["rule"]}
             for t in read_trades(500) if t["sym"] == s["ticker"]]
    return {"success": True, "data": {"ticker": s["ticker"], "tf": tf, "candles": candles,
                                      "signals": signals, "fills": fills}}


class AgentBody(BaseModel):
    on: bool


@app.post("/api/agent")
def api_agent(body: AgentBody):
    """에이전트 ON/OFF (ON이면 trader.run_cycle 이 주기적으로 돈다)."""
    set_agent_on(body.on)
    return {"success": True, "data": {"on": engine["on"]}}


@app.post("/api/research/refresh")
def api_research_refresh():
    """screener.pick_top3() 결과로 추천 3종목 교체 (수 분 걸릴 수 있어 백그라운드 실행)."""
    def job():
        try:
            picks = screener.pick_top3()
            if len(picks) < 3:
                return
            groups = ["바이오 추천", "IT 추천", "줄기세포 추천"]
            new = []
            for tk, g in zip(picks, groups):
                name = yf.Ticker(tk).info.get("shortName") or tk
                new.append({"id": tk.lower().replace(".", "_"), "name": name, "ticker": tk,
                            "market": "KR" if tk.endswith((".KS", ".KQ")) else "US", "group": g})
            with lock:
                STOCKS[7:10] = new
                sync_watchlist()
        except Exception as e:
            print("[research]", e)
    threading.Thread(target=job, daemon=True).start()
    return {"success": True, "message": "스크리닝을 시작했습니다. 완료되면 /api/stocks 에 반영됩니다."}


# ── 대화형 어시스턴트 YOU (규칙 기반) ─────────
def won(v):
    return f"{v:,.0f}원" if v is not None else "-"


def sg(label, send):
    return {"label": label, "send": send}


def describe_stock(s):
    d = (diag_cache.get(s["ticker"]) or (0, None))[1]
    q = quotes.get(s["ticker"], {})
    unit = "$" if s["market"] == "US" else "₩"
    head = f"**{s['name']}** ({s['ticker']}) 현재가 {unit}{q.get('price', 0):,.2f}, 전일대비 {q.get('change', 0):+.2f}%."
    if not d or "error" in d:
        return head + " 정밀 진단을 계산 중이에요. 잠시 후 다시 물어봐 주세요."
    lines = [head, f"매집 세력 점수 {d['score']}점 · 바닥 패턴 {d['pattern']} · {d['align']}."]
    if d.get("buy_signal"):
        lines.append(f"🔔 매수 신호: {d['buy_signal']['why']}")
    if d.get("sell_signal"):
        lines.append(f"⚠️ 매도 신호: {d['sell_signal']['why']}")
    if not d.get("buy_signal") and not d.get("sell_signal"):
        lines.append("지금 발생한 매매 신호는 없어요.")
    return "\n".join(lines)


def assistant_reply(msg):
    m = msg.strip()
    low = m.lower()
    if m in ("__confirm_on", "__confirm_off"):
        set_agent_on(m == "__confirm_on")
        return {"reply": "에이전트를 가동했어요. 5분마다 신호를 점검하고 조건이 맞으면 모의 주문을 낼게요." if engine["on"]
                else "에이전트를 정지했어요. 신규 주문은 나가지 않아요.",
                "suggestions": [sg("자산 현황 보여줘", "자산 현황"), sg("오늘 매매 내역", "매매 내역")], "refresh": True}

    for s in STOCKS:
        if s["name"] in m or s["ticker"].lower() in low or s["ticker"].split(".")[0].lower() in low.split():
            return {"reply": describe_stock(s),
                    "suggestions": [sg("다른 종목은?", "유망 종목 추천해줘"), sg("내 자산은?", "자산 현황")]}

    if re.search(r"켜|가동|시작", m) and "에이전트" in m:
        return {"reply": "에이전트를 가동할까요? 켜면 조건 충족 시 모의 주문이 자동으로 나갑니다.",
                "suggestions": [sg("네, 가동해줘", "__confirm_on"), sg("아니요", "취소")]}
    if re.search(r"꺼|정지|멈", m) and "에이전트" in m:
        return {"reply": "에이전트를 정지할까요?", "suggestions": [sg("네, 정지해줘", "__confirm_off"), sg("아니요", "취소")]}

    if re.search(r"자산|수익|잔고|얼마|계좌", m):
        a = build_account()
        pos = ", ".join(f"{p['ticker']} {p['qty']}주" for p in a["positions"]) or "없음"
        return {"reply": f"총 자산 {won(a['total_krw'])} (수익률 {a['return_pct']:+.2f}%), 현금 {won(a['cash_krw'])}, "
                         f"실현손익 {won(a['realized_krw'])}이에요.\n보유 종목: {pos}",
                "suggestions": [sg("오늘 매매 내역", "매매 내역"), sg("유망 종목 추천해줘", "유망 종목")]}
    if re.search(r"매매|로그|거래|체결|내역", m):
        t = read_trades(5)
        if not t:
            return {"reply": "아직 체결된 거래가 없어요. 에이전트가 신호를 기다리는 중이에요.",
                    "suggestions": [sg("에이전트 켜줘", "에이전트 켜줘"), sg("유망 종목", "유망 종목")]}
        rows = "\n".join(f"{x['t'][5:16]} {x['sym']} {'매수' if x['side'] == 'buy' else '매도'} {x['qty']}주 ({x['rule']})" for x in t)
        return {"reply": "최근 거래예요.\n" + rows, "suggestions": [sg("자산 현황", "자산 현황")]}
    if re.search(r"추천|유망|뭐 ?살|후보|점수", m):
        ds = [(s, (diag_cache.get(s["ticker"]) or (0, None))[1]) for s in STOCKS]
        ds = sorted([(s, d) for s, d in ds if d and "error" not in d], key=lambda x: -x[1]["score"])[:3]
        if not ds:
            return {"reply": "아직 종목 진단을 계산 중이에요. 1~2분 뒤에 다시 물어봐 주세요.", "suggestions": [sg("자산 현황", "자산 현황")]}
        rows = "\n".join(f"{i + 1}. {s['name']} — 매집 점수 {d['score']} · {d['pattern']} · {d['align']}" for i, (s, d) in enumerate(ds))
        return {"reply": "지금 매집 점수가 높은 종목이에요.\n" + rows,
                "suggestions": [sg(f"{ds[0][0]['name']} 자세히", ds[0][0]["name"])]}
    if re.search(r"안녕|도움|help|뭐 ?할|할 ?수", low):
        return {"reply": "저는 YOU예요. 자산·매매 내역 요약, 종목 진단, 유망 종목 추천, 에이전트 ON/OFF를 도와드려요.",
                "suggestions": [sg("자산 현황", "자산 현황"), sg("유망 종목", "유망 종목"), sg("매매 내역", "매매 내역")]}
    return {"reply": "음, 잘 이해하지 못했어요. 이런 건 어떠세요?",
            "suggestions": [sg("자산 현황", "자산 현황"), sg("유망 종목", "유망 종목"), sg("매매 내역", "매매 내역"),
                            sg("에이전트 켜줘" if not engine["on"] else "에이전트 꺼줘", "에이전트 켜줘" if not engine["on"] else "에이전트 꺼줘")]}


class ChatBody(BaseModel):
    message: str


@app.post("/api/assistant")
def api_assistant(body: ChatBody):
    return {"success": True, "data": assistant_reply(body.message[:200])}


@app.get("/api/assistant/briefing")
def api_briefing(request: Request):
    """로그인 직후 YOU가 먼저 건네는 말과 질문."""
    name = decode_token(request.headers.get("authorization", "")[7:].strip())["name"]
    h = datetime.now().hour
    greet = "좋은 아침이에요" if h < 12 else ("좋은 오후예요" if h < 18 else "좋은 저녁이에요")
    a = build_account()
    msgs = [f"{greet}, {name}님. 저는 YOU, 당신의 모의투자 파트너예요.",
            f"가상 자금 {won(a['budget_krw'])} 중 현재 총 자산은 {won(a['total_krw'])}({a['return_pct']:+.2f}%)이에요."]
    ds = [(s, (diag_cache.get(s["ticker"]) or (0, None))[1]) for s in STOCKS]
    ds = sorted([(s, d) for s, d in ds if d and "error" not in d], key=lambda x: -x[1]["score"])
    sugg = []
    if ds:
        s, d = ds[0]
        msgs.append(f"지금 가장 눈에 띄는 종목은 **{s['name']}**(매집 점수 {d['score']})이에요. 자세히 볼까요?")
        sugg.append(sg(f"네, {s['name']} 알려줘", s["name"]))
    else:
        msgs.append("종목 진단을 계산 중이에요. 잠시 뒤에 물어봐 주세요.")
    sugg.append(sg("자산 현황", "자산 현황"))
    sugg.append(sg("에이전트 켜줄까요?" if not engine["on"] else "에이전트 상태 괜찮나요?", "에이전트 켜줘" if not engine["on"] else "자산 현황"))
    return {"success": True, "data": {"messages": msgs, "suggestions": sugg}}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """연결 즉시 + 5초마다 snapshot 푸시. ?token=JWT 필요."""
    if not decode_token(ws.query_params.get("token", "")):
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        while True:
            await ws.send_json(await asyncio.to_thread(snapshot))
            await asyncio.sleep(PUSH_SEC)
    except (WebSocketDisconnect, RuntimeError):
        pass


@app.get("/")
def index():
    return FileResponse(BASE / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
