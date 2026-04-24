import { sendMessage } from "../telegram/bot.js";
import { getDb } from "../database/db.js";
import { getOpenQuantPositions } from "../hyperliquid/executor.js";
import { getPaperStartDate } from "../database/quant.js";
import { getTradingMode } from "../../config/env.js";
import { QUANT_PAPER_VALIDATION_DAYS } from "../../config/constants.js";
import { collectDailyAltData } from "../alt-data/collector.js";

// --- State ---
let digestInterval: ReturnType<typeof setInterval> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let apiCheckInterval: ReturnType<typeof setInterval> | null = null;
let altDataInterval: ReturnType<typeof setInterval> | null = null;
let apiFailCount = 0;
let apiAlertSent = false;
const recentErrors: string[] = [];
const MAX_RECENT_ERRORS = 20;

// --- Public error recorder (other modules can push errors here) ---
export function recordError(msg: string): void {
  recentErrors.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

// --- Engine labels ---
const ENGINE_LABELS: Record<string, string> = {
  "donchian-trend": "DT",
  "supertrend-4h": "ST",
  "garch-v2": "GV",
  "carry-momentum": "CM",
  "range-expansion": "RE",
};

function engineTag(tradeType: string): string {
  return ENGINE_LABELS[tradeType] ?? tradeType.slice(0, 2).toUpperCase();
}

// ============================================================
// 1. Daily P&L Digest (fires at 23:55 UTC)
// ============================================================

interface EngineRow {
  trade_type: string;
  total_pnl: number | null;
  trade_count: number;
  wins: number;
}

function queryDailyTrades(): EngineRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT trade_type,
           COALESCE(SUM(pnl), 0) as total_pnl,
           COUNT(*) as trade_count,
           SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins
    FROM quant_trades
    WHERE updated_at > datetime('now', '-24 hours')
      AND status = 'closed'
    GROUP BY trade_type
  `).all() as EngineRow[];
}

function formatPnl(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}$${v.toFixed(2)}`;
}

export async function sendDailyDigest(): Promise<void> {
  try {
    const rows = queryDailyTrades();
    const totalPnl = rows.reduce((s, r) => s + (r.total_pnl ?? 0), 0);

    // Engine breakdown
    const lines = rows.map((r) => {
      const tag = engineTag(r.trade_type);
      const wr = r.trade_count > 0 ? ((r.wins / r.trade_count) * 100).toFixed(0) : "0";
      return `  [${tag}] ${r.trade_type}: ${formatPnl(r.total_pnl ?? 0)} (${r.trade_count} trades, ${wr}% WR)`;
    });

    // Open positions
    const openPositions = getOpenQuantPositions();
    const deployedUsd = openPositions.reduce((s, p) => s + p.size, 0);

    // Validation day
    let validationLine = "";
    const startDate = getPaperStartDate();
    if (startDate) {
      const dayN = Math.floor((Date.now() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24));
      validationLine = `\nDay ${dayN} of ${QUANT_PAPER_VALIDATION_DAYS}-day validation`;
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const mode = getTradingMode();

    const message =
      `<b>DAILY REPORT ${dateStr}</b>\n` +
      `Mode: ${mode}\n\n` +
      `<b>Realized P&amp;L: ${formatPnl(totalPnl)}</b>\n` +
      (lines.length > 0 ? lines.join("\n") + "\n" : "  No closed trades today\n") +
      `\nOpen: ${openPositions.length} positions ($${deployedUsd.toFixed(0)} deployed)` +
      validationLine;

    await sendMessage(message);
    console.log(`[Monitor] Daily digest sent: ${formatPnl(totalPnl)}, ${rows.reduce((s, r) => s + r.trade_count, 0)} trades`);
  } catch (err) {
    console.error(`[Monitor] Daily digest error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// 2. Hourly Heartbeat
// ============================================================

export async function sendHourlyHeartbeat(): Promise<void> {
  try {
    const now = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const positions = getOpenQuantPositions();

    // Today's realized P&L
    const db = getDb();
    const row = db.prepare(`
      SELECT COALESCE(SUM(pnl), 0) as today_pnl
      FROM quant_trades
      WHERE updated_at > datetime('now', '-24 hours')
        AND status = 'closed'
    `).get() as { today_pnl: number };
    const todayPnl = row.today_pnl;

    // Unrealized P&L from open positions
    let unrealizedPnl = 0;
    try {
      const { getClient } = await import("../hyperliquid/client.js");
      const sdk = getClient();
      const mids = await sdk.info.getAllMids(true) as Record<string, string>;
      for (const pos of positions) {
        const rawPrice = mids[pos.pair];
        if (!rawPrice) continue;
        const price = parseFloat(rawPrice);
        if (isNaN(price)) continue;
        const pricePct = pos.direction === "long"
          ? (price - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - price) / pos.entryPrice;
        unrealizedPnl += pricePct * pos.size * (pos.leverage ?? 5);
      }
    } catch { /* skip unrealized if price fetch fails */ }

    // Errors in last hour
    const oneHourAgo = Date.now() - 3600_000;
    const hourErrors = recentErrors.filter((e) => {
      const ts = e.slice(0, 8); // HH:MM:SS
      const parts = ts.split(":");
      const errDate = new Date();
      errDate.setUTCHours(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]), 0);
      return errDate.getTime() >= oneHourAgo;
    });

    const errStr = hourErrors.length > 0
      ? `${hourErrors.length} error(s)`
      : "No errors";

    const message = `[HB] ${hhmm} UTC | ${positions.length} pos | ${formatPnl(todayPnl)} realized | ${formatPnl(unrealizedPnl)} unr | ${errStr}`;
    await sendMessage(message);
    console.log(`[Monitor] Heartbeat: ${message}`);
  } catch (err) {
    console.error(`[Monitor] Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// 3. HL API Health Check (every 60s, alert after 3 consecutive failures)
// ============================================================

async function checkHlApi(): Promise<void> {
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Success - reset counters
    if (apiAlertSent && apiFailCount === 0) {
      // Was alerted, now recovered
      await sendMessage("[RECOVERED] HL API responding again.");
      apiAlertSent = false;
    }
    apiFailCount = 0;
  } catch (err) {
    apiFailCount++;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Monitor] HL API check failed (${apiFailCount}/3): ${msg}`);
    recordError(`HL API: ${msg}`);

    if (apiFailCount >= 3 && !apiAlertSent) {
      await sendMessage("[ALERT] HL API unresponsive for 3 minutes! Positions may be unprotected.");
      apiAlertSent = true;
    }
  }
}

// ============================================================
// Scheduling
// ============================================================

function msUntilUtcTime(hour: number, minute: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(hour, minute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

export function startMonitors(): void {
  // Daily digest at 23:55 UTC
  const msToDigest = msUntilUtcTime(23, 55);
  const DAY_MS = 24 * 60 * 60 * 1000;
  setTimeout(() => {
    void sendDailyDigest();
    digestInterval = setInterval(() => { void sendDailyDigest(); }, DAY_MS);
  }, msToDigest);
  console.log(`[Monitor] Daily digest scheduled (first in ${Math.round(msToDigest / 60_000)}m)`);

  // Hourly heartbeat
  const HOUR_MS = 60 * 60 * 1000;
  const msToNextHour = HOUR_MS - (Date.now() % HOUR_MS);
  setTimeout(() => {
    void sendHourlyHeartbeat();
    heartbeatInterval = setInterval(() => { void sendHourlyHeartbeat(); }, HOUR_MS);
  }, msToNextHour);
  console.log(`[Monitor] Hourly heartbeat scheduled (first in ${Math.round(msToNextHour / 60_000)}m)`);

  // HL API check every 60s
  apiCheckInterval = setInterval(() => { void checkHlApi(); }, 60_000);
  console.log("[Monitor] HL API health check started (60s interval)");

  // Daily alt data collection at 01:00 UTC
  const msToAltData = msUntilUtcTime(1, 0);
  setTimeout(() => {
    void collectDailyAltData();
    altDataInterval = setInterval(() => { void collectDailyAltData(); }, DAY_MS);
  }, msToAltData);
  console.log(`[Monitor] Alt data collection scheduled (first in ${Math.round(msToAltData / 60_000)}m)`);
}

export function stopMonitors(): void {
  if (digestInterval) { clearInterval(digestInterval); digestInterval = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (apiCheckInterval) { clearInterval(apiCheckInterval); apiCheckInterval = null; }
  if (altDataInterval) { clearInterval(altDataInterval); altDataInterval = null; }
  console.log("[Monitor] All monitors stopped");
}
