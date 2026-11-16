// src/validators/employee/employee.validator.js
import Joi from "joi";
import {
    EMPLOYMENT_TYPES,
    EMPLOYMENT_STATUSES,
    WORK_ARRANGEMENTS,
    PAY_FREQUENCIES,
    CURRENCIES,
    SYSTEM_ROLES,
    DEPARTMENTS,
    WORK_LOCATIONS,
    EMPLOYEE_CATEGORIES,
    PAYROLL_GROUPS,
    DOCUMENT_TYPES,
} from "../../constants/employee.js";

const optionalString = (max = 200) =>
    Joi.string().trim().max(max).allow("").default("");

export const createEmployeeSchema = Joi.object({
    // --- Basic ---
    employeeId: optionalString(60),
    firstName: Joi.string().trim().min(1).max(60).required(),
    lastName: Joi.string().trim().max(60).allow("", null).optional().default(""),
    phone: Joi.string().trim().min(6).max(40).required(),
    preferredName: optionalString(60),
    gender: Joi.string().valid("Male", "Female", "Other", "").default(""),
    avatar: optionalString(500),
    manuallyPickedAvatar: Joi.boolean().default(false),

    // --- Employment ---
    employmentStatus: Joi.string().valid(...EMPLOYMENT_STATUSES).required(),
    employmentType: Joi.string().valid(...EMPLOYMENT_TYPES).required(),
    designation: optionalString(120),
    branch: optionalString(120),
    department: Joi.string().trim().min(1).max(120).required(),
    reportingManager: optionalString(120),
    joiningDate: Joi.string().isoDate().required(),
    workLocation: optionalString(120),
    workArrangement: Joi.string().valid(...WORK_ARRANGEMENTS, "").default(""),
    probationStatus: Joi.string().valid("In Probation", "Passed", "Extended", "Not Applicable", "").default("In Probation"),
    probationEndDate: Joi.alternatives().try(Joi.string().isoDate(), Joi.date(), Joi.string().allow(""), Joi.valid(null)).default(null),
    contractEndDate: Joi.alternatives().try(Joi.string().isoDate(), Joi.date(), Joi.string().allow(""), Joi.valid(null)).default(null),
    employeeCategory: Joi.string().valid(...EMPLOYEE_CATEGORIES, "").default(""),

    // --- Contact ---
    personalEmail: Joi.string().email().max(254).allow("", null).default(""),
    workEmail: Joi.string().email().max(254).allow("", null).default(""),
    dateOfBirth: Joi.alternatives().try(Joi.string().isoDate(), Joi.date(), Joi.string().allow(""), Joi.valid(null)).default(null),
    residentialAddress: optionalString(300),
    city: optionalString(100),
    country: optionalString(100),
    emergencyName: optionalString(120),
    emergencyRelation: optionalString(60),
    emergencyPhone: optionalString(40),
    referenceName: optionalString(120),
    referenceRelation: optionalString(60),
    referencePhone: optionalString(40),
    referenceAddress: optionalString(300),

    // --- Work & Attendance ---
    workSchedule: Joi.string().trim().max(200).allow("").default("8 hours"),
    workingHours: Joi.number().min(1).max(24).optional(),
    workShift: optionalString(100),
    weeklyWorkingDays: optionalString(100),
    attendanceLocation: optionalString(150),
    attendanceMethod: optionalString(100),
    attendanceEligibility: Joi.string().valid("Eligible", "Not Eligible").default("Eligible"),
    overtimeEligibility: Joi.boolean().default(false),
    timeZone: optionalString(100),

    // --- Compensation ---
    salaryAmount: Joi.number().min(0).required(),
    salaryCurrency: Joi.string().valid(...CURRENCIES).default("USD"),
    payFrequency: Joi.string().valid(...PAY_FREQUENCIES).required(),
    bankAccountName: optionalString(150),
    bankAccountNumber: optionalString(60),
    bankName: optionalString(150),
    taxIdentifier: optionalString(60),
    payrollGroup: optionalString(120),

    // --- Qualifications & Professional Background ---
    education: Joi.array().items(Joi.object().unknown(true)).default([]),
    experience: Joi.array().items(Joi.object().unknown(true)).default([]),
    certificates: Joi.array().items(Joi.object().unknown(true)).default([]),
    permissions: Joi.object().unknown(true).optional().default({}),

    // --- Documents & Access ---
    nationalId: Joi.string().trim().min(1).max(60).required(),
    createLogin: Joi.boolean().default(false),
    loginEmail: Joi.string().email().max(254).allow("", null).default(""),
    systemRole: Joi.string().valid(...SYSTEM_ROLES).default("Employee"),
    sendInvitation: Joi.boolean().default(false),

    // Per-file metadata (JSON array, one per uploaded file, matched by index)
    fileMeta: Joi.array()
        .items(
            Joi.object({
                fileId: Joi.string().trim().min(1).max(64).required(),
                type: Joi.string().valid(...DOCUMENT_TYPES).required(),
                label: Joi.string().trim().min(1).max(100).required(),
            })
        )
        .max(5)
        .default([]),
    draftDocuments: Joi.array().items(Joi.object().unknown(true)).max(5).default([]),
}).custom((value, helpers) => {
    if (!value.createLogin) {
        value.sendInvitation = false;
        value.loginEmail = "";
    } else {
        if (!value.loginEmail) {
            return helpers.message("Login email is required when Create Login is enabled");
        }
    }
    return value;
});


/**
 * PATCH /employees/:id — partial update.
 * Same field set as create, but every field is optional and no `fileMeta`
 * is accepted (documents use POST /employees/:id/documents).
 */
export const updateEmployeeSchema = Joi.object({
    // Basic
    firstName: Joi.string().trim().min(1).max(60),
    lastName: Joi.string().trim().min(1).max(60),
    phone: Joi.string().trim().min(6).max(40),
    preferredName: Joi.string().trim().max(60).allow(""),
    gender: Joi.string().valid("Male", "Female", "Other", ""),
    avatar: Joi.string().allow("").max(500),
    manuallyPickedAvatar: Joi.boolean(),

    // Employment
    employmentStatus: Joi.string().valid(...EMPLOYMENT_STATUSES),
    employmentType: Joi.string().valid(...EMPLOYMENT_TYPES),
    designation: Joi.string().trim().max(120).allow(""),
    branch: optionalString(120),
    department: Joi.string().trim().min(1).max(120).allow(""),
    reportingManager: Joi.string().trim().max(120).allow(""),
    joiningDate: Joi.string().isoDate(),
    workLocation: optionalString(120),
    workArrangement: Joi.string().valid(...WORK_ARRANGEMENTS, ""),
    probationStatus: Joi.string().valid("In Probation", "Passed", "Extended", "Not Applicable", "").allow(""),
    probationEndDate: Joi.string().isoDate().allow("", null),
    contractEndDate: Joi.string().isoDate().allow("", null),
    employeeCategory: Joi.string().valid(...EMPLOYEE_CATEGORIES, ""),

    // Contact
    personalEmail: Joi.string().email().max(254).allow(""),
    workEmail: Joi.string().email().max(254).allow("", null),
    dateOfBirth: Joi.string().isoDate().allow("", null),
    residentialAddress: Joi.string().trim().max(300).allow(""),
    city: Joi.string().trim().max(100).allow(""),
    country: Joi.string().trim().max(100).allow(""),
    emergencyName: Joi.string().trim().max(120).allow(""),
    emergencyRelation: Joi.string().trim().max(60).allow(""),
    emergencyPhone: Joi.string().trim().max(40).allow(""),
    referenceName: Joi.string().trim().max(120).allow(""),
    referenceRelation: Joi.string().trim().max(60).allow(""),
    referencePhone: Joi.string().trim().max(40).allow(""),
    referenceAddress: Joi.string().trim().max(300).allow(""),

    // Work & Attendance
    workSchedule: Joi.string().trim().max(200).allow(""),
    workingHours: Joi.number().min(1).max(24).optional(),
    workShift: Joi.string().trim().max(100).allow(""),
    weeklyWorkingDays: Joi.string().trim().max(100).allow(""),
    attendanceLocation: Joi.string().trim().max(150).allow(""),
    attendanceMethod: Joi.string().trim().max(100).allow(""),
    attendanceEligibility: Joi.string().valid("Eligible", "Not Eligible"),
    overtimeEligibility: Joi.boolean(),
    timeZone: Joi.string().trim().max(100).allow(""),

    // Compensation
    salaryAmount: Joi.number().min(0),
    salaryCurrency: Joi.string().valid(...CURRENCIES),
    salaryChangeReason: optionalString(200),
    payFrequency: Joi.string().valid(...PAY_FREQUENCIES),
    bankAccountName: Joi.string().trim().max(150).allow(""),
    bankAccountNumber: Joi.string().trim().max(60).allow(""),
    bankName: Joi.string().trim().max(150).allow(""),
    taxIdentifier: Joi.string().trim().max(60).allow(""),
    payrollGroup: Joi.string().trim().max(120).allow(""),

    // Confidential
    confidentialNotes: optionalString(2000),
    backgroundCheckStatus: Joi.string().valid("Verified", "Pending", "Failed", "In Progress", "").allow(""),

    // Qualifications & Background
    education: Joi.array().items(Joi.object().unknown(true)),
    experience: Joi.array().items(Joi.object().unknown(true)),
    certificates: Joi.array().items(Joi.object().unknown(true)),
    permissions: Joi.object().unknown(true),

    // Documents & Access — only the fields the PATCH manages.
    nationalId: Joi.string().trim().max(60).allow(""),
    createLogin: Joi.boolean(),
    loginEmail: Joi.string().email().max(254).allow(""),
    systemRole: Joi.string().valid(...SYSTEM_ROLES),
    sendInvitation: Joi.boolean(),

    /**
     * File IDs of documents the user removed. The backend will:
     *   - delete each from S3
     *   - remove from Employee.documents
     */
    removedDocumentIds: Joi.array()
        .items(Joi.string().trim().min(1).max(64))
        .max(5).default([]),
})
    .min(1) // reject empty PATCH bodies
    .with("createLogin", ["loginEmail"])
    .with("sendInvitation", ["loginEmail"]);
