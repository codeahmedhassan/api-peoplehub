// src/model/payroll/payrollSettings.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const payrollSettingsSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            unique: true,
            index: true,
        },
        payFrequency: {
            type: String,
            default: "monthly",
            trim: true,
        },
        cutoffDay: {
            type: Number,
            default: 25,
            min: 1,
            max: 31,
        },
        disbursementDay: {
            type: Number,
            default: 28,
            min: 1,
            max: 31,
        },
        workingDaysBasis: {
            type: String,
            default: "fixed_30", // fixed_30 | fixed_26 | calendar_days | custom
        },
        customWorkingDays: {
            type: Number,
            default: 30,
            min: 1,
            max: 31,
        },
        dailyWorkingHours: {
            type: Number,
            default: 8,
            min: 1,
            max: 24,
        },
        overtimeMultiplier: {
            type: Number,
            default: 1.5, // Any float rate HR wants: 1.25, 1.5, 2.0, etc.
            min: 0,
        },
        overtimeFormula: {
            type: String,
            default: "(base / working_days / daily_hours) * multiplier",
            trim: true,
        },
        unpaidAbsenceMethod: {
            type: String,
            default: "basic_30", // basic_30 | gross_30 | hourly | custom_rate
        },
        customDailyAbsenceRate: {
            type: Number,
            default: 0,
            min: 0,
        },
        autoMarkLatePenalties: {
            type: Boolean,
            default: true,
        },
        lateArrivalGraceMinutes: {
            type: Number,
            default: 15,
            min: 0,
        },
        lateArrivalGraceCount: {
            type: Number,
            default: 3,
            min: 0,
        },
        lateArrivalDeductionType: {
            type: String,
            default: "fixed", // "fixed" | "percent_day" | "hourly"
            enum: ["fixed", "percent_day", "hourly"],
        },
        lateArrivalDeductionAmount: {
            type: Number,
            default: 500,
            min: 0,
        },
        lateArrivalDeductionPercent: {
            type: Number,
            default: 25, // e.g. 25% of 1 day's basic or gross pay
            min: 0,
            max: 100,
        },
        defaultPaymentMethod: {
            type: String,
            default: "bank_transfer",
            trim: true,
        },
        taxYear: {
            type: String,
            default: "2026-2027",
            trim: true,
        },
        currency: {
            type: String,
            default: "PKR",
            trim: true,
        },
        companyBankName: {
            type: String,
            default: "",
            trim: true,
        },
        companyAccountTitle: {
            type: String,
            default: "",
            trim: true,
        },
        companyIban: {
            type: String,
            default: "",
            trim: true,
        },
        companyBranchCode: {
            type: String,
            default: "",
            trim: true,
        },
        customRules: [
            {
                key: { type: String, required: true },
                label: { type: String, required: true },
                value: { type: String, default: "" },
            },
        ],
    },
    { timestamps: true }
);

export const PayrollSettings = model("PayrollSettings", payrollSettingsSchema);
