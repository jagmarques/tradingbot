// Bot settings storage
import { getDb } from "../database/db.js";
import { isPaperMode } from "../../config/env.js";

export interface BotSettings {
  autoCopyEnabled: boolean;
  minTraderScore: number;
  maxCopyPerDay: number;
  dailyCopyCount: number;
  // Fixed copy amounts per chain (in native token)
  copyAmountEth: number;
  copyAmountMatic: number;
  copyAmountDefault: number;
  // Polymarket copy amount (in USD)
  polymarketCopyUsd: number;
}

const DEFAULT_SETTINGS: BotSettings = {
  autoCopyEnabled: false,
  minTraderScore: 70,
  maxCopyPerDay: 10,
  dailyCopyCount: 0,
  copyAmountEth: 0.001, // ~$3
  copyAmountMatic: 2, // ~$1.50
  copyAmountDefault: 0.005, // ~$2-5
  polymarketCopyUsd: 5, // $5 per copy
};

export function getSettings(telegramUserId: string): BotSettings {
  const db = getDb();

  const row = db
    .prepare("SELECT * FROM bot_settings WHERE telegram_user_id = ?")
    .get(telegramUserId) as {
      auto_copy_enabled: number;
      min_trader_score: number;
      max_copy_per_day: number;
      daily_copy_count: number;
      daily_copy_reset: string | null;
      copy_amount_eth: number | null;
      copy_amount_matic: number | null;
      copy_amount_default: number | null;
      polymarket_copy_usd: number | null;
    } | undefined;

  if (!row) {
    // Create default settings for new user
    createDefaultSettings(telegramUserId);
    return { ...DEFAULT_SETTINGS };
  }

  // Check if daily count needs reset (new day)
  const today = new Date().toISOString().split("T")[0];
  let dailyCount = row.daily_copy_count;

  if (row.daily_copy_reset !== today) {
    // Reset daily count
    db.prepare(
      "UPDATE bot_settings SET daily_copy_count = 0, daily_copy_reset = ? WHERE telegram_user_id = ?"
    ).run(today, telegramUserId);
    dailyCount = 0;
  }

  return {
    autoCopyEnabled: row.auto_copy_enabled === 1,
    minTraderScore: row.min_trader_score,
    maxCopyPerDay: row.max_copy_per_day,
    dailyCopyCount: dailyCount,
    copyAmountEth: row.copy_amount_eth ?? DEFAULT_SETTINGS.copyAmountEth,
    copyAmountMatic: row.copy_amount_matic ?? DEFAULT_SETTINGS.copyAmountMatic,
    copyAmountDefault: row.copy_amount_default ?? DEFAULT_SETTINGS.copyAmountDefault,
    polymarketCopyUsd: row.polymarket_copy_usd ?? DEFAULT_SETTINGS.polymarketCopyUsd,
  };
}

function createDefaultSettings(telegramUserId: string): void {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];

  db.prepare(`
    INSERT INTO bot_settings (
      telegram_user_id, auto_copy_enabled,
      min_trader_score, max_copy_per_day,
      daily_copy_count, daily_copy_reset, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    telegramUserId,
    DEFAULT_SETTINGS.autoCopyEnabled ? 1 : 0,
    DEFAULT_SETTINGS.minTraderScore,
    DEFAULT_SETTINGS.maxCopyPerDay,
    0,
    today,
    new Date().toISOString()
  );
}

export function updateSetting<K extends keyof BotSettings>(
  telegramUserId: string,
  key: K,
  value: BotSettings[K]
): void {
  const db = getDb();

  // Ensure settings exist
  getSettings(telegramUserId);

  const columnMap: Record<keyof BotSettings, string> = {
    autoCopyEnabled: "auto_copy_enabled",
    minTraderScore: "min_trader_score",
    maxCopyPerDay: "max_copy_per_day",
    dailyCopyCount: "daily_copy_count",
    copyAmountEth: "copy_amount_eth",
    copyAmountMatic: "copy_amount_matic",
    copyAmountDefault: "copy_amount_default",
    polymarketCopyUsd: "polymarket_copy_usd",
  };

  const column = columnMap[key];
  const dbValue = typeof value === "boolean" ? (value ? 1 : 0) : value;

  db.prepare(
    `UPDATE bot_settings SET ${column} = ?, updated_at = ? WHERE telegram_user_id = ?`
  ).run(dbValue, new Date().toISOString(), telegramUserId);
}

export function toggleAutoCopy(telegramUserId: string): boolean {
  const settings = getSettings(telegramUserId);
  const newValue = !settings.autoCopyEnabled;
  updateSetting(telegramUserId, "autoCopyEnabled", newValue);
  return newValue;
}

export function incrementDailyCopyCount(telegramUserId: string): number {
  const db = getDb();
  const settings = getSettings(telegramUserId);
  const newCount = settings.dailyCopyCount + 1;

  db.prepare(
    "UPDATE bot_settings SET daily_copy_count = ?, updated_at = ? WHERE telegram_user_id = ?"
  ).run(newCount, new Date().toISOString(), telegramUserId);

  return newCount;
}

export function canCopyTrade(telegramUserId: string): boolean {
  const settings = getSettings(telegramUserId);
  if (isPaperMode()) {
    return settings.autoCopyEnabled;
  }
  return settings.autoCopyEnabled && settings.dailyCopyCount < settings.maxCopyPerDay;
}
