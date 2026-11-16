import mongoose from "mongoose";

const { Schema, model } = mongoose;

const auditLogSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        actor: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        actorName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        actorEmail: {
            type: String,
            trim: true,
            lowercase: true,
            maxlength: 254,
            default: "",
        },
        actorRole: {
            type: String,
            trim: true,
            maxlength: 60,
            default: "User",
        },
        action: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        module: {
            type: String,
            required: true,
            enum: [
                "Employees",
                "Attendance",
                "Leave",
                "Payroll",
                "Performance",
                "Documents",
                "Access & Roles",
                "Settings",
                "System",
            ],
            index: true,
        },
        targetId: {
            type: String,
            trim: true,
            default: "",
        },
        targetName: {
            type: String,
            trim: true,
            default: "",
        },
        targetType: {
            type: String,
            trim: true,
            default: "",
        },
        description: {
            type: String,
            required: true,
            trim: true,
            maxlength: 1000,
        },
        details: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },
        ipAddress: {
            type: String,
            trim: true,
            default: "",
        },
        status: {
            type: String,
            enum: ["success", "failure", "warning"],
            default: "success",
        },
    },
    { timestamps: true }
);

auditLogSchema.index({ workspace: 1, createdAt: -1 });
auditLogSchema.index({ workspace: 1, module: 1, createdAt: -1 });
auditLogSchema.index({ workspace: 1, actor: 1, createdAt: -1 });

export const AuditLog = model("AuditLog", auditLogSchema);
