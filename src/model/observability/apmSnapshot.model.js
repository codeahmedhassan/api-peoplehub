import mongoose from "mongoose";

const ApmSnapshotSchema = new mongoose.Schema(
    {
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
            // Expire snapshots after 90 days
            expires: 60 * 60 * 24 * 90,
        },
        periodSeconds: {
            type: Number,
            default: 60,
        },
        totalRequests: {
            type: Number,
            default: 0,
        },
        errorRequests: {
            type: Number,
            default: 0,
        },
        errorRatePercent: {
            type: Number,
            default: 0,
        },
        rpm: {
            type: Number,
            default: 0,
        },
        avgDurationMs: {
            type: Number,
            default: 0,
        },
        p50DurationMs: {
            type: Number,
            default: 0,
        },
        p95DurationMs: {
            type: Number,
            default: 0,
        },
        p99DurationMs: {
            type: Number,
            default: 0,
        },
        system: {
            cpuPercent: { type: Number, default: 0 },
            memoryHeapUsedMb: { type: Number, default: 0 },
            memoryRssMb: { type: Number, default: 0 },
            memoryTotalMb: { type: Number, default: 0 },
            memoryUsagePercent: { type: Number, default: 0 },
            uptimeSeconds: { type: Number, default: 0 },
            eventLoopLagMs: { type: Number, default: 0 },
            dbPingMs: { type: Number, default: 0 },
        },
        slowestEndpoints: [
            {
                endpoint: { type: String },
                method: { type: String },
                count: { type: Number },
                avgDurationMs: { type: Number },
            },
        ],
    },
    {
        timestamps: false,
        collection: "apm_snapshots",
    }
);

ApmSnapshotSchema.index({ timestamp: -1 });

export const ApmSnapshot =
    mongoose.models.ApmSnapshot || mongoose.model("ApmSnapshot", ApmSnapshotSchema);
