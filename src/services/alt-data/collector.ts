import { getDb } from "../database/db.js";

const TIMEOUT_MS = 15_000;

interface FngResponse {
  data: Array<{ value: string; timestamp: string }>;
}

async function fetchFearGreed(): Promise<number | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as FngResponse;
    const val = parseInt(json.data?.[0]?.value, 10);
    return Number.isFinite(val) ? val : null;
  } catch (err) {
    console.warn(`[AltData] Fear & Greed fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchSopr(): Promise<number | null> {
  try {
    const res = await fetch("https://bitcoin-data.com/v1/sopr", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const val = Number(json.sopr ?? json.value ?? json.SOPR);
    return Number.isFinite(val) ? val : null;
  } catch (err) {
    console.warn(`[AltData] SOPR fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function fetchNupl(): Promise<number | null> {
  try {
    const res = await fetch("https://bitcoin-data.com/v1/nupl", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
    const val = Number(json.nupl ?? json.value ?? json.NUPL);
    return Number.isFinite(val) ? val : null;
  } catch (err) {
    console.warn(`[AltData] NUPL fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function collectDailyAltData(): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);

  // Check if already collected today
  const db = getDb();
  const existing = db.prepare("SELECT date FROM daily_alt_data WHERE date = ?").get(dateStr);
  if (existing) {
    console.log(`[AltData] Already collected for ${dateStr}, skipping`);
    return;
  }

  console.log(`[AltData] Collecting alternative data for ${dateStr}`);

  const [fearGreed, sopr, nupl] = await Promise.all([
    fetchFearGreed(),
    fetchSopr(),
    fetchNupl(),
  ]);

  // Only save if we got at least one value
  if (fearGreed === null && sopr === null && nupl === null) {
    console.warn("[AltData] All fetches failed, nothing saved");
    return;
  }

  db.prepare(`
    INSERT OR REPLACE INTO daily_alt_data (date, fear_greed, sopr, nupl)
    VALUES (?, ?, ?, ?)
  `).run(dateStr, fearGreed, sopr, nupl);

  console.log(`[AltData] Saved: date=${dateStr} fng=${fearGreed} sopr=${sopr} nupl=${nupl}`);
}
