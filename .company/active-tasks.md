# Cycle 1 Tasks - Push GARCH to $5/day MDD<$20

1. Worker-A (Chief Strategist): Analyze the $2.18 config's trade distribution — what % of profit comes from top trades? Can we scale margin without blowing MDD? Calculate required margin/pairs to hit $5. Write a new standalone script scripts/bt-push-profit.ts that tests ONLY the most promising configs: bigger margin ($30-50), multi-stage trails, combined parallel pair universes.

2. Worker-B (Quant Backtester): Add multi-stage trail support to bt-exchange-sl-research.ts AND add new Z categories: (a) multi-stage trails like [30/3, 60/6, 100/10], (b) bigger margin ($30, $35, $40, $45, $50) on top5 with mc2-5, (c) "parallel engine" simulation — two non-overlapping pair sets running simultaneously (top5 + alt5A, top5 + alt5B, etc.), where their PnL/MDD are COMBINED.

3. Worker-C (Risk Manager): Check if the MDD computation in the sim is correct — does it account for concurrent open-position unrealized losses? Currently MDD is computed only on closed-trade equity curve. Real MDD includes open-position drawdown. Also check: is the $19 MDD realistic or is real MDD higher?

4. Worker-D (Truth Teller): Verify the top config isn't overfit. Run the top5 z3/2 mc3 tr80/8 config on IS-only (first 150 days) vs OOS-only (last 147 days) to see if it degrades.
