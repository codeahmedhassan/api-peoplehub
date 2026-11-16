// src/model/payroll/payrollBatch.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const componentSnapshotSchema = new Schema(
    {
        code: { type: String, required: true },
        name: { type: String, required: true },
        type: { type: String, required: true },
        amount: { type: Number, required: true },
        formulaApplied: { type: String, default: "" },
        isTaxable: { type: Boolean, default: false },
        includeInGross: { type: Boolean, default: false },
    },
    { _id: false }
);

const payslipEntrySchema = new Schema(
    {
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        employeeId: { type: String, required: true },
        employeeName: { type: String, required: true },
        employeeEmail: { type: String, default: "" },
        department: { type: String, default: "" },
        designation: { type: String, default: "" },
        branch: { type: String, default: "" },

        // Attendance stats for this period
        workingDays: { type: Number, default: 30 },
        presentDays: { type: Number, default: 30 },
        unpaidDays: { type: Number, default: 0 },
        paidLeaveDays: { type: Number, default: 0 },
        unpaidLeaveDays: { type: Number, default: 0 },
        overtimeHours: { type: Number, default: 0 },
        isManualAdjustment: { type: Boolean, default: false },

        // Calculated components
        basicSalary: { type: Number, required: true },
        earnings: [componentSnapshotSchema],
        deductions: [componentSnapshotSchema],
        employerContributions: [componentSnapshotSchema],
        reimbursements: [componentSnapshotSchema],

        // Final amounts
        grossSalary: { type: Number, required: true },
        totalEarnings: { type: Number, required: true },
        totalDeductions: { type: Number, required: true },
        totalEmployerContributions: { type: Number, default: 0 },
        totalReimbursements: { type: Number, default: 0 },
        netSalary: { type: Number, required: true },
        costToCompany: { type: Number, required: true },
        taxableIncome: { type: Number, default: 0 },

        paymentMethod: {
            type: String,
            enum: ["bank_transfer", "cheque", "cash"],
            default: "bank_transfer",
        },
        paymentStatus: {
            type: String,
            enum: ["pending", "processed", "paid", "on_hold"],
            default: "pending",
        },
        paidAt: { type: Date, default: null },
        bankAccountDetails: {
            bankName: { type: String, default: "" },
            accountNumber: { type: String, default: "" },
            accountTitle: { type: String, default: "" },
        },
    },
    { _id: true }
);

const payrollBatchSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        month: {
            type: String, // "YYYY-MM" e.g. "2026-10"
            required: true,
            match: /^\d{4}-\d{2}$/,
        },
        title: {
            type: String,
            required: true,
            trim: true,
            default: "Monthly Payroll",
        },
        payFrequency: {
            type: String,
            default: "All",
            trim: true,
        },
        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },

        status: {
            type: String,
            enum: ["draft", "review", "approved", "disbursed", "cancelled"],
            default: "draft",
        },
        processedAt: { type: Date, default: null },
        processedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        approvedAt: { type: Date, default: null },
        approvedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        disbursedAt: { type: Date, default: null },

        // Summary Aggregates
        totalEmployees: { type: Number, default: 0 },
        totalGross: { type: Number, default: 0 },
        totalEarnings: { type: Number, default: 0 },
        totalDeductions: { type: Number, default: 0 },
        totalNetPay: { type: Number, default: 0 },
        totalEmployerContributions: { type: Number, default: 0 },
        totalReimbursements: { type: Number, default: 0 },
        totalCostToCompany: { type: Number, default: 0 },

        // Employee snapshot list
        entries: [payslipEntrySchema],
    },
    { timestamps: true }
);

payrollBatchSchema.index({ workspace: 1, month: 1 });
payrollBatchSchema.index({ workspace: 1, status: 1 });

export const PayrollBatch = model("PayrollBatch", payrollBatchSchema);
