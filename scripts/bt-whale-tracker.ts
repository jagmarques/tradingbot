/**
 * Whale Position Tracker - Live data collection from Hyperliquid API
 * Queries leaderboard + known addresses, aggregates positions per coin.
 */

const API = "https://api.hyperliquid.xyz/info";

const COINS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","BTC","SEI",
];

interface Position {
  coin: string;
  szi: string;
  leverage: { type: string; value: number };
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  liquidationPx: string | null;
}

interface ClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  assetPositions: { position: Position }[];
}

async function post(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------- Step 1: Get addresses from leaderboard ----------

async function tryLeaderboard(): Promise<string[]> {
  // Try many variations of the leaderboard API
  const endpoints: Record<string, unknown>[] = [
    { type: "leaderboard", timeWindow: "1w" },
    { type: "leaderboard", timeWindow: "1d" },
    { type: "leaderboard", timeWindow: "allTime" },
    { type: "leaderboard", timeWindow: "7d" },
    { type: "leaderboard", window: "week" },
    { type: "leaderboard" },
    // Undocumented: try querying top traders
    { type: "topTraders" },
    { type: "frontendOpenOrders", user: "0x0000000000000000000000000000000000000000" },
  ];

  for (const body of endpoints) {
    try {
      console.log(`[Leaderboard] Trying: ${JSON.stringify(body)}`);
      const data = await post(body);

      // Recursive extraction of addresses from any response shape
      const extracted = extractAddresses(data, 20);
      if (extracted.length > 0) {
        console.log(`[Leaderboard] Extracted ${extracted.length} addresses`);
        return extracted;
      }

      // Log what we got
      if (Array.isArray(data)) {
        console.log(`[Leaderboard] Got array (${data.length} items)`);
        if (data.length > 0) console.log(`[Leaderboard] Sample: ${JSON.stringify(data[0]).slice(0, 500)}`);
      } else if (data && typeof data === "object") {
        console.log(`[Leaderboard] Got object keys: ${Object.keys(data as Record<string, unknown>).join(", ")}`);
        // Deep-log nested arrays
        const obj = data as Record<string, unknown>;
        for (const key of Object.keys(obj)) {
          const val = obj[key];
          if (Array.isArray(val)) {
            console.log(`[Leaderboard]   .${key}: array(${val.length})`);
            if (val.length > 0) console.log(`[Leaderboard]   sample: ${JSON.stringify(val[0]).slice(0, 500)}`);
          }
        }
      }
    } catch (err) {
      console.log(`[Leaderboard] Failed: ${(err as Error).message}`);
    }
  }
  return [];
}

function extractAddresses(data: unknown, limit: number): string[] {
  const addrs: string[] = [];
  const addrRegex = /^0x[0-9a-fA-F]{40}$/;

  function walk(obj: unknown): void {
    if (addrs.length >= limit) return;
    if (typeof obj === "string" && addrRegex.test(obj)) {
      if (!addrs.includes(obj)) addrs.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      // Prioritize address-like keys
      for (const key of ["ethAddress", "address", "user", "trader", "account", "wallet"]) {
        if (typeof o[key] === "string" && addrRegex.test(o[key] as string)) {
          if (!addrs.includes(o[key] as string)) addrs.push(o[key] as string);
        }
      }
      for (const val of Object.values(o)) walk(val);
    }
  }

  walk(data);
  return addrs;
}

// ---------- Alternative: vault depositors + API exploration ----------

async function getVaultDepositors(): Promise<string[]> {
  const HLP_VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
  const addrs: string[] = [];

  try {
    console.log("[Discovery] Fetching HLP vault details...");
    const data = (await post({ type: "vaultDetails", vaultAddress: HLP_VAULT })) as Record<string, unknown>;

    // The vault response has a 'followers' or 'depositors' field
    if (data) {
      const keys = Object.keys(data);
      console.log(`[Discovery] vaultDetails keys: ${keys.join(", ")}`);

      // Try to find depositor/follower arrays
      for (const key of keys) {
        const val = data[key];
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
          console.log(`[Discovery] .${key}: ${val.length} items, sample: ${JSON.stringify(val[0]).slice(0, 300)}`);
          const extracted = extractAddresses(val.slice(0, 50), 30);
          if (extracted.length > 0) {
            console.log(`[Discovery] Extracted ${extracted.length} addresses from .${key}`);
            addrs.push(...extracted);
          }
        }
      }

      // Also try leader address
      if (typeof data.leader === "string") {
        addrs.push(data.leader as string);
        console.log(`[Discovery] Vault leader: ${data.leader}`);
      }
    }
  } catch (err) {
    console.log(`[Discovery] vaultDetails failed: ${(err as Error).message}`);
  }

  // Try additional API exploration
  const explorations: { label: string; body: Record<string, unknown> }[] = [
    { label: "meta", body: { type: "meta" } },
    { label: "allMids", body: { type: "allMids" } },
    { label: "metaAndAssetCtxs", body: { type: "metaAndAssetCtxs" } },
    { label: "openOrders (HLP)", body: { type: "openOrders", user: HLP_VAULT } },
    { label: "userFunding (HLP)", body: { type: "userFunding", user: HLP_VAULT } },
  ];

  for (const { label, body } of explorations) {
    try {
      console.log(`[Discovery] Trying ${label}...`);
      const data = await post(body);
      if (data) {
        const str = JSON.stringify(data).slice(0, 400);
        console.log(`[Discovery] ${label}: ${str}`);
      }
    } catch (err) {
      console.log(`[Discovery] ${label} failed: ${(err as Error).message}`);
    }
  }

  return [...new Set(addrs)];
}

// ---------- Step 2: Fetch positions for an address ----------

async function getPositions(addr: string): Promise<{
  addr: string;
  accountValue: number;
  positions: {
    coin: string;
    size: number;
    notional: number;
    leverage: number;
    entryPx: number;
    liqPx: number | null;
    pnl: number;
    direction: "long" | "short";
  }[];
} | null> {
  try {
    const data = (await post({
      type: "clearinghouseState",
      user: addr,
    })) as ClearinghouseState;

    if (!data?.marginSummary) return null;

    const accountValue = parseFloat(data.marginSummary.accountValue);
    const positions = (data.assetPositions || [])
      .map((ap) => {
        const p = ap.position;
        const size = parseFloat(p.szi);
        const entryPx = parseFloat(p.entryPx);
        const notional = Math.abs(size) * entryPx;
        return {
          coin: p.coin,
          size,
          notional,
          leverage: p.leverage?.value || 0,
          entryPx,
          liqPx: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
          pnl: parseFloat(p.unrealizedPnl),
          direction: (size > 0 ? "long" : "short") as "long" | "short",
        };
      })
      .filter((p) => p.size !== 0);

    return { addr, accountValue, positions };
  } catch (err) {
    console.log(`[Positions] Failed for ${addr.slice(0, 10)}...: ${(err as Error).message}`);
    return null;
  }
}

// ---------- Step 3: Aggregate ----------

interface CoinAgg {
  coin: string;
  longNotional: number;
  shortNotional: number;
  longCount: number;
  shortCount: number;
  liqPricesAbove: number[];
  liqPricesBelow: number[];
  whaleDetails: { addr: string; direction: string; notional: number; leverage: number; pnl: number }[];
}

function aggregate(
  results: NonNullable<Awaited<ReturnType<typeof getPositions>>>[]
): Map<string, CoinAgg> {
  const agg = new Map<string, CoinAgg>();

  for (const r of results) {
    for (const p of r.positions) {
      let ca = agg.get(p.coin);
      if (!ca) {
        ca = {
          coin: p.coin,
          longNotional: 0,
          shortNotional: 0,
          longCount: 0,
          shortCount: 0,
          liqPricesAbove: [],
          liqPricesBelow: [],
          whaleDetails: [],
        };
        agg.set(p.coin, ca);
      }

      if (p.direction === "long") {
        ca.longNotional += p.notional;
        ca.longCount++;
      } else {
        ca.shortNotional += p.notional;
        ca.shortCount++;
      }

      if (p.liqPx !== null && p.liqPx > 0) {
        if (p.direction === "long") {
          ca.liqPricesBelow.push(p.liqPx);
        } else {
          ca.liqPricesAbove.push(p.liqPx);
        }
      }

      ca.whaleDetails.push({
        addr: r.addr,
        direction: p.direction,
        notional: p.notional,
        leverage: p.leverage,
        pnl: p.pnl,
      });
    }
  }

  return agg;
}

// ---------- Step 4: Report ----------

function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function printReport(
  results: NonNullable<Awaited<ReturnType<typeof getPositions>>>[],
  agg: Map<string, CoinAgg>,
  source: string,
) {
  console.log("\n" + "=".repeat(80));
  console.log(`WHALE POSITION TRACKER - ${new Date().toISOString()}`);
  console.log(`Source: ${source}`);
  console.log("=".repeat(80));

  // --- Tracked addresses ---
  console.log(`\n--- TRACKED ACCOUNTS (${results.length}) ---`);
  const sorted = [...results].sort((a, b) => b.accountValue - a.accountValue);
  for (const r of sorted) {
    const posCount = r.positions.length;
    const totalPnl = r.positions.reduce((s, p) => s + p.pnl, 0);
    console.log(
      `  ${r.addr.slice(0, 10)}...${r.addr.slice(-4)}  ` +
      `AccVal: ${fmt(r.accountValue).padStart(12)}  ` +
      `Positions: ${String(posCount).padStart(3)}  ` +
      `uPnL: ${(totalPnl >= 0 ? "+" : "") + fmt(totalPnl)}`
    );
  }

  // --- Per-coin sentiment (only our universe) ---
  console.log("\n--- COIN SENTIMENT (Our Universe) ---");
  console.log(
    "  Coin".padEnd(10) +
    "Long$".padStart(12) + "Short$".padStart(12) +
    "Net".padStart(12) + "Bias".padStart(8) +
    "Whales".padStart(8) + "Consensus".padStart(14)
  );
  console.log("  " + "-".repeat(74));

  for (const coin of COINS) {
    const ca = agg.get(coin);
    if (!ca) continue;

    const net = ca.longNotional - ca.shortNotional;
    const bias = net > 0 ? "LONG" : net < 0 ? "SHORT" : "FLAT";
    const total = ca.longCount + ca.shortCount;
    const consensus =
      ca.longCount >= 3 ? `${ca.longCount}L CONSENSUS` :
      ca.shortCount >= 3 ? `${ca.shortCount}S CONSENSUS` : "";

    console.log(
      `  ${coin.padEnd(8)}` +
      `${fmt(ca.longNotional).padStart(12)}` +
      `${fmt(ca.shortNotional).padStart(12)}` +
      `${((net >= 0 ? "+" : "") + fmt(net)).padStart(12)}` +
      `${bias.padStart(8)}` +
      `${String(total).padStart(8)}` +
      `${consensus.padStart(14)}`
    );
  }

  // --- All coins these whales are trading (sorted by total notional) ---
  console.log("\n--- ALL COINS WHALES ARE TRADING (Top 30 by notional) ---");
  const allCoins = [...agg.entries()]
    .map(([coin, ca]) => ({
      coin,
      total: ca.longNotional + ca.shortNotional,
      net: ca.longNotional - ca.shortNotional,
      longCount: ca.longCount,
      shortCount: ca.shortCount,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 30);

  console.log(
    "  Coin".padEnd(10) +
    "Total$".padStart(14) + "Net$".padStart(14) +
    "Bias".padStart(8) + "#L".padStart(5) + "#S".padStart(5)
  );
  console.log("  " + "-".repeat(54));
  for (const c of allCoins) {
    const bias = c.net > 0 ? "LONG" : c.net < 0 ? "SHORT" : "FLAT";
    console.log(
      `  ${c.coin.padEnd(8)}` +
      `${fmt(c.total).padStart(14)}` +
      `${((c.net >= 0 ? "+" : "") + fmt(c.net)).padStart(14)}` +
      `${bias.padStart(8)}` +
      `${String(c.longCount).padStart(5)}` +
      `${String(c.shortCount).padStart(5)}`
    );
  }

  // --- Liquidation clusters ---
  console.log("\n--- LIQUIDATION CLUSTERS (Our Universe) ---");
  for (const coin of COINS) {
    const ca = agg.get(coin);
    if (!ca) continue;
    if (ca.liqPricesAbove.length === 0 && ca.liqPricesBelow.length === 0) continue;

    const above = ca.liqPricesAbove.sort((a, b) => a - b);
    const below = ca.liqPricesBelow.sort((a, b) => b - a);

    console.log(`  ${coin}:`);
    if (above.length > 0) {
      console.log(`    Short liq ABOVE: ${above.map((p) => `$${p.toFixed(4)}`).join(", ")}`);
    }
    if (below.length > 0) {
      console.log(`    Long liq BELOW:  ${below.map((p) => `$${p.toFixed(4)}`).join(", ")}`);
    }
  }

  // --- Consensus signals ---
  console.log("\n--- CONSENSUS SIGNALS (3+ whales same direction) ---");
  let anyConsensus = false;
  for (const [coin, ca] of agg.entries()) {
    if (ca.longCount >= 3) {
      anyConsensus = true;
      console.log(`  ${coin}: ${ca.longCount} whales LONG (total ${fmt(ca.longNotional)})`);
      for (const w of ca.whaleDetails.filter((d) => d.direction === "long")) {
        console.log(`    ${w.addr.slice(0, 10)}... ${fmt(w.notional)} @ ${w.leverage}x  pnl: ${fmt(w.pnl)}`);
      }
    }
    if (ca.shortCount >= 3) {
      anyConsensus = true;
      console.log(`  ${coin}: ${ca.shortCount} whales SHORT (total ${fmt(ca.shortNotional)})`);
      for (const w of ca.whaleDetails.filter((d) => d.direction === "short")) {
        console.log(`    ${w.addr.slice(0, 10)}... ${fmt(w.notional)} @ ${w.leverage}x  pnl: ${fmt(w.pnl)}`);
      }
    }
  }
  if (!anyConsensus) console.log("  No consensus signals found (need 3+ whales same direction)");

  console.log("\n" + "=".repeat(80));
}

// ---------- Main ----------

async function main() {
  console.log("[WhaleTracker] Starting data collection...\n");

  // Step 1: Try leaderboard API
  let addresses: string[] = [];
  console.log("--- STEP 1: Discovering whale addresses ---\n");

  const leaderboardAddrs = await tryLeaderboard();
  if (leaderboardAddrs.length > 0) {
    console.log(`\n[Leaderboard] Found ${leaderboardAddrs.length} addresses`);
    addresses = leaderboardAddrs;
  } else {
    console.log("\n[Leaderboard] No addresses from leaderboard endpoints");
  }

  // Try vault depositors and API exploration
  console.log("\n--- Alternative discovery (vault depositors + API exploration) ---");
  const vaultAddrs = await getVaultDepositors();
  if (vaultAddrs.length > 0) {
    console.log(`[Discovery] Found ${vaultAddrs.length} addresses from vault/exploration`);
    addresses = [...new Set([...addresses, ...vaultAddrs])];
  }

  // Well-known public addresses on Hyperliquid (from on-chain data / public trackers)
  const hardcoded = [
    "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303", // HLP vault
    "0x010461c14e146ac35fe42271bdc1134ee31c703a", // HLP liquidator
    "0x677d831aef5328190852e24f13c46cac05f984e7", // HLP leader (from vault details)
    "0x4f901d1091929099b08814c3be4c2aea21fcb4f6", // market maker
    "0xc64cc00b46150572d5e0b054d3e1f10b5c264921", // public whale
    "0x816b0cff92a2343e20a4fecb0e4a6c04b3f52ea8", // public whale
    "0xb3ca006dd1c5a8f0e7a8f5d54218df0db5d6cb9e", // public whale
    "0xac66594b61581bea1a96cd14e8c3c3db4fc11c70", // public whale
    "0x1fa71dff15baf0d0753d41e29e6703e15904da79", // public whale
    "0x20e1e00e71c1c5a19c0f6ee0ad65a4714a044af4", // public whale
  ];

  // Filter out obviously invalid addresses
  const validHardcoded = hardcoded.filter(
    (a) => /^0x[0-9a-fA-F]{40}$/.test(a)
  );

  // Merge and deduplicate
  const allAddrs = [...new Set([...addresses, ...validHardcoded])];
  console.log(`\n[Tracker] Total unique addresses to check: ${allAddrs.length}`);

  // Step 2: Fetch positions
  console.log("\n--- STEP 2: Fetching positions ---\n");
  const results: NonNullable<Awaited<ReturnType<typeof getPositions>>>[] = [];

  // Batch in groups of 5 to avoid rate limiting
  for (let i = 0; i < allAddrs.length; i += 5) {
    const batch = allAddrs.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map(getPositions));
    for (const r of batchResults) {
      if (r && (r.accountValue > 0 || r.positions.length > 0)) {
        results.push(r);
        console.log(
          `  [OK] ${r.addr.slice(0, 10)}... AccVal: ${fmt(r.accountValue)} Positions: ${r.positions.length}`
        );
      } else if (r) {
        console.log(
          `  [--] ${r.addr.slice(0, 10)}... AccVal: ${fmt(r.accountValue)} (no positions)`
        );
      }
    }
    if (i + 5 < allAddrs.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  console.log(`\n[Tracker] Got data for ${results.length}/${allAddrs.length} addresses`);

  if (results.length === 0) {
    console.log("[Tracker] No position data found. Exiting.");
    return;
  }

  // Filter to accounts with meaningful size (>$1k) and at least 1 position
  const meaningful = results.filter(
    (r) => r.accountValue > 1_000 && r.positions.length > 0
  );
  console.log(`[Tracker] Accounts with >$1k and open positions: ${meaningful.length}`);

  // Fall back to all results if no meaningful ones
  const toReport = meaningful.length > 0 ? meaningful : results.filter((r) => r.positions.length > 0);

  if (toReport.length === 0) {
    console.log("[Tracker] No accounts with open positions found.");
    // Still show account values
    console.log("\n--- ACCOUNT VALUES (no positions) ---");
    for (const r of results.sort((a, b) => b.accountValue - a.accountValue)) {
      console.log(`  ${r.addr.slice(0, 10)}...${r.addr.slice(-4)}  AccVal: ${fmt(r.accountValue)}`);
    }
    return;
  }

  // Step 3+4: Aggregate and report
  const agg = aggregate(toReport);
  const source = addresses.length > 0 ? "Leaderboard API + Known addresses" : "Known addresses only";
  printReport(toReport, agg, source);
}

main().catch((err) => {
  console.error("[WhaleTracker] Fatal error:", err);
  process.exit(1);
});
