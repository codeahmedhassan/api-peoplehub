import mongoose from "mongoose";

const ApmMetricSchema = new mongoose.Schema(
    {
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
            // Expire raw granular metrics after 14 days
            expires: 60 * 60 * 24 * 14,
        },
        endpoint: {
            type: String,
            required: true,
            index: true,
        },
        method: {
            type: String,
            required: true,
            default: "GET",
        },
        statusCode: {
            type: Number,
            required: true,
            index: true,
        },
        durationMs: {
            type: Number,
            required: true,
        },
        dbDurationMs: {
            type: Number,
            default: 0,
        },
        isError: {
            type: Boolean,
            default: false,
            index: true,
        },
        requestId: {
            type: String,
            default: null,
        },
        workspaceId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            default: null,
        },
    },
    {
        timestamps: false,
        collection: "apm_metrics",
    }
);

ApmMetricSchema.index({ endpoint: 1, timestamp: -1 });
ApmMetricSchema.index({ statusCode: 1, timestamp: -1 });

export const ApmMetric =
    mongoose.models.ApmMetric || mongoose.model("ApmMetric", ApmMetricSchema);
