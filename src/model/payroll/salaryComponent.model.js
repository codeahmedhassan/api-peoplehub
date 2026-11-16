// src/model/payroll/salaryComponent.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const COMPONENT_TYPES = [
    "earning",
    "deduction",
    "employer_contribution",
    "reimbursement",
];

export const CALCULATION_METHODS = [
    "fixed",
    "percent_basic",
    "percent_components",
    "unit_x_rate",
    "per_day",
    "manual",
    "formula",
];

export const ROUNDING_RULES = [
    "none",
    "nearest_integer",
    "ceiling",
    "floor",
    "nearest_10",
    "nearest_100",
];

const salaryComponentSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            maxlength: 30,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        type: {
            type: String,
            required: true,
            enum: COMPONENT_TYPES,
        },
        category: {
            type: String,
            trim: true,
            default: "Allowance",
        },
        description: {
            type: String,
            trim: true,
            default: "",
            maxlength: 500,
        },

        // Calculation rules
        calculationMethod: {
            type: String,
            required: true,
            enum: CALCULATION_METHODS,
            default: "fixed",
        },
        fixedAmount: {
            type: Number,
            default: 0,
            min: 0,
        },
        percentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 500,
        },
        selectedComponentCodes: {
            type: [String],
            default: ["BASIC"],
        },
        ratePerUnit: {
            type: Number,
            default: 0,
            min: 0,
        },
        defaultUnits: {
            type: Number,
            default: 0,
            min: 0,
        },
        unitName: {
            type: String,
            trim: true,
            default: "Hours",
        },
        perDayBasis: {
            type: String,
            enum: ["basic_30", "gross_30", "custom_rate"],
            default: "basic_30",
        },
        customDailyRate: {
            type: Number,
            default: 0,
            min: 0,
        },
        formula: {
            type: String,
            trim: true,
            default: "",
        },
        manualDefaultAmount: {
            type: Number,
            default: 0,
            min: 0,
        },

        // Limits & Rounding
        minAmount: {
            type: Number,
            default: null,
        },
        maxAmount: {
            type: Number,
            default: null,
        },
        roundingRule: {
            type: String,
            enum: ROUNDING_RULES,
            default: "nearest_integer",
        },

        // Policy & Tax Settings
        isRecurring: {
            type: Boolean,
            default: true,
        },
        isTaxable: {
            type: Boolean,
            default: true,
        },
        taxExemptionLimit: {
            type: Number,
            default: null,
        },
        includeInGross: {
            type: Boolean,
            default: true,
        },
        includeInOvertime: {
            type: Boolean,
            default: false,
        },
        showOnPayslip: {
            type: Boolean,
            default: true,
        },
        frequency: {
            type: String,
            enum: ["monthly", "weekly", "biweekly", "annual"],
            default: "monthly",
        },

        // Eligibility
        applicableTo: {
            type: String,
            enum: ["all", "departments", "designations", "employment_types", "branches", "custom"],
            default: "all",
        },
        applicableDepartments: {
            type: [String],
            default: [],
        },
        applicableDesignations: {
            type: [String],
            default: [],
        },
        applicableEmploymentTypes: {
            type: [String],
            default: [],
        },
        applicableBranches: {
            type: [String],
            default: [],
        },
        applicableEmployees: {
            type: [String],
            default: [],
        },
        customCriteria: {
            minSalary: { type: Number, default: null },
            maxSalary: { type: Number, default: null },
            departments: { type: [String], default: [] },
            employmentTypes: { type: [String], default: [] },
            branches: { type: [String], default: [] },
            employeeIds: { type: [String], default: [] },
        },
        effectiveFrom: {
            type: String,
            default: null,
        },
        effectiveTo: {
            type: String,
            default: null,
        },

        status: {
            type: String,
            enum: ["active", "inactive"],
            default: "active",
        },
        isSystem: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

// One component code per workspace
salaryComponentSchema.index({ workspace: 1, code: 1 }, { unique: true });
salaryComponentSchema.index({ workspace: 1, type: 1, status: 1 });

export const SalaryComponent = model("SalaryComponent", salaryComponentSchema);
