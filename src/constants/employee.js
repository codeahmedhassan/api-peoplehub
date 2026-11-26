// src/constants/employee.js
// -------------------------------------------------------------------
// Enum / option lists for the Add Employee form.
// MUST match src/lib/employee-form.ts on the frontend (byte-for-byte).
// -------------------------------------------------------------------

export const EMPLOYMENT_TYPES = [
    "Full Time",
    "Part Time",
    "Remote Job",
];

export const EMPLOYMENT_STATUSES = ["Active", "Probation", "Inactive"];

export const WORK_ARRANGEMENTS = ["On-site", "Remote", "Hybrid"];

export const PAY_FREQUENCIES = ["Monthly", "Semi-Monthly", "Bi-Weekly", "Weekly"];

export const CURRENCIES = ["USD", "EUR", "GBP", "PKR", "INR", "AED", "CAD", "AUD"];

export const SYSTEM_ROLES = ["Admin", "Manager", "HR", "Employee", "Viewer", "Custom"];

export const DEPARTMENTS = [];

export const MANAGERS = [];

export const WORK_LOCATIONS = [];

export const EMPLOYEE_CATEGORIES = [
    "Permanent",
    "Contractor",
    "Consultant",
    "Intern",
    "Apprentice",
];

export const PAYROLL_GROUPS = ["Default", "Executive", "Contractors", "Hourly"];

export const DOCUMENT_TYPES = [
    "Employment Contract",
    "National ID",
    "Passport",
    "CV / Résumé",
    "Degree / Certificate",
    "Offer Letter",
    "Tax Form",
    "Profile Photo",
    "Other",
];

// -------------------------------------------------------------------
// Upload constraints
// -------------------------------------------------------------------
// Upload ceiling for multer; per-tier file size caps (5/10/15/25 MB) are enforced in plan.service.js
export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB max ceiling
export const MAX_FILES_PER_EMPLOYEE = 5;

// MIME whitelist (server-side — don't trust the frontend accept attr)
export const ALLOWED_MIME_TYPES = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "image/jpeg",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "application/csv",
]);

// File extensions we accept as a secondary check
export const ALLOWED_EXTENSIONS = new Set([
    ".pdf",
    ".doc",
    ".docx",
    ".png",
    ".jpg",
    ".jpeg",
    ".xls",
    ".xlsx",
    ".csv",
]);

// -------------------------------------------------------------------
// Employee ID counter
// -------------------------------------------------------------------
export const EMPLOYEE_ID_PREFIX = "EMP";
export const EMPLOYEE_ID_START = 1;
export const EMPLOYEE_ID_PAD = 5;
