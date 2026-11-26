// src/model/payroll/employeeLoan.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const loanDeductionRecordSchema = new Schema(
    {
        month: { type: String, required: true },
        amount: { type: Number, required: true },
        deductedAt: { type: Date, default: Date.now },
        payrollBatchId: { type: Schema.Types.ObjectId, ref: "PayrollBatch" },
    },
    { _id: false }
);

const employeeLoanSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
            index: true,
        },
        loanType: {
            type: String,
            enum: ["personal_loan", "salary_advance", "equipment", "emergency"],
            default: "salary_advance",
        },
        title: {
            type: String,
            required: true,
            trim: true,
        },
        principalAmount: {
            type: Number,
            required: true,
            min: 1,
        },
        totalDisbursed: {
            type: Number,
            default: 0,
        },
        totalRepaid: {
            type: Number,
            default: 0,
        },
        remainingBalance: {
            type: Number,
            required: true,
        },
        monthlyInstallment: {
            type: Number,
            required: true,
            min: 1,
        },
        startMonth: {
            type: String,
            required: true,
        },
        currency: {
            type: String,
            default: "PKR",
        },
        status: {
            type: String,
            enum: ["pending", "approved", "active", "completed", "rejected"],
            default: "active",
        },
        reason: {
            type: String,
            trim: true,
            default: "",
        },
        deductionsHistory: [loanDeductionRecordSchema],
    },
    { timestamps: true }
);

employeeLoanSchema.index({ workspace: 1, employee: 1 });
employeeLoanSchema.index({ workspace: 1, status: 1 });

export const EmployeeLoan = model("EmployeeLoan", employeeLoanSchema);
