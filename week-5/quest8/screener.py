"""IT/바이오/수명연장/줄기세포 우량 후보 스크리닝 (yfinance).

사용: python screener.py        -> 상위 3개 티커 출력
      from screener import pick_top3
"""
import math
import sys

import pandas as pd
import yfinance as yf

# ── 후보 유니버스 (미국 / 한국) ────────────────
UNIVERSE = {
    "US": [
        "NVDA", "MSFT", "GOOGL", "AMZN", "META", "AVGO", "TSM",   # IT
        "LLY", "AMGN", "REGN", "VRTX", "ISRG", "GILD", "MRNA",     # 바이오
        "CRSP", "NTLA", "BEAM",                                    # 유전자/줄기세포
        "ILMN", "TMO", "DHR",                                      # 수명연장 인프라/도구
    ],
    "KR": [
        "005930.KS", "000660.KS", "035420.KS", "035720.KS",        # IT
        "207940.KS", "068270.KS", "326030.KS", "128940.KS",        # 바이오
        "196170.KQ", "145020.KQ", "078160.KQ", "068760.KQ",        # 바이오/줄기세포
        "950160.KQ", "007660.KS",
    ],
}

MIN_ASSETS_USD = 5e9          # 자산 규모 하한 (미화 환산 기준)
KRW_PER_USD = 1400.0          # 단순 환산용 고정 환율
LOOKBACK = "3mo"


# ── 재무 지표 ─────────────────────────────────
def _latest_total_assets(t: yf.Ticker):
    try:
        bs = t.balance_sheet
        if bs is not None and not bs.empty and "Total Assets" in bs.index:
            s = bs.loc["Total Assets"].dropna()
            if not s.empty:
                return float(s.iloc[0])
    except Exception:
        pass
    return None


def fetch_fundamentals(ticker: str) -> dict:
    """자산총계(USD 환산)와 주요 재무 지표. 실패 항목은 None."""
    t = yf.Ticker(ticker)
    try:
        info = t.info or {}
    except Exception:
        info = {}
    assets = _latest_total_assets(t)
    cur = (info.get("financialCurrency") or info.get("currency") or "USD").upper()
    assets_usd = assets / KRW_PER_USD if (assets and cur == "KRW") else assets
    return {
        "ticker": ticker,
        "name": info.get("shortName") or ticker,
        "total_assets_usd": assets_usd,
        "market_cap": info.get("marketCap"),
        "revenue_growth": info.get("revenueGrowth"),
        "gross_margin": info.get("grossMargins"),
        "profit_margin": info.get("profitMargins"),
        "roe": info.get("returnOnEquity"),
        "debt_to_equity": info.get("debtToEquity"),
    }


# ── 매집세력 강도 지수 ────────────────────────
def accumulation_index(ticker: str) -> dict:
    """최근 3개월: 거래량 급증 + 주가 횡보(저변동·박스권)일수록 높은 0~100 점수.

    구성(각 가중치):
      - 거래량 급증비   40 : 최근 20일 평균 / 이전 구간 평균
      - 가격 횡보도     30 : 3개월 고저 변동폭이 작을수록 가점
      - 매집일 비율     20 : 거래량>평균*1.5 이면서 일 등락 ±2% 이내인 날의 비율
      - 순매집 흐름(OBV) 10 : OBV 기울기가 양(+)이면서 주가는 평탄
    """
    df = yf.Ticker(ticker).history(period=LOOKBACK, auto_adjust=True)
    df = df.dropna(subset=["Close", "Volume"])
    if len(df) < 40 or df["Volume"].mean() == 0:
        return {"ticker": ticker, "score": 0.0, "reason": "데이터 부족"}

    close, vol = df["Close"], df["Volume"]
    base_vol = vol.iloc[:-20].mean()
    vol_ratio = vol.iloc[-20:].mean() / base_vol if base_vol else 1.0
    s_vol = min(max(vol_ratio - 1.0, 0.0) / 1.0, 1.0)            # 2배면 만점

    rng = (close.max() - close.min()) / close.mean()
    s_flat = min(max(1.0 - rng / 0.35, 0.0), 1.0)                # 변동폭 35% 이상이면 0

    ret = close.pct_change().abs()
    acc_days = ((vol > vol.mean() * 1.5) & (ret < 0.02)).mean()
    s_days = min(acc_days / 0.15, 1.0)                           # 15% 이상이면 만점

    direction = close.diff().apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
    obv = (direction * vol).cumsum()
    obv_slope = (obv.iloc[-1] - obv.iloc[0]) / (vol.mean() * len(df))
    s_obv = min(max(obv_slope, 0.0) / 1.0, 1.0) * s_flat         # 횡보일 때만 인정

    score = 100 * (0.4 * s_vol + 0.3 * s_flat + 0.2 * s_days + 0.1 * s_obv)
    return {
        "ticker": ticker,
        "score": round(score, 1),
        "vol_ratio": round(float(vol_ratio), 2),
        "range_pct": round(float(rng) * 100, 1),
        "acc_days_pct": round(float(acc_days) * 100, 1),
    }


# ── 종합 스크리닝 ─────────────────────────────
def _norm(series: pd.Series) -> pd.Series:
    s = series.astype(float)
    return (s - s.min()) / (s.max() - s.min()) if s.max() > s.min() else s * 0


def screen(universe=UNIVERSE, min_assets=MIN_ASSETS_USD) -> pd.DataFrame:
    rows = []
    for market, tickers in universe.items():
        for tk in tickers:
            try:
                f = fetch_fundamentals(tk)
                if not f["total_assets_usd"] or f["total_assets_usd"] < min_assets:
                    continue
                a = accumulation_index(tk)
                rows.append({**f, "market": market, "acc_score": a["score"],
                             "vol_ratio": a.get("vol_ratio"), "range_pct": a.get("range_pct")})
            except Exception as e:
                print(f"[skip] {tk}: {e}", file=sys.stderr)
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # 비전(성장·수익성) 점수: 결측은 중앙값 대체. 자산은 로그 스케일
    growth = df["revenue_growth"].fillna(df["revenue_growth"].median()).fillna(0).clip(-0.5, 1.5)
    margin = df["profit_margin"].fillna(df["profit_margin"].median()).fillna(0).clip(-1, 0.5)
    size = df["total_assets_usd"].apply(lambda x: math.log10(x))
    df["quality"] = 100 * (0.4 * _norm(growth) + 0.3 * _norm(margin) + 0.3 * _norm(size))
    df["final_score"] = (0.5 * df["quality"] + 0.5 * df["acc_score"]).round(1)
    return df.sort_values("final_score", ascending=False).reset_index(drop=True)


def pick_top3(universe=UNIVERSE) -> list[str]:
    """미국/한국 합산 가장 유망한 3개 티커."""
    df = screen(universe)
    return df["ticker"].head(3).tolist() if not df.empty else []


if __name__ == "__main__":
    result = screen()
    if result.empty:
        print("조건에 맞는 종목이 없거나 데이터를 가져오지 못했습니다.")
    else:
        cols = ["ticker", "name", "market", "total_assets_usd", "acc_score", "quality", "final_score"]
        print(result[cols].head(10).to_string(index=False))
        print("\nTOP3:", result["ticker"].head(3).tolist())
