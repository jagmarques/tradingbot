// Macro event risk filter: reduce position size around high-impact events
// FOMC: BTC dropped after 7/8 meetings in 2025. Reduce to 50% size.
// Free: dates hardcoded (published years ahead)

// 2026 FOMC announcement dates (2:00 PM ET = 19:00 UTC)
const FOMC_DATES_2026 = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
];

// CPI release dates 2026 (8:30 AM ET = 13:30 UTC, usually 2nd Tue/Wed)
const CPI_DATES_2026 = [
  "2026-01-14", "2026-02-12", "2026-03-12", "2026-04-10",
  "2026-05-13", "2026-06-10", "2026-07-15", "2026-08-12",
  "2026-09-16", "2026-10-14", "2026-11-12", "2026-12-10",
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isNearEvent(dates: string[], windowDays: number): boolean {
  const now = Date.now();
  for (const dateStr of dates) {
    const eventTime = new Date(dateStr + "T19:00:00Z").getTime();
    // Window: windowDays before to windowDays after
    if (now >= eventTime - windowDays * DAY_MS && now <= eventTime + windowDays * DAY_MS) {
      return true;
    }
  }
  return false;
}

// Returns position size multiplier based on upcoming events
// 1.0 = normal, 0.5 = reduce to half (FOMC), 0.75 = reduce to 75% (CPI)
export function getEventSizeMultiplier(): number {
  // FOMC: 24h window, 50% size
  if (isNearEvent(FOMC_DATES_2026, 1)) {
    console.log("[EventCalendar] FOMC window active - position size reduced to 50%");
    return 0.5;
  }
  // CPI: 12h window (same day only), 75% size
  if (isNearEvent(CPI_DATES_2026, 0.5)) {
    console.log("[EventCalendar] CPI window active - position size reduced to 75%");
    return 0.75;
  }
  return 1.0;
}
