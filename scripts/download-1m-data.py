#!/usr/bin/env python3
"""
Download 1m kline data from Binance data.vision bulk CSV archives.
Saves to /tmp/bt-pair-cache-1m/ in same JSON format as 5m cache.

Run: python3 scripts/download-1m-data.py
"""

import os
import io
import json
import ssl
import time
import zipfile
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

# Binance data.vision SSL cert fails on some Python installs
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

CACHE_DIR = "/tmp/bt-pair-cache-1m"
os.makedirs(CACHE_DIR, exist_ok=True)

PAIRS = [
    "BTC", "OP", "ARB", "LDO", "TRUMP", "DOT", "ENA",
    "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "SOL",
    "WIF", "DASH", "TIA", "AVAX", "NEAR", "ETH",
    "SUI", "HYPE", "FET", "ZEC",
]

# Some pairs were listed late - skip months before their listing
PAIR_START = {
    "TRUMP": "2025-01",
    "ENA": "2024-04",
    "WLD": "2023-08",
    "ARB": "2023-04",
    "APT": "2022-10",
}

START_YEAR = 2023
START_MONTH = 1
# Monthly archives through 2026-02, daily for 2026-03
MONTHLY_END_YEAR = 2026
MONTHLY_END_MONTH = 2
DAILY_YEAR = 2026
DAILY_MONTH = 3
DAILY_END_DAY = 26

BASE_URL = "https://data.binance.vision/data/spot"


def is_pair_listed(pair: str, year: int, month: int) -> bool:
    key = f"{year}-{month:02d}"
    start = PAIR_START.get(pair)
    if start and key < start:
        return False
    return True


def download_zip(url: str) -> bytes | None:
    """Download a zip file, return bytes or None on 404/error."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < 2:
                time.sleep(1 * (attempt + 1))
        except Exception:
            if attempt < 2:
                time.sleep(1 * (attempt + 1))
    return None


def parse_csv_from_zip(zip_bytes: bytes) -> list[dict]:
    """Extract CSV from zip and parse into candle dicts."""
    bars = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for name in zf.namelist():
            if not name.endswith(".csv"):
                continue
            with zf.open(name) as f:
                for line in f:
                    line = line.decode("utf-8").strip()
                    if not line or line.startswith("open_time"):
                        continue
                    parts = line.split(",")
                    if len(parts) < 5:
                        continue
                    try:
                        ts = int(parts[0])
                        # Daily files use microsecond timestamps, normalize to ms
                        if ts > 1e15:
                            ts = ts // 1000
                        bars.append({
                            "t": ts,
                            "o": float(parts[1]),
                            "h": float(parts[2]),
                            "l": float(parts[3]),
                            "c": float(parts[4]),
                        })
                    except (ValueError, IndexError):
                        continue
    return bars


def get_monthly_urls(symbol: str) -> list[str]:
    """Generate monthly archive URLs."""
    urls = []
    y, m = START_YEAR, START_MONTH
    pair_name = symbol.replace("BTC", "BTC") + "USDT"
    while (y, m) <= (MONTHLY_END_YEAR, MONTHLY_END_MONTH):
        base_pair = symbol
        if is_pair_listed(base_pair, y, m):
            url = f"{BASE_URL}/monthly/klines/{pair_name}/1m/{pair_name}-1m-{y}-{m:02d}.zip"
            urls.append(url)
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return urls


def get_daily_urls(symbol: str) -> list[str]:
    """Generate daily archive URLs for current month."""
    urls = []
    pair_name = symbol + "USDT"
    for day in range(1, DAILY_END_DAY + 1):
        url = f"{BASE_URL}/daily/klines/{pair_name}/1m/{pair_name}-1m-{DAILY_YEAR}-{DAILY_MONTH:02d}-{day:02d}.zip"
        urls.append(url)
    return urls


def download_one(url: str) -> list[dict]:
    """Download and parse one archive."""
    data = download_zip(url)
    if data is None:
        return []
    return parse_csv_from_zip(data)


def is_cache_complete(pair: str) -> bool:
    """Check if cache file exists and has data past 2026-03-20."""
    fp = os.path.join(CACHE_DIR, f"{pair}USDT.json")
    if not os.path.exists(fp):
        return False
    try:
        with open(fp) as f:
            data = json.load(f)
        if not data:
            return False
        # 2026-03-20 00:00:00 UTC in ms
        cutoff = int(datetime(2026, 3, 20).timestamp() * 1000)
        last_t = data[-1]["t"]
        return last_t > cutoff
    except Exception:
        return False


def download_pair(pair: str) -> tuple[str, int]:
    """Download all 1m data for a pair. Returns (pair, bar_count)."""
    symbol = pair
    cache_file = os.path.join(CACHE_DIR, f"{symbol}USDT.json")

    if is_cache_complete(symbol):
        # Count existing bars
        with open(cache_file) as f:
            data = json.load(f)
        print(f"  {symbol}: CACHED ({len(data):,} bars, {os.path.getsize(cache_file) / 1e6:.1f}MB)")
        return (symbol, len(data))

    monthly_urls = get_monthly_urls(symbol)
    daily_urls = get_daily_urls(symbol)
    all_urls = monthly_urls + daily_urls

    print(f"  {symbol}: downloading {len(all_urls)} archives...")

    all_bars = []
    done = 0
    failed = 0

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(download_one, url): url for url in all_urls}
        for future in as_completed(futures):
            done += 1
            try:
                bars = future.result()
                all_bars.extend(bars)
            except Exception:
                failed += 1
            if done % 10 == 0:
                print(f"    {symbol}: {done}/{len(all_urls)} downloaded ({len(all_bars):,} bars so far)")

    if not all_bars:
        print(f"  {symbol}: NO DATA (all downloads failed)")
        return (symbol, 0)

    # Filter out invalid timestamps (must be between 2022-01-01 and 2027-01-01 in ms)
    MIN_TS = 1640995200000  # 2022-01-01
    MAX_TS = 1798761600000  # 2027-01-01
    all_bars = [b for b in all_bars if MIN_TS <= b["t"] <= MAX_TS]

    # Sort and deduplicate
    all_bars.sort(key=lambda b: b["t"])
    deduped = []
    seen = set()
    for b in all_bars:
        if b["t"] not in seen:
            seen.add(b["t"])
            deduped.append(b)

    # Save
    with open(cache_file, "w") as f:
        json.dump(deduped, f)

    size_mb = os.path.getsize(cache_file) / 1e6
    first_dt = datetime.fromtimestamp(deduped[0]["t"] / 1000, tz=None).strftime("%Y-%m-%d")
    last_dt = datetime.fromtimestamp(deduped[-1]["t"] / 1000, tz=None).strftime("%Y-%m-%d")
    print(f"  {symbol}: DONE {len(deduped):,} bars, {size_mb:.1f}MB, {first_dt} to {last_dt} (failed: {failed})")
    return (symbol, len(deduped))


def main():
    print(f"Downloading 1m data for {len(PAIRS)} pairs to {CACHE_DIR}")
    print(f"Range: {START_YEAR}-{START_MONTH:02d} to {DAILY_YEAR}-{DAILY_MONTH:02d}-{DAILY_END_DAY:02d}")
    print()

    start = time.time()
    results = []

    # Download pairs sequentially (each pair uses 8 threads internally)
    for pair in PAIRS:
        result = download_pair(pair)
        results.append(result)
        print()

    elapsed = time.time() - start
    print(f"\nComplete in {elapsed:.0f}s")
    print(f"\nSummary:")
    total_bars = 0
    for symbol, count in results:
        fp = os.path.join(CACHE_DIR, f"{symbol}USDT.json")
        size = os.path.getsize(fp) / 1e6 if os.path.exists(fp) else 0
        print(f"  {symbol:6s}: {count:>10,} bars  ({size:.1f}MB)")
        total_bars += count
    print(f"  Total: {total_bars:>10,} bars")


if __name__ == "__main__":
    main()
