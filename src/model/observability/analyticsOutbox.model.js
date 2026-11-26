import mongoose from "mongoose";

const AnalyticsOutboxSchema = new mongoose.Schema(
    {
        event_id: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        payload: {
            type: mongoose.Schema.Types.Mixed,
            required: true,
        },
        status: {
            type: String,
            enum: ["pending", "processed", "failed"],
            default: "pending",
            index: true,
        },
        retries: {
            type: Number,
            default: 0,
        },
        error: {
            type: String,
            default: null,
        },
        createdAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        processedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: false,
        collection: "analytics_outbox",
    }
);

AnalyticsOutboxSchema.index({ status: 1, createdAt: 1 });

export const AnalyticsOutbox =
    mongoose.models.AnalyticsOutbox || mongoose.model("AnalyticsOutbox", AnalyticsOutboxSchema);
