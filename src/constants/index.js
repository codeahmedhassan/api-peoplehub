export const SIGNUP_COMPANY_SIZES = [
    "1-10",
    "11-50",
    "51-200",
    "201-500",
    "501-1000",
    "1000+",
];

export const SIGNUP_ROLES = [
    "Founder / CEO",
    "HR Manager",
    "HR Executive",
    "People Ops",
    "Operations Manager",
    "Finance",
    "Other",
];

export const USER_STATUS = {
    PENDING: "pending",
    ACTIVE: "active",
    SUSPENDED: "suspended",
};

export const COOKIE_NAMES = {
    ACCESS_TOKEN: "ph_at",
    REFRESH_TOKEN: "ph_rt",
    SIGNUP_PENDING: "ph_signup", // short-lived, proves "I started a signup"
};

// -------------------------------------------------------------------
// Workspace setup options — MUST match the frontend's lib/constants.ts
// -------------------------------------------------------------------
export const SETUP_INDUSTRIES = [
    "Technology",
    "Finance",
    "Healthcare",
    "Retail & eCommerce",
    "Manufacturing",
    "Education",
    "Professional services",
    "Hospitality",
    "Non-profit",
    "Other",
];

export const SETUP_TIMEZONES = [
    "UTC-08:00 Pacific Time",
    "UTC-05:00 Eastern Time",
    "UTC+00:00 Greenwich Mean Time",
    "UTC+01:00 Central European Time",
    "UTC+02:00 Eastern European Time",
    "UTC+04:00 Gulf Standard Time",
    "UTC+05:00 Pakistan Standard Time",
    "UTC+05:30 India Standard Time",
    "UTC+08:00 Singapore Time",
    "UTC+09:00 Japan Standard Time",
    "UTC+10:00 Australian Eastern Time",
];

export const SETUP_TEAM_SIZE_IDS = [
    "solo",
    "small",
    "growing",
    "midsize",
    "large",
    "enterprise",
];

export const SETUP_ACCENT_IDS = [
    "blue",
    "emerald",
    "purple",
    "rose",
    "amber",
    "slate",
];