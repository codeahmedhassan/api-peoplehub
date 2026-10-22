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
    firstName: Joi.string().trim().min(1).max(60).required(),
    lastName: Joi.string().trim().min(1).max(60).required(),
    phone: Joi.string().trim().min(6).max(40).required(),
    preferredName: optionalString(60),
    gender: Joi.string().valid("Male", "Female", "Other", "").default(""),
    avatar: optionalString(500),
    manuallyPickedAvatar: Joi.boolean().default(false),

    // --- Employment ---
    employmentStatus: Joi.string().valid(...EMPLOYMENT_STATUSES).required(),
    employmentType: Joi.string().valid(...EMPLOYMENT_TYPES).required(),
    designation: optionalString(120),
    department: Joi.string().valid(...DEPARTMENTS).required(),
    reportingManager: optionalString(120),
    joiningDate: Joi.string().isoDate().required(),
    workLocation: Joi.string().valid(...WORK_LOCATIONS, "").default(""),
    workArrangement: Joi.string().valid(...WORK_ARRANGEMENTS, "").default(""),
    probationEndDate: Joi.string().isoDate().allow("", null).default(null),
    contractEndDate: Joi.string().isoDate().allow("", null).default(null),
    employeeCategory: Joi.string().valid(...EMPLOYEE_CATEGORIES, "").default(""),

    // --- Contact ---
    personalEmail: Joi.string().email().max(254).allow("").default(""),
    dateOfBirth: Joi.string().isoDate().allow("", null).default(null),
    residentialAddress: optionalString(300),
    city: optionalString(100),
    country: optionalString(100),
    emergencyName: optionalString(120),
    emergencyRelation: optionalString(60),
    emergencyPhone: optionalString(40),

    // --- Work & Attendance ---
    workSchedule: optionalString(200),
    weeklyWorkingDays: optionalString(100),
    attendanceLocation: optionalString(150),
    attendanceMethod: optionalString(100),
    attendanceEligibility: Joi.string().valid("Eligible", "Not Eligible").default("Eligible"),
    overtimeEligibility: Joi.boolean().default(false),
    timeZone: optionalString(100),

    // --- Compensation ---
    salaryAmount: Joi.number().positive().required(),
    salaryCurrency: Joi.string().valid(...CURRENCIES).required(),
    payFrequency: Joi.string().valid(...PAY_FREQUENCIES).required(),
    bankAccountName: optionalString(150),
    bankAccountNumber: optionalString(60),
    bankName: optionalString(150),
    taxIdentifier: optionalString(60),
    payrollGroup: Joi.string().valid(...PAYROLL_GROUPS, "").default(""),

    // --- Documents & Access ---
    nationalId: optionalString(60),
    createLogin: Joi.boolean().default(false),
    loginEmail: Joi.string().email().max(254).allow("").default(""),
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
        .max(20)
        .default([]),
}).with("createLogin", ["loginEmail"])
    .with("sendInvitation", ["loginEmail"])
    .custom((value, helpers) => {
        if (value.createLogin && !value.loginEmail) {
            return helpers.error("any.custom", {
                message: "loginEmail is required when createLogin is true",
            });
        }
        if (value.sendInvitation && !value.loginEmail) {
            return helpers.error("any.custom", {
                message: "loginEmail is required when sendInvitation is true",
            });
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
    department: Joi.string().valid(...DEPARTMENTS),
    reportingManager: Joi.string().trim().max(120).allow(""),
    joiningDate: Joi.string().isoDate(),
    workLocation: Joi.string().valid(...WORK_LOCATIONS, ""),
    workArrangement: Joi.string().valid(...WORK_ARRANGEMENTS, ""),
    probationEndDate: Joi.string().isoDate().allow("", null),
    contractEndDate: Joi.string().isoDate().allow("", null),
    employeeCategory: Joi.string().valid(...EMPLOYEE_CATEGORIES, ""),

    // Contact
    personalEmail: Joi.string().email().max(254).allow(""),
    dateOfBirth: Joi.string().isoDate().allow("", null),
    residentialAddress: Joi.string().trim().max(300).allow(""),
    city: Joi.string().trim().max(100).allow(""),
    country: Joi.string().trim().max(100).allow(""),
    emergencyName: Joi.string().trim().max(120).allow(""),
    emergencyRelation: Joi.string().trim().max(60).allow(""),
    emergencyPhone: Joi.string().trim().max(40).allow(""),

    // Work & Attendance
    workSchedule: Joi.string().trim().max(200).allow(""),
    weeklyWorkingDays: Joi.string().trim().max(100).allow(""),
    attendanceLocation: Joi.string().trim().max(150).allow(""),
    attendanceMethod: Joi.string().trim().max(100).allow(""),
    attendanceEligibility: Joi.string().valid("Eligible", "Not Eligible"),
    overtimeEligibility: Joi.boolean(),
    timeZone: Joi.string().trim().max(100).allow(""),

    // Compensation
    salaryAmount: Joi.number().min(0),
    salaryCurrency: Joi.string().valid(...CURRENCIES),
    payFrequency: Joi.string().valid(...PAY_FREQUENCIES),
    bankAccountName: Joi.string().trim().max(150).allow(""),
    bankAccountNumber: Joi.string().trim().max(60).allow(""),
    bankName: Joi.string().trim().max(150).allow(""),
    taxIdentifier: Joi.string().trim().max(60).allow(""),
    payrollGroup: Joi.string().valid(...PAYROLL_GROUPS, ""),

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
        .max(20)
        .default([]),
})
    .min(1) // reject empty PATCH bodies
    .with("createLogin", ["loginEmail"])
    .with("sendInvitation", ["loginEmail"]);
