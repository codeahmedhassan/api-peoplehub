// src/validators/workspace/workspace.validator.js
import Joi from "joi";
import {
    SETUP_INDUSTRIES,
    SETUP_TIMEZONES,
    SETUP_TEAM_SIZE_IDS,
    SETUP_ACCENT_IDS,
} from "../../constants/index.js";

export const setupWorkspaceSchema = Joi.object({
    company: Joi.object({
        name: Joi.string().trim().min(1).max(150).required(),
        industry: Joi.string().valid(...SETUP_INDUSTRIES).required(),
        timezone: Joi.string().valid(...SETUP_TIMEZONES).required(),
    }).required(),

    teamSize: Joi.string().valid(...SETUP_TEAM_SIZE_IDS).required(),

    theme: Joi.object({
        accent: Joi.string().valid(...SETUP_ACCENT_IDS).required(),
        modules: Joi.object({
            employees: Joi.boolean(),
            attendance: Joi.boolean(),
            payroll: Joi.boolean(),
            leave: Joi.boolean(),
            recruitment: Joi.boolean(),
        }).unknown(true).required(),
    }).required(),
});

/**
 * PATCH /workspace/attendance-settings
 * Partial — any subset of the three top-level fields can be sent.
 */
export const updateAttendanceSettingsSchema = Joi.object({
    autoMarkAbsent: Joi.boolean(),
    endOfDayTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).allow("", null),
    autoAbsentTime: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).allow("", null),

    weekendDays: Joi.array()
        .items(Joi.number().integer().min(0).max(6))
        .unique()
        .max(7),

    holidays: Joi.array()
        .items(
            Joi.object({
                date: Joi.string()
                    .pattern(/^\d{4}-\d{2}-\d{2}$/)
                    .required(),
                name: Joi.string().trim().min(1).max(100).required(),
            })
        )
        .max(100),

    leavesPerEmployee: Joi.number().min(0).max(365).allow(null),
    timeoffPerEmployee: Joi.number().min(0).max(365).allow(null),
    noLeavePolicy: Joi.boolean(),
    weekendWorkEarnsLeave: Joi.boolean(),
    weekendLeaveExpiry: Joi.string().allow("", null),
    deductShortHours: Joi.boolean(),
})
    .min(1)
    .unknown(true);

export const updateFinancialSchema = Joi.object({
    currency: Joi.string().trim().max(10),
    currencies: Joi.array().items(Joi.string().trim().max(10)),
    payrollCycle: Joi.string().trim().max(100),
    taxId: Joi.string().allow("").trim().max(100),
})
    .min(1)
    .unknown(true);

export const updateEmployeeIdSettingsSchema = Joi.object({
    formatType: Joi.string().valid(
        "prefix_number",
        "branch_number",
        "dept_number",
        "branch_dept_number",
        "branch_year_number",
        "prefix_branch_dept_year_number",
        "custom"
    ),
    components: Joi.array().items(
        Joi.string().valid("prefix", "branch", "department", "year", "number")
    ).min(1),
    prefix: Joi.string().allow("").max(20),
    separator: Joi.string().allow("").max(5),
    yearFormat: Joi.string().valid("2_digit", "4_digit"),
    yearSource: Joi.string().valid("joining_year", "current_year"),
    paddingDigits: Joi.number().integer().min(1).max(8),
    startingNumber: Joi.number().integer().min(1),
    defaultBranchCode: Joi.string().allow("").max(10),
    branchCodes: Joi.object().pattern(Joi.string(), Joi.string().max(10)),
    departmentCodes: Joi.object().pattern(Joi.string(), Joi.string().max(10)),
})
    .min(1)
    .unknown(true);
