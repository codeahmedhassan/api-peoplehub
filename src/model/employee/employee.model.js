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
        lastName: { type: String, required: false, trim: true, maxlength: 60, default: "" },
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
            default: "Active",
            trim: true,
        },
        employmentType: {
            type: String,
            required: true,
            default: "Full Time",
            trim: true,
        },
        designation: { type: String, trim: true, maxlength: 120, default: "" },
        department: { type: String, required: true, trim: true, maxlength: 120 },
        reportingManager: { type: String, trim: true, maxlength: 120, default: "" },
        joiningDate: { type: Date, required: true },
        branch: { type: String, trim: true, maxlength: 120, default: "" },
        workLocation: { type: String, trim: true, maxlength: 120, default: "" },
        workArrangement: { type: String, enum: [...WORK_ARRANGEMENTS, ""], default: "" },
        probationStatus: {
            type: String,
            enum: ["In Probation", "Passed", "Extended", "Not Applicable", ""],
            default: "In Probation",
        },
        probationEndDate: { type: Date, default: null },
        contractEndDate: { type: Date, default: null },
        employeeCategory: { type: String, enum: [...EMPLOYEE_CATEGORIES, ""], default: "" },

        // -----------------------------------------------------------------
        // Step 3 — Contact
        // -----------------------------------------------------------------
        personalEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
        workEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
        dateOfBirth: { type: Date, default: null },
        residentialAddress: { type: String, trim: true, maxlength: 300, default: "" },
        city: { type: String, trim: true, maxlength: 100, default: "" },
        country: { type: String, trim: true, maxlength: 100, default: "" },
        emergencyName: { type: String, trim: true, maxlength: 120, default: "" },
        emergencyRelation: { type: String, trim: true, maxlength: 60, default: "" },
        emergencyPhone: { type: String, trim: true, maxlength: 40, default: "" },
        referenceName: { type: String, trim: true, maxlength: 120, default: "" },
        referenceRelation: { type: String, trim: true, maxlength: 60, default: "" },
        referencePhone: { type: String, trim: true, maxlength: 40, default: "" },
        referenceAddress: { type: String, trim: true, maxlength: 300, default: "" },

        // -----------------------------------------------------------------
        // Step 4 — Work & Attendance
        // -----------------------------------------------------------------
        workSchedule: { type: String, trim: true, maxlength: 200, default: "" },
        workingHours: { type: Number, default: 8, min: 1, max: 24 },
        workShift: { type: String, trim: true, maxlength: 100, default: "Morning Shift (09:00 - 18:00)" },
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
        salaryCurrency: { type: String, trim: true, default: "" },
        currency: { type: String, trim: true, default: "" },
        payFrequency: { type: String, required: true, enum: PAY_FREQUENCIES },
        bankAccountName: { type: String, trim: true, maxlength: 150, default: "" },
        bankAccountNumber: { type: String, trim: true, maxlength: 60, default: "" },
        bankName: { type: String, trim: true, maxlength: 150, default: "" },
        taxIdentifier: { type: String, trim: true, maxlength: 60, default: "" },
        payrollGroup: { type: String, trim: true, maxlength: 120, default: "" },
        salaryHistory: [
            {
                effectiveDate: { type: Date, default: Date.now },
                previousSalary: { type: Number, required: true },
                newSalary: { type: Number, required: true },
                currency: { type: String, default: "" },
                changeReason: { type: String, trim: true, default: "Annual Increment" },
                changedBy: { type: String, trim: true, default: "HR Department" },
                createdAt: { type: Date, default: Date.now },
            },
        ],

        // -----------------------------------------------------------------
        // Step 6 — Documents & Access
        // -----------------------------------------------------------------
        nationalId: { type: String, trim: true, maxlength: 60, default: "" },

        documents: {
            type: [encryptedDocumentSchema],
            default: [],
            validate: {
                validator: (arr) => arr.length <= 5,
                message: "At most 5 documents per employee",
            },
        },

        createLogin: { type: Boolean, default: false },
        loginEmail: { type: String, trim: true, lowercase: true, maxlength: 254, default: "" },
        systemRole: { type: String, enum: SYSTEM_ROLES, default: "Employee" },
        sendInvitation: { type: Boolean, default: false },

        // Link to User if a login was created
        linkedUser: { type: Schema.Types.ObjectId, ref: "User", default: null },

        // Latest Performance Appraisal Summary
        latestAppraisal: {
            rating: { type: Number, default: null },
            band: { type: String, default: "" },
            reviewDate: { type: Date, default: null },
            reviewPeriod: { type: String, default: "" },
            recommendation: { type: String, default: "" },
            appraisalId: { type: Schema.Types.ObjectId, ref: "PerformanceAppraisal", default: null },
        },

        // -----------------------------------------------------------------
        // Qualifications & Professional Background
        // -----------------------------------------------------------------
        education: [
            {
                institution: { type: String, trim: true, default: "" },
                degree: { type: String, trim: true, default: "" },
                fieldOfStudy: { type: String, trim: true, default: "" },
                startDate: { type: Date, default: null },
                endDate: { type: Date, default: null },
                grade: { type: String, trim: true, default: "" },
                description: { type: String, trim: true, default: "" },
            },
        ],
        experience: [
            {
                company: { type: String, trim: true, default: "" },
                role: { type: String, trim: true, default: "" },
                employmentType: { type: String, trim: true, default: "" },
                location: { type: String, trim: true, default: "" },
                startDate: { type: Date, default: null },
                endDate: { type: Date, default: null },
                isCurrent: { type: Boolean, default: false },
                description: { type: String, trim: true, default: "" },
            },
        ],
        certificates: [
            {
                name: { type: String, trim: true, default: "" },
                issuingOrg: { type: String, trim: true, default: "" },
                issueDate: { type: Date, default: null },
                expiryDate: { type: Date, default: null },
                credentialId: { type: String, trim: true, default: "" },
                credentialUrl: { type: String, trim: true, default: "" },
            },
        ],
        permissions: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },

        // -----------------------------------------------------------------
        // Step 7 — Confidential & Disciplinary
        // -----------------------------------------------------------------
        disciplinaryRecords: [
            {
                incidentDate: { type: Date, default: Date.now },
                title: { type: String, required: true, trim: true },
                type: {
                    type: String,
                    enum: [
                        "Verbal Warning",
                        "Written Warning",
                        "Final Warning",
                        "Suspension",
                        "Inquiry",
                        "Policy Violation",
                        "Other",
                    ],
                    default: "Written Warning",
                },
                description: { type: String, trim: true, default: "" },
                actionTaken: { type: String, trim: true, default: "" },
                status: {
                    type: String,
                    enum: ["Open", "Under Review", "Resolved", "Closed"],
                    default: "Resolved",
                },
                issuedBy: { type: String, trim: true, default: "HR Department" },
                notes: { type: String, trim: true, default: "" },
                createdAt: { type: Date, default: Date.now },
            },
        ],
        confidentialNotes: { type: String, trim: true, default: "" },
        backgroundCheckStatus: {
            type: String,
            default: "In Progress",
        },
        vettingChecks: {
            identity: {
                status: {
                    type: String,
                    trim: true,
                    default: "Pending employee document",
                },
                verifiedAt: { type: Date, default: null },
                verifiedBy: { type: String, default: "" },
                notes: { type: String, default: "" },
            },
            education: {
                status: {
                    type: String,
                    trim: true,
                    default: "Pending employee document",
                },
                verifiedAt: { type: Date, default: null },
                verifiedBy: { type: String, default: "" },
                notes: { type: String, default: "" },
            },
            employment: {
                status: {
                    type: String,
                    trim: true,
                    default: "Pending employee reference",
                },
                verifiedAt: { type: Date, default: null },
                verifiedBy: { type: String, default: "" },
                notes: { type: String, default: "" },
            },
            criminal: {
                status: {
                    type: String,
                    trim: true,
                    default: "Pending check",
                },
                verifiedAt: { type: Date, default: null },
                verifiedBy: { type: String, default: "" },
                notes: { type: String, default: "" },
            },
        },

        // Track when managers have viewed an assigned direct report
        viewedByManagers: [
            {
                managerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
                viewedAt: { type: Date, default: Date.now },
            },
        ],
    },
    { timestamps: true }
);

// Unique employee ID within a workspace
employeeSchema.index({ workspace: 1, employeeId: 1 }, { unique: true });

// Unique national ID within a workspace (allows same national ID across different workspaces/organizations)
employeeSchema.index(
    { workspace: 1, nationalId: 1 },
    {
        unique: true,
        partialFilterExpression: { nationalId: { $type: "string", $gt: "" } },
    }
);

// Fast auth, workspace & listing lookups
employeeSchema.index({ linkedUser: 1 });
employeeSchema.index({ loginEmail: 1 });
employeeSchema.index({ personalEmail: 1 });
employeeSchema.index({ workEmail: 1 });
employeeSchema.index({ workspace: 1, linkedUser: 1 });
employeeSchema.index({ workspace: 1, loginEmail: 1 });
employeeSchema.index({ workspace: 1, firstName: 1, lastName: 1 });

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
        probationStatus: this.probationStatus || "In Probation",
        probationEndDate: this.probationEndDate,
        contractEndDate: this.contractEndDate,
        employeeCategory: this.employeeCategory,

        personalEmail: this.personalEmail,
        workEmail: this.workEmail || this.loginEmail || "",
        dateOfBirth: this.dateOfBirth,
        residentialAddress: this.residentialAddress,
        city: this.city,
        country: this.country,
        emergencyName: this.emergencyName,
        emergencyRelation: this.emergencyRelation,
        emergencyPhone: this.emergencyPhone,
        referenceName: this.referenceName || "",
        referenceRelation: this.referenceRelation || "",
        referencePhone: this.referencePhone || "",
        referenceAddress: this.referenceAddress || "",

        workSchedule: this.workSchedule,
        workingHours: this.workingHours,
        workShift: this.workShift || "Morning Shift (09:00 - 18:00)",
        weeklyWorkingDays: this.weeklyWorkingDays,
        attendanceLocation: this.attendanceLocation,
        attendanceMethod: this.attendanceMethod,
        attendanceEligibility: this.attendanceEligibility,
        overtimeEligibility: this.overtimeEligibility,
        timeZone: this.timeZone,

        salaryAmount: this.salaryAmount,
        basicSalary: this.salaryAmount,
        salaryCurrency: this.salaryCurrency || this.currency || "",
        currency: this.salaryCurrency || this.currency || "",
        payFrequency: this.payFrequency,
        payrollGroup: this.payrollGroup,
        bankName: this.bankName || "",
        bankAccountNumber: this.bankAccountNumber || "",
        bankAccountName: this.bankAccountName || "",
        taxIdentifier: this.taxIdentifier || "",
        salaryHistory: this.salaryHistory || [],

        disciplinaryRecords: this.disciplinaryRecords || [],
        confidentialNotes: this.confidentialNotes || "",
        backgroundCheckStatus: this.backgroundCheckStatus || "In Progress",
        vettingChecks: this.vettingChecks || {
            identity: { status: "Pending employee document", verifiedAt: null, verifiedBy: "", notes: "" },
            education: { status: "Pending employee document", verifiedAt: null, verifiedBy: "", notes: "" },
            employment: { status: "Pending employee reference", verifiedAt: null, verifiedBy: "", notes: "" },
            criminal: { status: "Pending check", verifiedAt: null, verifiedBy: "", notes: "" },
        },

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
        linkedUser: this.linkedUser || null,
        education: this.education || [],
        experience: this.experience || [],
        certificates: this.certificates || [],
        permissions: this.permissions || {},
        latestAppraisal: this.latestAppraisal || null,
        viewedByManagers: this.viewedByManagers || [],

        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Employee = model("Employee", employeeSchema);