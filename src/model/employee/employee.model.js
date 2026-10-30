// src/model/employee/employee.model.js
import mongoose from "mongoose";
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

const { Schema, model } = mongoose;

// -------------------------------------------------------------------
// Encrypted document metadata.
// The actual ciphertext lives in S3 at `s3Key`.
// Everything needed to decrypt (except the KEK) is stored here.
// -------------------------------------------------------------------
const encryptedDocumentSchema = new Schema(
    {
        fileId: { type: String, required: true }, // uuid
        type: { type: String, required: true, enum: DOCUMENT_TYPES },
        label: { type: String, required: true, trim: true, maxlength: 100 },

        // Original filename (for download)
        fileName: { type: String, required: true, trim: true, maxlength: 255 },
        fileSize: { type: Number, required: true, min: 1 }, // plaintext size
        mimeType: { type: String, required: true },

        // S3 location (never public — access only via signed URLs)
        s3Key: { type: String, required: true },

        // Envelope encryption metadata
        iv: { type: String, required: true },        // base64, 12 bytes
        authTag: { type: String, required: true },   // base64, 16 bytes
        wrappedDek: { type: String, required: true },// base64 (DEK encrypted with KEK)
        kekVersion: { type: Number, required: true, default: 1 },

        uploadedAt: { type: Date, default: Date.now },
        uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { _id: false }
);

const employeeSchema = new Schema(
    {
        // Ownership — one workspace owns the employee.
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },

        // -----------------------------------------------------------------
        // Step 1 — Basic
        // -----------------------------------------------------------------
        firstName: { type: String, required: true, trim: true, maxlength: 60 },
        lastName: { type: String, required: true, trim: true, maxlength: 60 },
        employeeId: {
            type: String,
            required: true,
            trim: true,
            maxlength: 40,
        },
        phone: { type: String, required: true, trim: true, maxlength: 40 },
        preferredName: { type: String, trim: true, maxlength: 60, default: "" },
        gender: { type: String, enum: ["Male", "Female", "Other", ""], default: "" },
        avatar: { type: String, default: "" }, // path to avatar pool image
        manuallyPickedAvatar: { type: Boolean, default: false },

        // -----------------------------------------------------------------
        // Step 2 — Employment
        // -----------------------------------------------------------------
        employmentStatus: {
            type: String,
            required: true,
            enum: EMPLOYMENT_STATUSES,
            default: "Active",
        },
        employmentType: {
            type: String,
            required: true,
            enum: EMPLOYMENT_TYPES,
        },
        designation: { type: String, trim: true, maxlength: 120, default: "" },
        department: { type: String, required: true, enum: DEPARTMENTS },
        reportingManager: { type: String, trim: true, maxlength: 120, default: "" },
        joiningDate: { type: Date, required: true },
        workLocation: { type: String, enum: [...WORK_LOCATIONS, ""], default: "" },
        workArrangement: { type: String, enum: [...WORK_ARRANGEMENTS, ""], default: "" },
        probationEndDate: { type: Date, default: null },
        contractEndDate: { type: Date, default: null },
        employeeCategory: { type: String, enum: [...EMPLOYEE_CATEGORIES, ""], default: "" },

        // -----------------------------------------------------------------
        // Step 3 — Contact
        // -----------------------------------------------------------------
        personalEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
        dateOfBirth: { type: Date, default: null },
        residentialAddress: { type: String, trim: true, maxlength: 300, default: "" },
        city: { type: String, trim: true, maxlength: 100, default: "" },
        country: { type: String, trim: true, maxlength: 100, default: "" },
        emergencyName: { type: String, trim: true, maxlength: 120, default: "" },
        emergencyRelation: { type: String, trim: true, maxlength: 60, default: "" },
        emergencyPhone: { type: String, trim: true, maxlength: 40, default: "" },

        // -----------------------------------------------------------------
        // Step 4 — Work & Attendance
        // -----------------------------------------------------------------
        workSchedule: { type: String, trim: true, maxlength: 200, default: "" },
        weeklyWorkingDays: { type: String, trim: true, maxlength: 100, default: "" },
        attendanceLocation: { type: String, trim: true, maxlength: 150, default: "" },
        attendanceMethod: { type: String, trim: true, maxlength: 100, default: "" },
        attendanceEligibility: {
            type: String,
            enum: ["Eligible", "Not Eligible"],
            default: "Eligible",
        },
        overtimeEligibility: { type: Boolean, default: false },
        timeZone: { type: String, trim: true, maxlength: 100, default: "" },

        // -----------------------------------------------------------------
        // Step 5 — Compensation
        // -----------------------------------------------------------------
        salaryAmount: { type: Number, required: true, min: 0 },
        payFrequency: { type: String, required: true, enum: PAY_FREQUENCIES },
        bankAccountName: { type: String, trim: true, maxlength: 150, default: "" },
        bankAccountNumber: { type: String, trim: true, maxlength: 60, default: "" },
        bankName: { type: String, trim: true, maxlength: 150, default: "" },
        taxIdentifier: { type: String, trim: true, maxlength: 60, default: "" },
        payrollGroup: { type: String, enum: [...PAYROLL_GROUPS, ""], default: "" },

        // -----------------------------------------------------------------
        // Step 6 — Documents & Access
        // -----------------------------------------------------------------
        nationalId: { type: String, trim: true, maxlength: 60, default: "" },

        documents: {
            type: [encryptedDocumentSchema],
            default: [],
            validate: {
                validator: (arr) => arr.length <= 20,
                message: "At most 20 documents per employee",
            },
        },

        createLogin: { type: Boolean, default: false },
        loginEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
        systemRole: { type: String, enum: SYSTEM_ROLES, default: "Employee" },
        sendInvitation: { type: Boolean, default: false },

        // Link to User if a login was created
        linkedUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    { timestamps: true }
);

// Unique employee ID within a workspace
employeeSchema.index({ workspace: 1, employeeId: 1 }, { unique: true });

employeeSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        workspace: this.workspace,
        employeeId: this.employeeId,

        firstName: this.firstName,
        lastName: this.lastName,
        preferredName: this.preferredName,
        phone: this.phone,
        gender: this.gender,
        avatar: this.avatar,

        employmentStatus: this.employmentStatus,
        employmentType: this.employmentType,
        designation: this.designation,
        department: this.department,
        reportingManager: this.reportingManager,
        joiningDate: this.joiningDate,
        workLocation: this.workLocation,
        workArrangement: this.workArrangement,
        probationEndDate: this.probationEndDate,
        contractEndDate: this.contractEndDate,
        employeeCategory: this.employeeCategory,

        personalEmail: this.personalEmail,
        dateOfBirth: this.dateOfBirth,
        residentialAddress: this.residentialAddress,
        city: this.city,
        country: this.country,
        emergencyName: this.emergencyName,
        emergencyRelation: this.emergencyRelation,
        emergencyPhone: this.emergencyPhone,

        workSchedule: this.workSchedule,
        weeklyWorkingDays: this.weeklyWorkingDays,
        attendanceLocation: this.attendanceLocation,
        attendanceMethod: this.attendanceMethod,
        attendanceEligibility: this.attendanceEligibility,
        overtimeEligibility: this.overtimeEligibility,
        timeZone: this.timeZone,

        salaryAmount: this.salaryAmount,
        payFrequency: this.payFrequency,
        payrollGroup: this.payrollGroup,
        // NOTE: bankAccountNumber & taxIdentifier are intentionally NOT
        // returned in the default JSON. They surface only via a dedicated
        // endpoint with elevated permissions (built later).

        nationalId: this.nationalId,

        documents: this.documents.map((d) => ({
            fileId: d.fileId,
            type: d.type,
            label: d.label,
            fileName: d.fileName,
            fileSize: d.fileSize,
            mimeType: d.mimeType,
            uploadedAt: d.uploadedAt,
            // Note: s3Key, iv, authTag, wrappedDek intentionally hidden
        })),

        createLogin: this.createLogin,
        loginEmail: this.loginEmail,
        systemRole: this.systemRole,
        sendInvitation: this.sendInvitation,

        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Employee = model("Employee", employeeSchema);