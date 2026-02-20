import cron from "node-cron";
import { getDb } from "../database/db.js";
import { getDailyPnlBreakdown } from "../risk/manager.js";
import { cleanupOldClosedCopyTrades } from "../traders/storage.js";

let cronJob: cron.ScheduledTask | null = null;
let weeklyCleanupJob: cron.ScheduledTask | null = null;

export interface DailySnapshot {
  date: string;
  totalPnl: number;
  cryptoCopyPnl: number;
  polyCopyPnl: number;
  aiBettingPnl: number;
  quantPnl: number;
  insiderCopyPnl: number;
  rugPnl: number;
}

// Take a snapshot of today's P&L and persist to daily_stats
export function takeDailySnapshot(): void {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  const breakdown = getDailyPnlBreakdown();

  db.prepare(`
    INSERT INTO daily_stats (date, total_pnl, crypto_copy_pnl, poly_copy_pnl, ai_betting_pnl, quant_pnl, insider_copy_pnl, rug_pnl)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total_pnl = excluded.total_pnl,
      crypto_copy_pnl = excluded.crypto_copy_pnl,
      poly_copy_pnl = excluded.poly_copy_pnl,
      ai_betting_pnl = excluded.ai_betting_pnl,
      quant_pnl = excluded.quant_pnl,
      insider_copy_pnl = excluded.insider_copy_pnl,
      rug_pnl = excluded.rug_pnl
  `).run(
    today,
    breakdown.total,
    breakdown.cryptoCopy,
    breakdown.polyCopy,
    breakdown.aiBetting,
    breakdown.quantPnl,
    breakdown.insiderCopyPnl,
    breakdown.rugLosses,
  );

  console.log(`[PnL] Snapshot saved for ${today}: $${breakdown.total.toFixed(2)}`);
}

// Get aggregated P&L for a period (null = all-time)
export function getPnlForPeriod(days: number | null): DailySnapshot {
  const db = getDb();

  // Refresh today's snapshot first
  takeDailySnapshot();

  let row: {
    totalPnl: number;
    cryptoCopyPnl: number;
    polyCopyPnl: number;
    aiBettingPnl: number;
    quantPnl: number;
    insiderCopyPnl: number;
    rugPnl: number;
  };

  if (days === null) {
    row = db.prepare(`
      SELECT
        COALESCE(SUM(total_pnl), 0) as totalPnl,
        COALESCE(SUM(crypto_copy_pnl), 0) as cryptoCopyPnl,
        COALESCE(SUM(poly_copy_pnl), 0) as polyCopyPnl,
        COALESCE(SUM(ai_betting_pnl), 0) as aiBettingPnl,
        COALESCE(SUM(quant_pnl), 0) as quantPnl,
        COALESCE(SUM(insider_copy_pnl), 0) as insiderCopyPnl,
        COALESCE(SUM(rug_pnl), 0) as rugPnl
      FROM daily_stats
    `).get() as typeof row;
  } else {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const dateStr = startDate.toISOString().split("T")[0];

    row = db.prepare(`
      SELECT
        COALESCE(SUM(total_pnl), 0) as totalPnl,
        COALESCE(SUM(crypto_copy_pnl), 0) as cryptoCopyPnl,
        COALESCE(SUM(poly_copy_pnl), 0) as polyCopyPnl,
        COALESCE(SUM(ai_betting_pnl), 0) as aiBettingPnl,
        COALESCE(SUM(quant_pnl), 0) as quantPnl,
        COALESCE(SUM(insider_copy_pnl), 0) as insiderCopyPnl,
        COALESCE(SUM(rug_pnl), 0) as rugPnl
      FROM daily_stats
      WHERE date >= ?
    `).get(dateStr) as typeof row;
  }

  return {
    date: "aggregate",
    totalPnl: row.totalPnl,
    cryptoCopyPnl: row.cryptoCopyPnl,
    polyCopyPnl: row.polyCopyPnl,
    aiBettingPnl: row.aiBettingPnl,
    quantPnl: row.quantPnl,
    insiderCopyPnl: row.insiderCopyPnl,
    rugPnl: row.rugPnl,
  };
}

// Get daily P&L history for charting
export function getDailyPnlHistory(days: number | null): Array<{ date: string; pnl: number }> {
  const db = getDb();

  // Refresh today's snapshot
  takeDailySnapshot();

  if (days === null) {
    return db.prepare(
      `SELECT date, total_pnl as pnl FROM daily_stats ORDER BY date ASC`,
    ).all() as Array<{ date: string; pnl: number }>;
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const dateStr = startDate.toISOString().split("T")[0];

  return db.prepare(
    `SELECT date, total_pnl as pnl FROM daily_stats WHERE date >= ? ORDER BY date ASC`,
  ).all(dateStr) as Array<{ date: string; pnl: number }>;
}

// Generate text-based cumulative P&L chart
export function generatePnlChart(history: Array<{ date: string; pnl: number }>): string {
  if (history.length === 0) return "<i>No data for chart</i>";
  if (history.length === 1) {
    const sign = history[0].pnl >= 0 ? "+" : "";
    return `${history[0].date}: ${sign}$${history[0].pnl.toFixed(2)}`;
  }

  // Calculate cumulative P&L
  let cumulative = 0;
  const points = history.map((h) => {
    cumulative += h.pnl;
    return { date: h.date, cumPnl: cumulative };
  });

  const maxPnl = Math.max(...points.map((p) => p.cumPnl), 0.01);
  const minPnl = Math.min(...points.map((p) => p.cumPnl), -0.01);
  const range = maxPnl - minPnl;

  const chartHeight = 8;
  const maxWidth = 28;

  // Sample points if too many
  const sampled =
    points.length <= maxWidth
      ? points
      : points.filter(
          (_, i) =>
            i % Math.ceil(points.length / maxWidth) === 0 ||
            i === points.length - 1,
        );

  // Find zero line position
  const zeroRow = Math.round(((0 - minPnl) / range) * chartHeight);

  // Build chart rows
  const lines: string[] = [];

  for (let row = chartHeight; row >= 0; row--) {
    let line = "";

    for (const point of sampled) {
      const pointRow = Math.round(((point.cumPnl - minPnl) / range) * chartHeight);

      if (row === zeroRow && pointRow === row) {
        line += point.cumPnl >= 0 ? "█" : "▄";
      } else if (point.cumPnl >= 0 && row <= pointRow && row >= zeroRow) {
        line += "█";
      } else if (point.cumPnl < 0 && row >= pointRow && row <= zeroRow) {
        line += "▓";
      } else if (row === zeroRow) {
        line += "─";
      } else {
        line += " ";
      }
    }

    // Scale labels
    if (row === chartHeight) {
      line += ` $${maxPnl.toFixed(0)}`;
    } else if (row === 0) {
      line += ` $${minPnl.toFixed(0)}`;
    } else if (row === zeroRow && zeroRow !== 0 && zeroRow !== chartHeight) {
      line += " $0";
    }

    lines.push(line);
  }

  // Date axis
  if (sampled.length > 0) {
    const first = sampled[0].date.slice(5); // MM-DD
    const last = sampled[sampled.length - 1].date.slice(5);
    const gap = Math.max(0, sampled.length - first.length - last.length);
    lines.push(first + " ".repeat(gap) + last);
  }

  return lines.join("\n");
}

// Start midnight cron job for daily P&L snapshots
export function startPnlCron(): void {
  if (cronJob) return;

  // Run at 23:59 every day
  cronJob = cron.schedule("59 23 * * *", () => {
    try {
      takeDailySnapshot();
    } catch (err) {
      console.error("[PnL] Snapshot cron error:", err);
    }
  });

  // Take initial snapshot on startup
  try {
    takeDailySnapshot();
  } catch (err) {
    console.error("[PnL] Initial snapshot error:", err);
  }

  // Weekly cleanup: delete closed copy trades older than 7 days (Sundays at 04:00)
  weeklyCleanupJob = cron.schedule("0 4 * * 0", () => {
    try {
      const deleted = cleanupOldClosedCopyTrades();
      if (deleted > 0) {
        console.log(`[PnL] Weekly cleanup: deleted ${deleted} old closed copy trades`);
      }
    } catch (err) {
      console.error("[PnL] Weekly cleanup error:", err);
    }
  });

  console.log("[PnL] Cron started (daily at 23:59, weekly cleanup Sun 04:00)");
}

export function stopPnlCron(): void {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
  if (weeklyCleanupJob) {
    weeklyCleanupJob.stop();
    weeklyCleanupJob = null;
  }
  console.log("[PnL] Cron stopped");
}
