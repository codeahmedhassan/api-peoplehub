import mongoose from "mongoose";

const SystemErrorSchema = new mongoose.Schema(
    {
        fingerprint: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        message: {
            type: String,
            required: true,
        },
        stack: {
            type: String,
            default: "",
        },
        severity: {
            type: String,
            enum: ["low", "medium", "high", "critical"],
            default: "medium",
            index: true,
        },
        status: {
            type: String,
            enum: ["unresolved", "investigating", "resolved", "ignored"],
            default: "unresolved",
            index: true,
        },
        statusCode: {
            type: Number,
            default: 500,
            index: true,
        },
        endpoint: {
            type: String,
            default: "unknown",
            index: true,
        },
        method: {
            type: String,
            default: "GET",
        },
        appVersion: {
            type: String,
            default: "1.0.0",
        },
        environment: {
            type: String,
            default: process.env.NODE_ENV || "development",
        },
        firstSeenAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        lastSeenAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        count: {
            type: Number,
            default: 1,
            min: 1,
        },
        sampleRequestIds: {
            type: [String],
            default: [],
        },
        sampleContext: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        resolvedAt: {
            type: Date,
            default: null,
        },
        resolvedBy: {
            type: String,
            default: null,
        },
        resolutionNotes: {
            type: String,
            default: null,
        },
    },
    {
        timestamps: true,
        collection: "system_errors",
    }
);

SystemErrorSchema.index({ status: 1, severity: 1, lastSeenAt: -1 });
SystemErrorSchema.index({ endpoint: 1, lastSeenAt: -1 });

export const SystemError =
    mongoose.models.SystemError || mongoose.model("SystemError", SystemErrorSchema);
