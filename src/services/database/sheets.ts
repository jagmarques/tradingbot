import { google, sheets_v4 } from "googleapis";
import { loadEnv } from "../../config/env.js";
import { type TradeRecord, type DailyStats } from "./trades.js";

let sheets: sheets_v4.Sheets | null = null;
let spreadsheetId: string | null = null;

// Initialize Google Sheets client
export async function initSheets(): Promise<void> {
  const env = loadEnv();

  // Skip if Google Sheets not configured
  if (!env.GOOGLE_SHEETS_ID || !env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log("[Sheets] Not configured, skipping initialization");
    return;
  }

  try {
    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    sheets = google.sheets({ version: "v4", auth });
    spreadsheetId = env.GOOGLE_SHEETS_ID;

    // Ensure required sheets exist
    await ensureSheets();

    console.log("[Sheets] Initialized");
  } catch (err) {
    console.error("[Sheets] Initialization failed:", err);
    throw err;
  }
}

// Ensure required sheets/tabs exist
async function ensureSheets(): Promise<void> {
  if (!sheets || !spreadsheetId) return;

  const requiredSheets = ["Trades", "Daily Stats", "Positions", "Summary"];

  try {
    const response = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });

    const existingSheets = response.data.sheets?.map((s) => s.properties?.title) || [];
    const missingSheets = requiredSheets.filter((s) => !existingSheets.includes(s));

    if (missingSheets.length > 0) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: missingSheets.map((title) => ({
            addSheet: { properties: { title } },
          })),
        },
      });

      // Add headers to new sheets
      for (const sheetName of missingSheets) {
        await addHeaders(sheetName);
      }
    }
  } catch (err) {
    console.error("[Sheets] Error ensuring sheets:", err);
  }
}

// Add headers to a sheet
async function addHeaders(sheetName: string): Promise<void> {
  if (!sheets || !spreadsheetId) return;

  const headers: Record<string, string[]> = {
    Trades: [
      "Date",
      "Time",
      "Strategy",
      "Type",
      "Symbol",
      "Amount USD",
      "Price",
      "P&L",
      "P&L %",
      "Fees",
      "TX Hash",
      "Paper",
      "Status",
    ],
    "Daily Stats": [
      "Date",
      "Total Trades",
      "Wins",
      "Losses",
      "Win Rate %",
      "Total P&L",
      "Pump.fun P&L",
      "Polymarket P&L",
      "Fees",
    ],
    Positions: [
      "ID",
      "Strategy",
      "Symbol",
      "Entry Price",
      "Current Price",
      "Amount",
      "Unrealized P&L",
      "Status",
      "Opened At",
    ],
    Summary: ["Metric", "Value"],
  };

  const headerRow = headers[sheetName];
  if (!headerRow) return;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetName}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [headerRow] },
    });
  } catch (err) {
    console.error(`[Sheets] Error adding headers to ${sheetName}:`, err);
  }
}

// Append a trade to the Trades sheet
export async function appendTrade(trade: TradeRecord): Promise<void> {
  if (!sheets || !spreadsheetId) {
    console.warn("[Sheets] Not initialized, skipping trade append");
    return;
  }

  const date = new Date(trade.createdAt);
  const row = [
    date.toISOString().split("T")[0],
    date.toISOString().split("T")[1].split(".")[0],
    trade.strategy,
    trade.type,
    trade.tokenSymbol || trade.tokenAddress || "-",
    trade.amountUsd.toFixed(2),
    trade.price.toFixed(8),
    trade.pnl.toFixed(2),
    trade.pnlPercentage.toFixed(2),
    trade.fees.toFixed(4),
    trade.txHash || "-",
    trade.isPaper ? "Yes" : "No",
    trade.status,
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Trades!A:M",
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
    console.log("[Sheets] Trade appended");
  } catch (err) {
    console.error("[Sheets] Error appending trade:", err);
  }
}

// Update daily stats in the Daily Stats sheet
export async function updateDailyStatsSheet(stats: DailyStats): Promise<void> {
  if (!sheets || !spreadsheetId) {
    console.warn("[Sheets] Not initialized, skipping stats update");
    return;
  }

  const winRate = stats.totalTrades > 0 ? (stats.winningTrades / stats.totalTrades) * 100 : 0;

  const row = [
    stats.date,
    stats.totalTrades.toString(),
    stats.winningTrades.toString(),
    stats.losingTrades.toString(),
    winRate.toFixed(1),
    stats.totalPnl.toFixed(2),
    stats.pumpfunPnl.toFixed(2),
    stats.polymarketPnl.toFixed(2),
    stats.totalFees.toFixed(4),
  ];

  try {
    // First, try to find if date already exists
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Daily Stats!A:A",
    });

    const dates = response.data.values?.flat() || [];
    const rowIndex = dates.findIndex((d) => d === stats.date);

    if (rowIndex > 0) {
      // Update existing row
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Daily Stats!A${rowIndex + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    } else {
      // Append new row
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Daily Stats!A:I",
        valueInputOption: "RAW",
        requestBody: { values: [row] },
      });
    }

    console.log("[Sheets] Daily stats updated for", stats.date);
  } catch (err) {
    console.error("[Sheets] Error updating daily stats:", err);
  }
}

// Update summary sheet with overall metrics
export async function updateSummarySheet(metrics: {
  totalPnl: number;
  todayPnl: number;
  totalTrades: number;
  winRate: number;
  solBalance: number;
  maticBalance: number;
  usdcBalance: number;
}): Promise<void> {
  if (!sheets || !spreadsheetId) {
    console.warn("[Sheets] Not initialized, skipping summary update");
    return;
  }

  const rows = [
    ["Last Updated", new Date().toISOString()],
    ["Total P&L", `$${metrics.totalPnl.toFixed(2)}`],
    ["Today P&L", `$${metrics.todayPnl.toFixed(2)}`],
    ["Total Trades", metrics.totalTrades.toString()],
    ["Win Rate", `${metrics.winRate.toFixed(1)}%`],
    ["SOL Balance", metrics.solBalance.toFixed(4)],
    ["MATIC Balance", metrics.maticBalance.toFixed(4)],
    ["USDC Balance", `$${metrics.usdcBalance.toFixed(2)}`],
  ];

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Summary!A1",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
    console.log("[Sheets] Summary updated");
  } catch (err) {
    console.error("[Sheets] Error updating summary:", err);
  }
}

// Check if sheets is initialized
export function isSheetsInitialized(): boolean {
  return sheets !== null && spreadsheetId !== null;
}

// Get sheets client (for testing)
export function getSheetsClient(): sheets_v4.Sheets | null {
  return sheets;
}
