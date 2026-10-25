// src/constants/attendance.js
// -------------------------------------------------------------------
// Enums for attendance records.
// Values are stored as strings on the AttendanceRecord model and used
// throughout the API responses. Frontend mirrors these in lib/constants.ts.
// -------------------------------------------------------------------

export const ATTENDANCE_STATUSES = [
    "unmarked",   // no record yet — only exists during the current day
    "present",
    "late",
    "half-day",
    "absent",
    "on-leave",
    "holiday",
    "weekend",
];

export const ATTENDANCE_SOURCES = [
    "manual",     // an admin clicked Present/Absent/etc
    "device",     // physical attendance machine punch
    "auto",       // rollup job wrote absent/weekend/holiday
    "import",     // bulk import from CSV/etc
];

// "Terminal" statuses are the ones that will not be auto-modified by rollup.
// A manual or device punch is authoritative.
export const TERMINAL_STATUSES = new Set([
    "present",
    "late",
    "half-day",
    "on-leave",
]);

// Statuses that CAN be replaced by manual marking.
// Everything is replaceable — this set exists to make intent explicit.
export const MANUAL_OVERRIDABLE_STATUSES = new Set([
    "unmarked",
    "absent",
    "weekend",
    "holiday",
    "present",
    "late",
    "half-day",
    "on-leave",
]);

// Default weekend days (0=Sunday, 6=Saturday) for new workspaces.
export const DEFAULT_WEEKEND_DAYS = [0, 6];

// Rollup looks back this many days in case the server was down.
export const ROLLUP_LOOKBACK_DAYS = 7;

// Rollup runs at :15 past each hour. If a workspace's local time
// crossed midnight during the previous hour, it gets processed.
export const ROLLUP_INTERVAL_CRON = "15 * * * *";