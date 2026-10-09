"""기술적 지표 분석 + 자동 매매 코어 (모의투자 전용).

- 미국: Alpaca Paper API(tradeapi.REST) 시세 + 주문 (IEX 무료 피드)
- 한국: yfinance 시세 + 모의 매매 로그(실주문 없음)
- 가상 자금 1,000만원(KRW) 한도를 내부 장부(trader_state.json)로 관리 (미국은 환율로 환산)
- 시세/차트는 모두 실제 데이터

사전 준비:
    pip install alpaca-trade-api yfinance pandas numpy
    set ALPACA_API_KEY=...      (PowerShell: $env:ALPACA_API_KEY="...")
    set ALPACA_SECRET_KEY=...   (Alpaca 대시보드의 *Paper* 키)

실행:
    python trader.py --once --dry     # 신호만 계산해서 출력 (주문 없음)
    python trader.py --once           # 1회 실행 (장중일 때만 평가)
    python trader.py                  # 5분 간격 무한 루프
    python trader.py --force          # 장 마감 시간에도 평가 (테스트용)
"""
import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

try:
    import alpaca_trade_api as tradeapi
    from alpaca_trade_api.rest import TimeFrame, TimeFrameUnit
except ImportError:  # 한국 주식만 돌릴 때는 없어도 됨
    tradeapi = None

# ── 설정 ──────────────────────────────────────
BUDGET_KRW = 10_000_000          # 가상 투자금 1,000만원
MAX_POS_PCT = 0.20               # 종목당 최대 비중
FX_FALLBACK = 1400.0
INTERVAL_SEC = 300
PAPER_URL = "https://paper-api.alpaca.markets"
STATE_FILE = Path(__file__).with_name("trader_state.json")
TRADE_LOG = Path(__file__).with_name("trades.jsonl")

# (티커, 시장)
WATCHLIST = [
    ("GOOGL", "US"), ("AAPL", "US"), ("TSLA", "US"), ("AMZN", "US"),
    ("005930.KS", "KR"), ("000660.KS", "KR"), ("440110.KQ", "KR"),
]

# (바닥 패턴을 보는 봉, 20선 돌파를 보는 봉): 월봉 바닥 -> 주봉 20선 / 주봉 바닥 -> 월봉 20선
CROSS_PAIRS = [("M", "W"), ("W", "M")]
BOTTOM_LOOKBACK = {"W": 80, "M": 48}       # 바닥 탐색 구간(봉 수)
HIGH_LOOKBACK = {"W": 52, "M": 24}         # 신고가 기준 구간
DECLINE_MIN = 0.20                         # 바닥 전 최소 하락폭
BOTTOM_TOL = 0.06                          # 저점끼리 허용 오차
RALLY_MIN = 0.08                           # 저점 사이 최소 반등폭
CRASH_PCT = 0.05                           # 급락 기준(일 등락률)


# ── 유틸 ──────────────────────────────────────
def log(msg):
    print(f"[{datetime.now().strftime('%m-%d %H:%M:%S')}] {msg}", flush=True)


def get_fx():
    try:
        v = yf.Ticker("KRW=X").history(period="5d")["Close"].dropna().iloc[-1]
        return float(v)
    except Exception:
        return FX_FALLBACK


# ── 데이터 ────────────────────────────────────
def _norm(df):
    df = df.rename(columns=str.capitalize)[["Open", "High", "Low", "Close", "Volume"]]
    return df.dropna(subset=["Close"])


def load_daily(sym, market, api):
    """일봉 약 12년치. 미국은 Alpaca(IEX), 실패 시 yfinance로 대체."""
    if market == "US" and api is not None:
        try:
            start = (datetime.now(timezone.utc) - timedelta(days=365 * 12)).strftime("%Y-%m-%d")
            df = api.get_bars(sym, TimeFrame.Day, start=start, adjustment="split", feed="iex").df
            if not df.empty:
                df.index = df.index.tz_convert("America/New_York").tz_localize(None).normalize()
                return _norm(df)
        except Exception as e:
            log(f"[{sym}] Alpaca 일봉 실패 -> yfinance 대체: {e}")
    df = yf.Ticker(sym).history(period="12y", auto_adjust=True)
    if df.index.tz is not None:
        df.index = df.index.tz_localize(None)
    return _norm(df)


def load_intraday(sym, market, api):
    """가장 최근 거래일의 5분봉."""
    if market == "US" and api is not None:
        start = (datetime.now(timezone.utc) - timedelta(days=4)).isoformat()
        df = api.get_bars(sym, TimeFrame(5, TimeFrameUnit.Minute), start=start, feed="iex").df
        df.index = df.index.tz_convert("America/New_York")
    else:
        df = yf.Ticker(sym).history(period="5d", interval="5m")
        if df.index.tz is not None:
            df.index = df.index.tz_convert("Asia/Seoul")
    df = _norm(df)
    return df[df.index.date == df.index[-1].date()]


def last_price(sym, market, api, daily=None):
    if market == "US" and api is not None:
        try:
            return float(api.get_latest_trade(sym, feed="iex").price)
        except Exception:
            pass
    if daily is not None and len(daily):
        return float(daily["Close"].iloc[-1])
    return float(yf.Ticker(sym).history(period="5d")["Close"].dropna().iloc[-1])


def to_tf(daily, tf):
    """일봉 -> 주봉(W)/월봉(M) + 이동평균(20/60/120)."""
    rule = {"W": "W-FRI", "M": "ME"}[tf]
    try:
        g = daily.resample(rule)
    except ValueError:                       # 구버전 pandas
        g = daily.resample("M" if tf == "M" else rule)
    bars = g.agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
    return add_ma(bars.dropna(subset=["Close"]))


def add_ma(df):
    df = df.copy()
    for n in (20, 60, 120):
        df[f"ma{n}"] = df["Close"].rolling(n).mean()
    return df


# ── 패턴 탐지 ─────────────────────────────────
def swing_points(values, order, kind):
    """좌우 order개 봉보다 낮은(low)/높은(high) 지점의 위치 목록."""
    out, n = [], len(values)
    better = (lambda a, b: a < b) if kind == "low" else (lambda a, b: a > b)
    for i in range(order, n - order):
        win = values[i - order:i + order + 1]
        ext = win.min() if kind == "low" else win.max()
        if values[i] != ext:
            continue
        if out and i - out[-1] <= order:
            if better(values[i], values[out[-1]]):
                out[-1] = i
        else:
            out.append(i)
    return out


def detect_bottom(bars, lookback, order=2):
    """완바닥/쌍바닥/다중바닥 + 세력 매집 확인. 없으면 None."""
    w = bars.iloc[-lookback:]
    if len(w) < 24:
        return None
    start = len(bars) - len(w)
    low, high, close = w["Low"].values, w["High"].values, w["Close"].values
    lows = swing_points(low, order, "low")
    if not lows:
        return None
    base = min(low[i] for i in lows)
    cand = [i for i in lows if low[i] <= base * (1 + BOTTOM_TOL)]

    chosen = [cand[0]]
    for i in cand[1:]:
        if high[chosen[-1]:i].max() >= base * (1 + RALLY_MIN):   # 사이에 의미있는 반등이 있어야 별개 바닥
            chosen.append(i)
    first = chosen[0]

    pre_from = max(0, start + first + 1 - lookback)
    pre_high = bars["High"].iloc[pre_from:start + first + 1].max()
    if pre_high < base * (1 + DECLINE_MIN):                       # 직전 하락 없음
        return None
    if close[-1] > base * 1.5:                                    # 이미 많이 오름
        return None

    n = len(chosen)
    if n >= 3:
        name = "다중바닥"
    elif n == 2:
        name = "쌍바닥"
    else:
        basin = int((low[first:] <= base * 1.08).sum())           # 저점권에서 오래 머문 둥근 바닥
        if basin < 5:
            return None
        name = "완바닥"

    zone, prior = w.iloc[first:], w.iloc[:first]
    chg = zone["Close"].diff()
    up_v = zone["Volume"][chg > 0].sum()
    dn_v = zone["Volume"][chg < 0].sum()
    ud = up_v / dn_v if dn_v > 0 else 2.0
    pv = prior["Volume"].mean() if len(prior) >= 3 else 0
    vr = zone["Volume"].mean() / pv if pv > 0 else 1.0
    return {"pattern": name, "low": float(base), "up_down_vol": round(float(ud), 2),
            "vol_ratio": round(float(vr), 2), "accumulation_ok": bool(ud >= 1.1 and vr >= 0.9)}


def crossed_above_ma20(bars):
    if len(bars) < 21 or pd.isna(bars["ma20"].iloc[-1]) or pd.isna(bars["ma20"].iloc[-2]):
        return False
    return bars["Close"].iloc[-2] < bars["ma20"].iloc[-2] and bars["Close"].iloc[-1] >= bars["ma20"].iloc[-1]


def is_uptrend(bars):
    r = bars.iloc[-1]
    if pd.isna(r["ma20"]) or pd.isna(r["ma60"]):
        return False
    ok = r["Close"] > r["ma20"] > r["ma60"]
    if not pd.isna(r["ma120"]):
        ok = ok and r["ma60"] > r["ma120"]
    return bool(ok)


def breakout_high(bars, tf):
    """상승장에서 직전 스윙 고점 돌파 또는 신고가. 설명 문자열 또는 None."""
    if len(bars) < 30:
        return None
    c, h = bars["Close"].values, bars["High"].values
    look = HIGH_LOOKBACK[tf]
    if c[-1] > h[-look - 1:-1].max():
        return f"{look}봉 신고가"
    peaks = [p for p in swing_points(h[:-1], 3, "high") if p < len(h) - 4]
    if peaks:
        ref = h[peaks[-1]]
        if c[-1] > ref and c[-2] <= ref:
            return f"전고점({ref:.2f}) 돌파"
    return None


# ── 매수/매도 판단 ────────────────────────────
TF_NAME = {"W": "주봉", "M": "월봉"}
RULE_NO = {"완바닥": 1, "쌍바닥": 2, "다중바닥": 3}


def evaluate_buy(daily):
    bars = {"W": to_tf(daily, "W"), "M": to_tf(daily, "M")}
    for pat_tf, cross_tf in CROSS_PAIRS:
        pat = detect_bottom(bars[pat_tf], BOTTOM_LOOKBACK[pat_tf])
        if not pat or not pat["accumulation_ok"]:
            continue
        cb = bars[cross_tf]
        if crossed_above_ma20(cb):
            return {"rule": f"매수{RULE_NO[pat['pattern']]}",
                    "why": f"{TF_NAME[pat_tf]} {pat['pattern']}(매집 확인) 후 {TF_NAME[cross_tf]} 20선 돌파",
                    "key": f"{pat['pattern']}|{pat_tf}{cross_tf}|{cb.index[-1].date()}"}
    for tf in ("W", "M"):
        b = bars[tf]
        if is_uptrend(b):
            why = breakout_high(b, tf)
            if why:
                return {"rule": "매수4", "why": f"{TF_NAME[tf]} 상승장 {why}", "key": f"high|{tf}|{b.index[-1].date()}"}
    return None


def double_top_then_down(daily, order=3, window=60, tol=0.03):
    d = daily.tail(window)
    h, l, c = d["High"].values, d["Low"].values, d["Close"].values
    peaks = swing_points(h, order, "high")
    if len(peaks) < 2 or len(c) < 4:
        return False
    p1, p2 = peaks[-2], peaks[-1]
    if p2 - p1 < 5 or abs(h[p1] - h[p2]) / h[p1] > tol:
        return False
    if l[p1:p2 + 1].min() > min(h[p1], h[p2]) * 0.95:      # 두 봉우리 사이 골이 충분히 깊어야 함
        return False
    if len(c) - 1 - p2 > 10:
        return False
    return bool(c[-1] < c[-2] < c[-3])                      # 2일 연속 하락


def volume_profile(intra, bins=24, value_area=0.70):
    """당일 거래량 분포 -> (VA 하단, VA 상단, POC 가격)."""
    lo, hi = float(intra["Low"].min()), float(intra["High"].max())
    if hi <= lo:
        return lo, hi, lo
    edges = np.linspace(lo, hi, bins + 1)
    typical = ((intra["High"] + intra["Low"] + intra["Close"]) / 3).values
    hist, _ = np.histogram(typical, bins=edges, weights=intra["Volume"].values)
    poc = int(hist.argmax())
    l_i = r_i = poc
    acc, total = hist[poc], hist.sum()
    while acc < total * value_area and (l_i > 0 or r_i < bins - 1):
        left = hist[l_i - 1] if l_i > 0 else -1
        right = hist[r_i + 1] if r_i < bins - 1 else -1
        if right >= left:
            r_i += 1; acc += hist[r_i]
        else:
            l_i -= 1; acc += hist[l_i]
    return float(edges[l_i]), float(edges[r_i + 1]), float((edges[poc] + edges[poc + 1]) / 2)


def evaluate_sell(daily):
    """매도 신호: 급락(분할) > 20선 데드크로스 > 쌍봉 후 2일 하락."""
    d = add_ma(daily)
    c, ma = d["Close"], d["ma20"]
    if len(c) >= 2 and c.iloc[-1] / c.iloc[-2] - 1 <= -CRASH_PCT:
        return {"rule": "매도3", "why": f"급락 {100 * (c.iloc[-1] / c.iloc[-2] - 1):.1f}%", "mode": "crash"}
    if len(c) >= 21 and not pd.isna(ma.iloc[-2]) and c.iloc[-2] >= ma.iloc[-2] and c.iloc[-1] < ma.iloc[-1]:
        return {"rule": "매도1", "why": "일봉 20일선 하향 돌파(데드크로스)", "mode": "all"}
    if double_top_then_down(daily):
        return {"rule": "매도2", "why": "일봉 쌍봉 후 2일 연속 하락", "mode": "all"}
    return None


# ── 가상 계좌(장부) ───────────────────────────
def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"cash_krw": BUDGET_KRW, "realized_krw": 0.0, "positions": {}, "pending": [], "keys": []}


def save_state(state):
    state["keys"] = state["keys"][-500:]
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def apply_fill(state, p, qty, price):
    fx = p["fx"] if p["market"] == "US" else 1.0
    krw = price * fx
    pos = state["positions"].get(p["sym"])
    if p["side"] == "buy":
        state["cash_krw"] -= krw * qty
        if pos:
            tot = pos["qty"] + qty
            pos["avg_krw"] = (pos["avg_krw"] * pos["qty"] + krw * qty) / tot
            pos["qty"] = tot
        else:
            state["positions"][p["sym"]] = {"qty": qty, "avg_krw": krw, "market": p["market"]}
    elif pos:
        qty = min(qty, pos["qty"])
        state["cash_krw"] += krw * qty
        state["realized_krw"] += (krw - pos["avg_krw"]) * qty
        pos["qty"] -= qty
        if pos["qty"] <= 0:
            del state["positions"][p["sym"]]
    log(f"체결 {p['market']} {p['sym']} {p['side'].upper()} {qty}주 @ {price:,.2f} ({p['rule']})")
    with TRADE_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"t": datetime.now().isoformat(timespec="seconds"), "sym": p["sym"], "side": p["side"],
                            "qty": qty, "price": price, "rule": p["rule"], "market": p["market"]}, ensure_ascii=False) + "\n")


def pending_qty(state, sym, side):
    return sum(p["qty"] - p["done"] for p in state["pending"] if p["sym"] == sym and p["side"] == side)


def reconcile(state, api):
    """대기 주문의 체결 여부를 확인해 장부에 반영."""
    today = datetime.now().strftime("%Y-%m-%d")
    keep = []
    for p in state["pending"]:
        terminal, filled, price = False, p["done"], p["ref"]
        try:
            if p["sim"]:
                if p["limit"] is None:
                    filled, price, terminal = p["qty"], p["ref"], True
                else:
                    if last_price(p["sym"], p["market"], None) >= p["limit"]:
                        filled, price, terminal = p["qty"], p["limit"], True
                    elif p["date"] != today:
                        terminal = True
            else:
                o = api.get_order(p["id"])
                filled = int(float(o.filled_qty or 0))
                price = float(o.filled_avg_price or p["ref"])
                terminal = o.status in ("filled", "canceled", "expired", "rejected", "done_for_day")
        except Exception as e:
            log(f"주문 상태 확인 실패 {p['sym']}: {e}")
        if filled > p["done"]:
            apply_fill(state, p, filled - p["done"], price)
            p["done"] = filled
        if not terminal:
            keep.append(p)
    state["pending"] = keep


def place_order(state, api, sym, market, side, qty, ref, fx, rule, limit=None, dry=False):
    if qty <= 0:
        return
    kind = f"지정가 {limit:,.2f}" if limit else "시장가"
    if dry:
        log(f"[DRY] {market} {sym} {side.upper()} {qty}주 {kind} ({rule})")
        return
    p = {"sym": sym, "market": market, "side": side, "qty": int(qty), "done": 0, "limit": limit, "ref": ref,
         "fx": fx, "rule": rule, "sim": market == "KR", "id": None, "date": datetime.now().strftime("%Y-%m-%d"),
         "est_krw": qty * ref * (fx if market == "US" else 1.0)}
    if market == "US":
        kw = dict(symbol=sym, qty=int(qty), side=side, type="limit" if limit else "market", time_in_force="day")
        if limit:
            kw["limit_price"] = round(limit, 2)
        p["id"] = api.submit_order(**kw).id
        log(f"[Alpaca] 주문 전송 {sym} {side.upper()} {qty}주 {kind} ({rule})")
    else:
        log(f"[KR 모의] 주문 {sym} {side.upper()} {qty}주 {kind} ({rule})")
    state["pending"].append(p)


# ── 실행 로직 ─────────────────────────────────
def available_sell_qty(state, api, sym, market):
    pos = state["positions"].get(sym)
    if not pos:
        return 0
    q = pos["qty"] - pending_qty(state, sym, "sell")
    if market == "US" and api is not None:
        try:
            q = min(q, int(float(api.get_position(sym).qty_available)))
        except Exception:
            q = 0
    return max(int(q), 0)


def split3(q):
    return [q // 3 + (1 if i < q % 3 else 0) for i in range(3)]


def process_symbol(state, api, sym, market, fx, dry):
    daily = load_daily(sym, market, api)
    if len(daily) < 200:
        log(f"[{sym}] 데이터 부족({len(daily)}봉) - 건너뜀")
        return
    price = last_price(sym, market, api, daily)
    mult = fx if market == "US" else 1.0
    holding = sym in state["positions"]

    # 매도
    if holding:
        sig = evaluate_sell(daily)
        key = f"sell|{sym}|{sig['rule']}|{daily.index[-1].date()}" if sig else None
        if sig and key not in state["keys"]:
            qty = available_sell_qty(state, api, sym, market)
            if qty > 0:
                log(f"[{sym}] 매도 신호 {sig['rule']}: {sig['why']}")
                if sig["mode"] == "crash":
                    va_lo, va_hi, poc = volume_profile(load_intraday(sym, market, api))
                    upper = va_lo + (va_hi - va_lo) * 2 / 3
                    log(f"[{sym}] 당일 거래량 분포: 구간 {va_lo:.2f}~{va_hi:.2f}, POC {poc:.2f}, 상위 1/3 시작 {upper:.2f}")
                    q1, q2, q3 = split3(qty)
                    place_order(state, api, sym, market, "sell", q1, price, fx, sig["rule"], dry=dry)           # 즉시
                    place_order(state, api, sym, market, "sell", q2, price, fx, sig["rule"], limit=upper, dry=dry)
                    place_order(state, api, sym, market, "sell", q3, price, fx, sig["rule"], limit=va_hi, dry=dry)
                else:
                    place_order(state, api, sym, market, "sell", qty, price, fx, sig["rule"], dry=dry)
                if not dry:
                    state["keys"].append(key)
        return

    # 매수
    if pending_qty(state, sym, "buy"):
        return
    sig = evaluate_buy(daily)
    if not sig:
        log(f"[{sym}] 신호 없음 (현재가 {price:,.2f})")
        return
    key = f"buy|{sym}|{sig['key']}"
    if key in state["keys"]:
        return
    reserved = sum(p["est_krw"] for p in state["pending"] if p["side"] == "buy")
    spend = min(state["cash_krw"] - reserved, BUDGET_KRW * MAX_POS_PCT)
    qty = math.floor(spend / (price * mult))
    log(f"[{sym}] 매수 신호 {sig['rule']}: {sig['why']}")
    if qty < 1:
        log(f"[{sym}] 예산 부족/고가 종목으로 수량 0 - 건너뜀")
        return
    place_order(state, api, sym, market, "buy", qty, price, fx, sig["rule"], dry=dry)
    if not dry:
        state["keys"].append(key)


def kr_market_open():
    now = datetime.now(timezone(timedelta(hours=9)))
    return now.weekday() < 5 and (9, 0) <= (now.hour, now.minute) <= (15, 30)


def print_status(state, fx):
    lines, total = [], state["cash_krw"]
    for sym, pos in state["positions"].items():
        try:
            px = last_price(sym, pos["market"], None) * (fx if pos["market"] == "US" else 1.0)
        except Exception:
            px = pos["avg_krw"]
        total += px * pos["qty"]
        lines.append(f"   {sym} {pos['qty']}주 평균 {pos['avg_krw']:,.0f}원 현재 {px:,.0f}원 ({(px / pos['avg_krw'] - 1) * 100:+.1f}%)")
    log(f"총자산 {total:,.0f}원 (수익률 {(total / BUDGET_KRW - 1) * 100:+.2f}%) | 현금 {state['cash_krw']:,.0f}원 | 실현손익 {state['realized_krw']:+,.0f}원")
    for ln in lines:
        print(ln)


def run_cycle(api, state, force, dry):
    fx = get_fx()
    if not dry:
        reconcile(state, api)
    us_open = force or (api is not None and api.get_clock().is_open)
    kr_open = force or kr_market_open()
    for sym, market in WATCHLIST:
        if (market == "US" and (api is None or not us_open)) or (market == "KR" and not kr_open):
            continue
        try:
            process_symbol(state, api, sym, market, fx, dry)
        except Exception as e:
            log(f"[{sym}] 처리 오류: {e}")
    if not dry:
        reconcile(state, api)
        save_state(state)
    print_status(state, fx)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="1회만 실행")
    ap.add_argument("--dry", action="store_true", help="신호만 출력, 주문/장부 변경 없음")
    ap.add_argument("--force", action="store_true", help="장 시간 무시하고 평가")
    ap.add_argument("--interval", type=int, default=INTERVAL_SEC)
    a = ap.parse_args()

    api = None
    key, secret = os.getenv("ALPACA_API_KEY", "").strip(), os.getenv("ALPACA_SECRET_KEY", "").strip()
    if key and secret and tradeapi:
        api = tradeapi.REST(key, secret, base_url=PAPER_URL, api_version="v2")
        acct = api.get_account()
        log(f"Alpaca Paper 연결 (status={acct.status}) - 가상 자금은 내부 장부 {BUDGET_KRW:,}원 한도로 제한")
    else:
        log("Alpaca 키/패키지 없음 -> 미국 종목은 건너뛰고 한국 종목 모의 매매만 수행")

    state = load_state()
    while True:
        run_cycle(api, state, a.force, a.dry)
        if a.once:
            break
        time.sleep(a.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
