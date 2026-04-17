"""Aggregate 1s JSON cache to 1m OHLCV, streaming to avoid memory issues."""
import json, os, sys
from datetime import datetime

SRC = "/tmp/bt-pair-cache-1s"
DST = "/tmp/bt-pair-cache-1s-as-1m"
os.makedirs(DST, exist_ok=True)

pairs = [f.replace(".json","") for f in os.listdir(SRC) if f.endswith(".json")]
print(f"Found {len(pairs)} pairs to aggregate")

for pair in sorted(pairs):
    src_path = os.path.join(SRC, f"{pair}.json")
    dst_path = os.path.join(DST, f"{pair}.json")
    if os.path.exists(dst_path):
        print(f"  {pair}: already exists, skip")
        continue

    print(f"  {pair}: loading...", end="", flush=True)
    with open(src_path) as f:
        bars = json.load(f)
    print(f" {len(bars)} bars, aggregating...", end="", flush=True)

    # Group by 1m bucket
    buckets = {}
    for b in bars:
        if isinstance(b, list):
            t, o, h, l, c = b[0], float(b[1]), float(b[2]), float(b[3]), float(b[4])
        else:
            t, o, h, l, c = b['t'], float(b['o']), float(b['h']), float(b['l']), float(b['c'])

        bucket = (t // 60000) * 60000  # 1-minute bucket
        if bucket not in buckets:
            buckets[bucket] = [o, h, l, c]
        else:
            existing = buckets[bucket]
            existing[1] = max(existing[1], h)  # high
            existing[2] = min(existing[2], l)  # low
            existing[3] = c  # close = last

    # Sort and write as arrays [t, o, h, l, c]
    result = []
    for t in sorted(buckets.keys()):
        b = buckets[t]
        result.append([t, b[0], b[1], b[2], b[3]])

    with open(dst_path, 'w') as f:
        json.dump(result, f)

    start = datetime.utcfromtimestamp(result[0][0]/1000).strftime('%Y-%m-%d')
    end = datetime.utcfromtimestamp(result[-1][0]/1000).strftime('%Y-%m-%d')
    print(f" -> {len(result)} 1m bars ({start} to {end})")

print("Done!")
