// src/model/workspace/workspace.model.js
import mongoose from "mongoose";
import {
    SETUP_INDUSTRIES,
    SETUP_TIMEZONES,
    DEFAULT_WEEKEND_DAYS,
} from "../../constants/index.js";

const { Schema, model } = mongoose;

// -------------------------------------------------------------------
// Holiday sub-document: a specific calendar date that is a full-day holiday
// for the whole workspace. Marked via the attendance settings UI.
// -------------------------------------------------------------------
const holidaySchema = new Schema(
    {
        date: { type: String, required: true }, // "YYYY-MM-DD" in workspace TZ
        name: { type: String, required: true, trim: true, maxlength: 100 },
    },
    { _id: false }
);

// -------------------------------------------------------------------
// Attendance config sub-document.
// -------------------------------------------------------------------
const attendanceConfigSchema = new Schema(
    {
        autoMarkAbsent: {
            type: Boolean,
            default: true,
        },
        endOfDayTime: {
            type: String,
            default: "19:00",
            trim: true,
        },
        autoAbsentTime: {
            type: String,
            default: "19:00",
            trim: true,
        },
        weekendDays: {
            type: [Number],
            default: () => [...DEFAULT_WEEKEND_DAYS],
            validate: {
                validator: (arr) =>
                    Array.isArray(arr) &&
                    arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
                message: "weekendDays must be integers 0–6",
            },
        },
        holidays: {
            type: [holidaySchema],
            default: [],
        },
        leavesPerEmployee: {
            type: Number,
            default: 14,
            min: 0,
        },
        timeoffPerEmployee: {
            type: Number,
            default: 10,
            min: 0,
        },
        noLeavePolicy: {
            type: Boolean,
            default: false,
        },
        weekendWorkEarnsLeave: {
            type: Boolean,
            default: false,
        },
        weekendLeaveExpiry: {
            type: String,
            default: "never",
            trim: true,
        },
        leavePolicyMode: {
            type: String,
            enum: ["unified", "detailed"],
            default: "detailed",
        },
        leaveTypesConfig: {
            type: Array,
            default: undefined,
        },
        timeoffTypesConfig: {
            type: Array,
            default: undefined,
        },
        customLeaveTypes: {
            type: Array,
            default: [],
        },
        deductShortHours: {
            type: Boolean,
            default: false,
        },
        // Tracks the last midnight (in workspace TZ) that rollup fully processed.
        // Used so we don't re-process days we've already handled.
        lastRollupDate: {
            type: String, // "YYYY-MM-DD"
            default: null,
        },
    },
    { _id: false }
);

// -------------------------------------------------------------------
// Employee ID Generation config sub-document.
// Configurable by Founder / CEO and HR.
// -------------------------------------------------------------------
const employeeIdConfigSchema = new Schema(
    {
        formatType: {
            type: String,
            default: "prefix_number",
        },
        components: {
            type: [String],
            default: ["prefix", "number"],
        },
        prefix: { type: String, default: "EMP", trim: true },
        separator: { type: String, default: "-", trim: true },
        yearFormat: { type: String, default: "2_digit" }, // "2_digit" ("26") or "4_digit" ("2026")
        yearSource: { type: String, default: "joining_year" }, // "joining_year" or "current_year"
        paddingDigits: { type: Number, default: 4, min: 1, max: 8 },
        startingNumber: { type: Number, default: 1, min: 1 },
        defaultBranchCode: { type: String, default: "KOH", trim: true },
        branchCodes: {
            type: Map,
            of: String,
            default: () => ({
                "Kohat": "KOH",
                "Islamabad": "ISB",
                "Lahore": "LHR",
                "Karachi": "KHI",
                "Peshawar": "PEW",
                "Rawalpindi": "RWP",
                "Faisalabad": "FSD",
                "Multan": "MUX",
                "New York": "NYC",
                "London": "LDN",
                "Dubai": "DXB",
                "Berlin": "BER",
                "Headquarters": "HQ",
                "Main Office": "MAIN",
                "Remote": "REM",
            }),
        },
        departmentCodes: {
            type: Map,
            of: String,
            default: () => ({
                "Information Technology": "IT",
                "Engineering": "ENG",
                "Human Resources": "HR",
                "Finance": "FIN",
                "Accounts": "ACC",
                "Marketing": "MKT",
                "Sales": "SLS",
                "Operations": "OPS",
                "Support": "SUP",
                "Customer Support": "CS",
                "Design": "DES",
                "Administration": "ADMIN",
                "Legal": "LGL",
                "Quality Assurance": "QA",
                "Procurement": "PROC",
                "Logistics": "LOG",
            }),
        },
    },
    { _id: false }
);

const workspaceSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },

        companyName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 150,
        },
        industry: {
            type: String,
            required: true,
            enum: SETUP_INDUSTRIES,
        },
        timezone: {
            type: String,
            required: true,
            enum: SETUP_TIMEZONES,
        },

        teamSize: {
            type: String,
            required: true,
            enum: ["solo", "small", "growing", "midsize", "large", "enterprise"],
        },

        theme: {
            accent: {
                type: String,
                required: true,
                enum: ["blue", "emerald", "purple", "rose", "amber", "slate"],
            },
            modules: {
                employees: { type: Boolean, default: true },
                attendance: { type: Boolean, default: true },
                payroll: { type: Boolean, default: true },
                leave: { type: Boolean, default: true },
                recruitment: { type: Boolean, default: false },
                performance: { type: Boolean, default: true },
                timeoff: { type: Boolean, default: true },
                projects: { type: Boolean, default: false },
                devices: { type: Boolean, default: true },
            },
        },

        logo: {
            type: String,
            default: "",
        },

        taxId: {
            type: String,
            default: "",
            trim: true,
        },

        payrollCycle: {
            type: String,
            default: "Monthly (Last day of month)",
        },

        currency: {
            type: String,
            enum: ["USD", "EUR", "GBP", "PKR", "INR", "AED", "CAD", "AUD"],
            default: "USD",
        },

        attendance: {
            type: attendanceConfigSchema,
            default: () => ({}),
        },

        employeeIdConfig: {
            type: employeeIdConfigSchema,
            default: () => ({}),
        },

        payslipSettings: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },

        integrations: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },

        // Controls whether CEO retains full operational power (attendance marking,
        // employee add/edit/delete, and payroll generation) even when HR exists.
        // When true (default), CEO has full operational authority alongside HR.
        ceoFullControlWithHr: {
            type: Boolean,
            default: true,
        },

        // Super Admin verification workflow
        verificationStatus: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
            index: true,
        },
        rejectionReason: {
            type: String,
            default: "",
            trim: true,
            maxlength: 1000,
        },
        verifiedAt: {
            type: Date,
            default: null,
        },
        verifiedBy: {
            type: Schema.Types.ObjectId,
            ref: "SuperAdmin",
            default: null,
        },

        setupCompletedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { timestamps: true }
);

workspaceSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        owner: this.owner ? this.owner.toString() : null,
        companyName: this.companyName,
        industry: this.industry,
        timezone: this.timezone,
        teamSize: this.teamSize,
        theme: this.theme,
        currency: this.currency,
        logo: this.logo || "",
        taxId: this.taxId || "",
        payrollCycle: this.payrollCycle || "Monthly (Last day of month)",
        ceoFullControlWithHr: this.ceoFullControlWithHr !== undefined ? Boolean(this.ceoFullControlWithHr) : true,
        verificationStatus: this.verificationStatus || "approved",
        rejectionReason: this.rejectionReason || "",
        verifiedAt: this.verifiedAt || null,
        payslipSettings: this.payslipSettings || {},
        integrations: this.integrations || {},
        attendance: {
            autoMarkAbsent: this.attendance?.autoMarkAbsent ?? true,
            endOfDayTime: this.attendance?.endOfDayTime || this.attendance?.autoAbsentTime || "19:00",
            autoAbsentTime: this.attendance?.autoAbsentTime || this.attendance?.endOfDayTime || "19:00",
            weekendDays: this.attendance?.weekendDays ?? [...DEFAULT_WEEKEND_DAYS],
            holidays: this.attendance?.holidays ?? [],
            leavesPerEmployee: typeof this.attendance?.leavesPerEmployee === "number" ? this.attendance.leavesPerEmployee : 14,
            timeoffPerEmployee: typeof this.attendance?.timeoffPerEmployee === "number" ? this.attendance.timeoffPerEmployee : 10,
            noLeavePolicy: Boolean(this.attendance?.noLeavePolicy),
            weekendWorkEarnsLeave: Boolean(this.attendance?.weekendWorkEarnsLeave),
            weekendLeaveExpiry: this.attendance?.weekendLeaveExpiry || "never",
            leavePolicyMode: this.attendance?.leavePolicyMode || "detailed",
            leaveTypesConfig: this.attendance?.leaveTypesConfig || null,
            timeoffTypesConfig: this.attendance?.timeoffTypesConfig || null,
            customLeaveTypes: this.attendance?.customLeaveTypes || [],
            deductShortHours: Boolean(this.attendance?.deductShortHours),
            lastRollupDate: this.attendance?.lastRollupDate ?? null,
        },
        employeeIdConfig: this.employeeIdConfig ? {
            formatType: this.employeeIdConfig.formatType || "prefix_number",
            components: Array.isArray(this.employeeIdConfig.components) ? this.employeeIdConfig.components : ["prefix", "number"],
            prefix: this.employeeIdConfig.prefix !== undefined ? this.employeeIdConfig.prefix : "EMP",
            separator: this.employeeIdConfig.separator !== undefined ? this.employeeIdConfig.separator : "-",
            yearFormat: this.employeeIdConfig.yearFormat || "2_digit",
            yearSource: this.employeeIdConfig.yearSource || "joining_year",
            paddingDigits: typeof this.employeeIdConfig.paddingDigits === "number" ? this.employeeIdConfig.paddingDigits : 4,
            startingNumber: typeof this.employeeIdConfig.startingNumber === "number" ? this.employeeIdConfig.startingNumber : 1,
            defaultBranchCode: this.employeeIdConfig.defaultBranchCode || "KOH",
            branchCodes: this.employeeIdConfig.branchCodes instanceof Map
                ? Object.fromEntries(this.employeeIdConfig.branchCodes)
                : (this.employeeIdConfig.branchCodes || {}),
            departmentCodes: this.employeeIdConfig.departmentCodes instanceof Map
                ? Object.fromEntries(this.employeeIdConfig.departmentCodes)
                : (this.employeeIdConfig.departmentCodes || {}),
        } : undefined,
        setupCompletedAt: this.setupCompletedAt,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Workspace = model("Workspace", workspaceSchema);
