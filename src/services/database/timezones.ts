import { getDb } from "./db.js";

export function getUserTimezone(telegramUserId: string): string | null {
  const db = getDb();
  const stmt = db.prepare("SELECT timezone FROM user_timezones WHERE telegram_user_id = ?");
  const row = stmt.get(telegramUserId) as { timezone: string } | undefined;

  return row ? row.timezone : null;
}

export function setUserTimezone(telegramUserId: string, timezone: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO user_timezones (telegram_user_id, timezone, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      timezone = excluded.timezone,
      updated_at = excluded.updated_at
  `);

  stmt.run(telegramUserId, timezone, now);
}

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
