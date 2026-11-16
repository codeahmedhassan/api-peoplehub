import mongoose from "mongoose";

const { Schema, model } = mongoose;

const superAdminAuditLogSchema = new Schema(
    {
        superAdmin: {
            type: Schema.Types.ObjectId,
            ref: "SuperAdmin",
            default: null,
            index: true,
        },
        superAdminEmail: {
            type: String,
            default: "",
            trim: true,
        },
        action: {
            type: String,
            required: true,
            index: true,
            // e.g. LOGIN_SUCCESS, LOGIN_FAILED, ACCOUNT_LOCKED, MFA_REQUESTED, MFA_SUCCESS, MFA_FAILED, LOGOUT, WORKSPACE_APPROVED, WORKSPACE_REJECTED
        },
        ipAddress: {
            type: String,
            default: "",
        },
        userAgent: {
            type: String,
            default: "",
        },
        details: {
            type: Schema.Types.Mixed,
            default: {},
        },
        status: {
            type: String,
            enum: ["success", "failure", "warning"],
            default: "success",
            index: true,
        },
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
        },
    },
    { timestamps: true }
);

export const SuperAdminAuditLog = model("SuperAdminAuditLog", superAdminAuditLogSchema);
