# CTO Trail-Close Re-Entry Trace

## 1. Trail close path
FINDING: Two trail trigger sites, both call `tryClose(position, "trailing-stop")`. The slow monitor path fires when bar-close lev PnL drops below `peak - trailCfg.distance`. The fast-poll path fires on the same condition using `unrealizedPnlPct` from a live mid-price. Both invoke `tryClose(...)` -> `closePosition(positionId, "trailing-stop")`. Neither call site nor `closePosition` itself writes anything to the SL cooldown table.
SOURCE:
- Slow monitor trail close: `src/services/hyperliquid/position-monitor.ts:272-275`
- Fast-poll trail close: `src/services/hyperliquid/position-monitor.ts:408-413`
- `tryClose` -> `closePosition`: `src/services/hyperliquid/position-monitor.ts:78-82`
- `closePosition` (no cooldown write): `src/services/hyperliquid/executor.ts:81-101`

## 2. SL close path + cooldown writer
FINDING: SL hit writes the cooldown TWICE.
- Position-monitor writes cooldown immediately AFTER calling `tryClose(position, "SL hit")` at line 212-213, before the `continue`.
- Then inside `liveClosePosition`, when `reason === "stop-loss"` the executor also writes cooldown (note: monitor passes `"SL hit"`, NOT `"stop-loss"` — so the executor branch only fires when the upstream reason string is exactly `"stop-loss"`, which is the case for cancel/replace SL trigger paths and reconcile paths). Either way the monitor write at line 213 guarantees cooldown on every SL hit.
- Liquidation also writes cooldown (line 196).
- `isInStopLossCooldown` reads from the same in-memory `slCooldowns` Map.
SOURCE:
- `slCooldowns` Map + reader/writer: `src/services/hyperliquid/scheduler.ts:14-25`
- Monitor SL writer: `src/services/hyperliquid/position-monitor.ts:205-214`
- Monitor liquidation writer: `src/services/hyperliquid/position-monitor.ts:191-197`
- Live executor cooldown writer (gated on `reason === "stop-loss"`): `src/services/hyperliquid/live-executor.ts:1013-1015`
- Live executor reconcile cooldown writer: `src/services/hyperliquid/live-executor.ts:1090-1092`
- Paper executor cooldown writer (gated on `reason === "stop-loss"`): `src/services/hyperliquid/paper.ts:252-254`

## 3. Gates in runGarchV2Cycle before opening
FINDING: For each pair, in order:
1. Open-pairs dedup (skip if pair already has an open `garch-v2` position): `src/services/hyperliquid/garch-v2-engine.ts:60` — `if (openPairs.has(pair)) continue;`
2. Ensemble max-concurrent gate (break loop if `>= 7` open across ensemble trade types): `src/services/hyperliquid/garch-v2-engine.ts:61` — `if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;`
3. Blocked UTC hours 22-23 (cycle-level, before pair loop): `src/services/hyperliquid/garch-v2-engine.ts:48-53`
4. H1 entry window (must be within first 5 min of UTC hour, cycle-level): `src/services/hyperliquid/garch-v2-engine.ts:55-56`, definition at `src/services/hyperliquid/scheduler.ts:29-31`
5. Z-score thresholds (z1h>3.0 AND z4h>1.5 long, or symmetric short): `src/services/hyperliquid/garch-v2-engine.ts:77-80`
6. SL cooldown gate (per pair+direction+tradeType, 4h TTL): `src/services/hyperliquid/garch-v2-engine.ts:81` — `if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;`

That is the complete list before `openPosition` is invoked at line 91-94.
SOURCE: `src/services/hyperliquid/garch-v2-engine.ts:39-102`

## 4. Dup-pair / recently-closed check
FINDING: NO. There is no recently-closed / dup-pair guard. The only pair-level dedup is `openPairs.has(pair)` which is built from `getOpenQuantPositions().filter(p => p.tradeType === TRADE_TYPE)` — i.e. CURRENTLY OPEN positions only. A pair that closed seconds ago is not in `openPairs` and is therefore eligible for re-entry on the very next cycle. The 4h SL cooldown is the only mechanism that would block re-entry, and it is keyed off `recordStopLossCooldown` which is NEVER called from a trailing-stop close.
SOURCE:
- `openPairs` built from currently-open only: `src/services/hyperliquid/garch-v2-engine.ts:40-42`
- Dedup check: `src/services/hyperliquid/garch-v2-engine.ts:60`
- Cooldown gate (only protection): `src/services/hyperliquid/garch-v2-engine.ts:81`

## 5. Asymmetry between trail close and SL close
FINDING: YES, asymmetric.
- SL close: monitor writes cooldown directly (`position-monitor.ts:213`), AND executor writes cooldown when the close reason string is `"stop-loss"` (`live-executor.ts:1013-1015`, `paper.ts:252-254`). Re-entry on same pair+direction blocked for 4h.
- Trail close: monitor calls `tryClose(position, "trailing-stop")` and then `continue` — no cooldown write at the call site (`position-monitor.ts:272-275` and `408-413`). Executor receives reason `"trailing-stop"` which fails the `=== "stop-loss"` check — no cooldown write there either. Re-entry on same pair+direction is allowed on the very next cycle (subject to z-score, H1 window, blocked-hour, and max-concurrent gates).
- Stagnation close (line 286) and liquidation paper-mode (line 193) — stagnation also has no cooldown; liquidation does (line 196).
SOURCE:
- Trail close, no cooldown: `src/services/hyperliquid/position-monitor.ts:272-275`, `408-413`
- SL close, cooldown written: `src/services/hyperliquid/position-monitor.ts:209-214`
- Executor cooldown gated on exact reason: `src/services/hyperliquid/live-executor.ts:1013`, `src/services/hyperliquid/paper.ts:252`

## VERDICT (CTO)
ACCIDENTAL. The trail-stop path does not write to the cooldown table at any layer. The cooldown was designed as a "stop-loss cooldown" (literal name `slCooldowns`, function `recordStopLossCooldown`, comment at `scheduler.ts:12` says `4h cooldown (matches bt-1m-mega cd4h)`). Whoever added the trail-stop exit (`position-monitor.ts:272-275`) handled SL parity at line 213 but didn't extend cooldown to the trail path. Engine entry gates only check `openPairs` (currently open) and `isInStopLossCooldown`, neither of which trips after a trail close.

Quoting the relevant bug surface verbatim:

`position-monitor.ts:209-214` (SL writes cooldown):
```
        if (slHit) {
          const hitPrice = position.direction === "long" ? barLow : barHigh;
          console.log(`[PositionMonitor] SL hit: ...`);
          await tryClose(position, "SL hit");
          recordStopLossCooldown(position.pair, position.direction, position.tradeType ?? "directional");
          continue;
        }
```

`position-monitor.ts:272-275` (trail does NOT write cooldown):
```
        if (currentLevPnlPct <= peak - trailCfg.distance) {
          console.log(`[PositionMonitor] Trail hit: ...`);
          await tryClose(position, "trailing-stop");
          continue;
        }
```

`garch-v2-engine.ts:60-81` (entry gates only check open-pair set + SL cooldown):
```
    if (openPairs.has(pair)) continue;
    if (ensembleCount >= ENSEMBLE_MAX_CONCURRENT) break;
    ...
    if (!direction) continue;
    if (isInStopLossCooldown(pair, direction, TRADE_TYPE)) continue;
```

ZEC re-entry at 376.44 (5 min after the 367.89 trail close) is mechanically explained: trail close did not record cooldown, the next 3-min scheduler cycle landed inside the H1 entry window (first 5 min of the hour), z1h/z4h still satisfied long thresholds, ensemble was below 7, and `openPairs` no longer contained ZEC because the position was closed. All gates passed; engine opened.

Backtest parity note: `bt-1m-mega.ts cd4h` was the source of the cooldown design. If the backtest logic also skipped cooldown after trail-stop, the live behavior matches backtest. If the backtest did NOT distinguish trail vs SL exits and applied cooldown to both, this is a live-vs-bt parity bug. Recommend an audit of the backtest's exit-cooldown handling before patching, since blindly extending cooldown to trail closes will alter the validated edge ($0.59/day, Calmar 0.029).
