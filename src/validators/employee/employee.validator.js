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