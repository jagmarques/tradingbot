// Date parsing utilities for Polymarket API dates

/**
 * Parse a date string or timestamp into milliseconds since epoch.
 * Handles ISO 8601 strings, Unix timestamps (seconds or milliseconds).
 * Returns null for invalid dates instead of NaN.
 */
export function parseDate(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  let timestamp: number;

  if (typeof value === "number") {
    // If number is small enough to be seconds (before year 2100 in ms would be > 4e12)
    // Unix timestamps in seconds are typically 10 digits (e.g., 1738800000)
    // Unix timestamps in milliseconds are typically 13 digits (e.g., 1738800000000)
    if (value < 1e11) {
      // Likely seconds - convert to ms
      timestamp = value * 1000;
    } else {
      // Already milliseconds
      timestamp = value;
    }
  } else {
    // String - try to parse
    const parsed = Date.parse(value);
    if (isNaN(parsed)) {
      // Try parsing as numeric string (Unix timestamp)
      const numericValue = Number(value);
      if (!isNaN(numericValue)) {
        return parseDate(numericValue);
      }
      return null;
    }
    timestamp = parsed;
  }

  // Sanity check: date should be between year 2000 and 2100
  const year2000 = 946684800000; // Jan 1, 2000
  const year2100 = 4102444800000; // Jan 1, 2100

  if (timestamp < year2000 || timestamp > year2100) {
    return null;
  }

  return timestamp;
}

/**
 * Get minutes until a date, or null if date is invalid.
 */
export function minutesUntil(endDate: string | number | null | undefined): number | null {
  const endTime = parseDate(endDate);
  if (endTime === null) {
    return null;
  }
  return (endTime - Date.now()) / (1000 * 60);
}

/**
 * Get hours until a date, or null if date is invalid.
 */
export function hoursUntil(endDate: string | number | null | undefined): number | null {
  const endTime = parseDate(endDate);
  if (endTime === null) {
    return null;
  }
  return (endTime - Date.now()) / (1000 * 60 * 60);
}
