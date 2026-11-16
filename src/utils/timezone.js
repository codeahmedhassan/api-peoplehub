// src/utils/timezone.js
// Small helpers to convert workspace timezone strings (e.g. "UTC+05:00 Pakistan Standard Time")
// into a fixed offset, and compute date strings in that offset.

/**
 * Parse a SETUP_TIMEZONES-style string into an offset in minutes.
 * Returns null if the format isn't recognized.
 *
 * "UTC+05:00 Pakistan Standard Time"  → 300
 * "UTC-08:00 Pacific Time"             → -480
 * "UTC+00:00 Greenwich Mean Time"      → 0
 */
export function parseTimezoneOffsetMinutes(timezoneString) {
    if (typeof timezoneString !== "string") return null;
    const m = timezoneString.match(/^UTC([+-])(\d{2}):(\d{2})/);
    if (!m) return null;
    const sign = m[1] === "+" ? 1 : -1;
    const hours = Number(m[2]);
    const minutes = Number(m[3]);
    return sign * (hours * 60 + minutes);
}

/**
 * Return "YYYY-MM-DD" for the given Date in the given timezone.
 * Falls back to UTC if the timezone string can't be parsed.
 */
export function getDateInTimezone(date, timezoneString) {
    const offsetMin = parseTimezoneOffsetMinutes(timezoneString);
    const shiftMs = (offsetMin ?? 0) * 60 * 1000;
    const shifted = new Date(date.getTime() + shiftMs);
    return shifted.toISOString().slice(0, 10);
}

/**
 * Return the Date at 00:00:00 in the given timezone, expressed as UTC.
 * Used to compute "the moment a day started" for rollup boundaries.
 */
export function startOfDayInTimezone(dateString, timezoneString) {
    const offsetMin = parseTimezoneOffsetMinutes(timezoneString) ?? 0;
    if (!dateString || typeof dateString !== "string" || !dateString.includes("-")) {
        return new Date();
    }
    const [y, m, d] = dateString.split("-").map(Number);
    const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
    return new Date(utcMidnight - offsetMin * 60 * 1000);
}

/**
 * Given a "today" (in workspace TZ) and a lookback count, return an array
 * of date strings to process, oldest first, ending on yesterday-in-local-time.
 *
 * The rollup always processes *completed* days, so `today` itself is excluded.
 */
export function getRollupDates(todayLocal, lookbackDays) {
    if (!todayLocal || typeof todayLocal !== "string" || !todayLocal.includes("-")) {
        todayLocal = new Date().toISOString().slice(0, 10);
    }
    const [y, m, d] = todayLocal.split("-").map(Number);
    const out = [];
    for (let i = lookbackDays; i >= 1; i--) {
        const dt = new Date(Date.UTC(y, m - 1, d - i));
        out.push(dt.toISOString().slice(0, 10));
    }
    return out;
}

/**
 * Day of week (0 = Sunday, 6 = Saturday) for a "YYYY-MM-DD" string.
 */
export function dayOfWeek(dateString) {
    if (!dateString || typeof dateString !== "string" || !dateString.includes("-")) {
        return new Date().getUTCDay();
    }
    const [y, m, d] = dateString.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Return true if the given date is a weekend in the given weekendDays array.
 */
export function isWeekend(dateString, weekendDays) {
    return Array.isArray(weekendDays) && weekendDays.includes(dayOfWeek(dateString));
}

/**
 * Compare two "YYYY-MM-DD" strings. Negative if a < b, zero if equal, positive if a > b.
 */
export function compareDateStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}