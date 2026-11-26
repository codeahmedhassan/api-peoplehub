import mongoose from "mongoose";

const AnalyticsEventSchema = new mongoose.Schema(
    {
        event_id: {
            type: String,
            required: true,
            unique: true,
            index: true,
            trim: true,
        },
        event_name: {
            type: String,
            required: true,
            index: true,
            trim: true,
        },
        organization_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        user_role: {
            type: String,
            default: "anonymous",
        },
        module: {
            type: String,
            required: true,
            index: true,
        },
        feature: {
            type: String,
            required: true,
        },
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
            // Automatically expire analytics events after 180 days
            expires: 60 * 60 * 24 * 180,
        },
        application_version: {
            type: String,
            default: "1.0.0",
        },
        session_id: {
            type: String,
            default: null,
        },
        request_id: {
            type: String,
            default: null,
        },
        event_properties: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
    },
    {
        timestamps: false,
        collection: "analytics_events",
    }
);

AnalyticsEventSchema.index({ organization_id: 1, timestamp: -1 });
AnalyticsEventSchema.index({ event_name: 1, timestamp: -1 });
AnalyticsEventSchema.index({ module: 1, feature: 1, timestamp: -1 });

export const AnalyticsEvent =
    mongoose.models.AnalyticsEvent || mongoose.model("AnalyticsEvent", AnalyticsEventSchema);
