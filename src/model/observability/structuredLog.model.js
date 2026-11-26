import mongoose from "mongoose";

const StructuredLogSchema = new mongoose.Schema(
    {
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
            // Automatically expire raw logs after 30 days
            expires: 60 * 60 * 24 * 30,
        },
        level: {
            type: String,
            enum: ["DEBUG", "INFO", "WARN", "ERROR"],
            default: "INFO",
            index: true,
        },
        message: {
            type: String,
            required: true,
        },
        requestId: {
            type: String,
            default: null,
            index: true,
        },
        traceId: {
            type: String,
            default: null,
        },
        workspaceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            default: null,
            index: true,
        },
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        module: {
            type: String,
            default: "general",
            index: true,
        },
        action: {
            type: String,
            default: null,
        },
        durationMs: {
            type: Number,
            default: null,
        },
        statusCode: {
            type: Number,
            default: null,
        },
        context: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        tags: {
            type: [String],
            default: [],
        },
    },
    {
        timestamps: false,
        collection: "structured_logs",
    }
);

StructuredLogSchema.index({ level: 1, timestamp: -1 });
StructuredLogSchema.index({ workspaceId: 1, timestamp: -1 });
StructuredLogSchema.index({ module: 1, timestamp: -1 });

export const StructuredLog =
    mongoose.models.StructuredLog || mongoose.model("StructuredLog", StructuredLogSchema);
