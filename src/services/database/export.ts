import { getTrades, getStatsRange, type DailyStats } from "./trades.js";
import fs from "fs";
import path from "path";

// Export trades to CSV for tax purposes
export function exportTradesToCsv(options: {
  startDate?: string;
  endDate?: string;
  strategy?: "polymarket";
  outputPath?: string;
}): string {
  const trades = getTrades({
    startDate: options.startDate,
    endDate: options.endDate,
    strategy: options.strategy,
  });

  const headers = [
    "Date",
    "Time",
    "Strategy",
    "Type",
    "Token Symbol",
    "Token Address",
    "Amount USD",
    "Amount Tokens",
    "Price",
    "P&L USD",
    "P&L %",
    "Fees",
    "TX Hash",
    "Paper Trade",
    "Status",
  ];

  const rows = trades.map((trade) => {
    const date = new Date(trade.createdAt);
    return [
      date.toISOString().split("T")[0],
      date.toISOString().split("T")[1].split(".")[0],
      trade.strategy,
      trade.type,
      trade.tokenSymbol || "",
      trade.tokenAddress || "",
      trade.amountUsd.toFixed(2),
      trade.amountTokens?.toString() || "",
      trade.price.toFixed(8),
      trade.pnl.toFixed(2),
      trade.pnlPercentage.toFixed(2),
      trade.fees.toFixed(4),
      trade.txHash || "",
      trade.isPaper ? "Yes" : "No",
      trade.status,
    ];
  });

  const csv = [headers.join(","), ...rows.map((row) => row.map(escapeCsvField).join(","))].join("\n");

  if (options.outputPath) {
    const dir = path.dirname(options.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.outputPath, csv);
    console.log(`[Export] CSV written to ${options.outputPath}`);
  }

  return csv;
}

// Export daily stats to CSV
export function exportStatsToCsv(options: {
  startDate: string;
  endDate: string;
  outputPath?: string;
}): string {
  const stats = getStatsRange(options.startDate, options.endDate);

  const headers = [
    "Date",
    "Total Trades",
    "Winning Trades",
    "Losing Trades",
    "Win Rate %",
    "Total P&L",
    "Polymarket P&L",
    "Total Fees",
  ];

  const rows = stats.map((stat) => {
    const winRate = stat.totalTrades > 0 ? (stat.winningTrades / stat.totalTrades) * 100 : 0;
    return [
      stat.date,
      stat.totalTrades.toString(),
      stat.winningTrades.toString(),
      stat.losingTrades.toString(),
      winRate.toFixed(1),
      stat.totalPnl.toFixed(2),
      stat.polymarketPnl.toFixed(2),
      stat.totalFees.toFixed(4),
    ];
  });

  const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

  if (options.outputPath) {
    const dir = path.dirname(options.outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(options.outputPath, csv);
    console.log(`[Export] Stats CSV written to ${options.outputPath}`);
  }

  return csv;
}

// Export tax report (summary + trades)
export function exportTaxReport(year: number, outputDir: string): { tradesPath: string; summaryPath: string } {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const tradesPath = path.join(outputDir, `trades_${year}.csv`);
  const summaryPath = path.join(outputDir, `summary_${year}.csv`);

  exportTradesToCsv({ startDate, endDate, outputPath: tradesPath });
  exportStatsToCsv({ startDate, endDate, outputPath: summaryPath });

  // Calculate year totals
  const trades = getTrades({ startDate, endDate });
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const totalFees = trades.reduce((sum, t) => sum + t.fees, 0);

  const yearSummary = [
    `Tax Year: ${year}`,
    `Total Trades: ${trades.length}`,
    `Total P&L: $${totalPnl.toFixed(2)}`,
    `Total Fees: $${totalFees.toFixed(2)}`,
    `Net P&L: $${(totalPnl - totalFees).toFixed(2)}`,
    "",
    "Note: Consult a tax professional for accurate reporting.",
  ].join("\n");

  const readmePath = path.join(outputDir, `README_${year}.txt`);
  fs.writeFileSync(readmePath, yearSummary);

  console.log(`[Export] Tax report for ${year} written to ${outputDir}`);

  return { tradesPath, summaryPath };
}

// Generate monthly summary
export function getMonthlyReport(year: number, month: number): {
  totalTrades: number;
  totalPnl: number;
  polymarketPnl: number;
  winRate: number;
  bestDay: DailyStats | null;
  worstDay: DailyStats | null;
} {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const endDate = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;

  const stats = getStatsRange(startDate, endDate);

  const totalTrades = stats.reduce((sum, s) => sum + s.totalTrades, 0);
  const winningTrades = stats.reduce((sum, s) => sum + s.winningTrades, 0);
  const totalPnl = stats.reduce((sum, s) => sum + s.totalPnl, 0);
  const polymarketPnl = stats.reduce((sum, s) => sum + s.polymarketPnl, 0);

  const sortedByPnl = [...stats].sort((a, b) => b.totalPnl - a.totalPnl);

  return {
    totalTrades,
    totalPnl,
    polymarketPnl,
    winRate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
    bestDay: sortedByPnl[0] || null,
    worstDay: sortedByPnl[sortedByPnl.length - 1] || null,
  };
}

// Helper to escape CSV fields
function escapeCsvField(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}
