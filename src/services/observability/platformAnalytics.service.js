import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { AnalyticsEvent } from "../../model/observability/analyticsEvent.model.js";
import { ApmMetric } from "../../model/observability/apmMetric.model.js";
import { SystemError } from "../../model/observability/systemError.model.js";

class ProprietaryPlatformAnalyticsService {
    /**
     * Complete Platform-Wide Intelligence for Super Admin.
     * ZERO customer PII exposed.
     */
    async getPlatformOverview() {
        const now = new Date();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        // 1. Organization Analytics
        const [
            totalOrgs,
            activeOrgs,
            newOrgsMonth,
            planDistribution,
            totalUsers,
        ] = await Promise.all([
            Workspace.countDocuments(),
            Workspace.countDocuments({ updatedAt: { $gte: thirtyDaysAgo } }),
            Workspace.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
            Workspace.aggregate([
                { $group: { _id: { $ifNull: ["$subscription.plan", "free"] }, count: { $sum: 1 } } },
            ]),
            User.countDocuments(),
        ]);

        // 2. Active User Analytics (DAU / WAU / MAU) from AnalyticsEvent collection
        const [dauAgg, wauAgg, mauAgg] = await Promise.all([
            AnalyticsEvent.aggregate([
                { $match: { timestamp: { $gte: oneDayAgo }, user_id: { $ne: null } } },
                { $group: { _id: "$user_id" } },
                { $count: "count" },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { timestamp: { $gte: sevenDaysAgo }, user_id: { $ne: null } } },
                { $group: { _id: "$user_id" } },
                { $count: "count" },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { timestamp: { $gte: thirtyDaysAgo }, user_id: { $ne: null } } },
                { $group: { _id: "$user_id" } },
                { $count: "count" },
            ]),
        ]);

        const dau = dauAgg[0]?.count || 0;
        const wau = wauAgg[0]?.count || 0;
        const mau = mauAgg[0]?.count || 0;

        // 3. Product Analytics: Module and Feature Adoption
        const [moduleUsage, topFeatures] = await Promise.all([
            AnalyticsEvent.aggregate([
                { $match: { timestamp: { $gte: thirtyDaysAgo } } },
                { $group: { _id: "$module", eventCount: { $sum: 1 } } },
                { $sort: { eventCount: -1 } },
            ]),
            AnalyticsEvent.aggregate([
                { $match: { timestamp: { $gte: thirtyDaysAgo } } },
                {
                    $group: {
                        _id: { module: "$module", event_name: "$event_name" },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { count: -1 } },
                { $limit: 10 },
            ]),
        ]);

        // 4. Technical Performance & Error Summary
        const [recentRequests, criticalErrorsCount] = await Promise.all([
            ApmMetric.aggregate([
                { $match: { timestamp: { $gte: oneDayAgo } } },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        errors: { $sum: { $cond: ["$isError", 1, 0] } },
                        avgDuration: { $avg: "$durationMs" },
                    },
                },
            ]),
            SystemError.countDocuments({ severity: "critical", status: { $ne: "resolved" } }),
        ]);

        const totalReqs = recentRequests[0]?.total || 0;
        const errorReqs = recentRequests[0]?.errors || 0;
        const avgDurationMs = Math.round((recentRequests[0]?.avgDuration || 0) * 10) / 10;
        const errorRatePercent = totalReqs > 0 ? Math.round((errorReqs / totalReqs) * 10000) / 100 : 0;

        // 5. Total Storage (Memory/Database + S3 Objects) utilized across all workspaces
        const storageAgg = await Workspace.aggregate([
            {
                $group: {
                    _id: null,
                    totalBytes: { $sum: { $ifNull: ["$storageUsage.totalBytesUsed", 0] } },
                    databaseBytes: { $sum: { $ifNull: ["$storageUsage.databaseBytesUsed", 0] } },
                    s3Bytes: { $sum: { $ifNull: ["$storageUsage.s3BytesUsed", 0] } },
                },
            },
        ]);
        const totalStorageBytes = storageAgg[0]?.totalBytes || 0;
        const totalStorageMb = Math.round((totalStorageBytes / (1024 * 1024)) * 100) / 100;
        const databaseStorageMb = Math.round(((storageAgg[0]?.databaseBytes || 0) / (1024 * 1024)) * 100) / 100;
        const s3StorageMb = Math.round(((storageAgg[0]?.s3Bytes || 0) / (1024 * 1024)) * 100) / 100;

        return {
            organizations: {
                total: totalOrgs,
                active: activeOrgs,
                newThisMonth: newOrgsMonth,
                planBreakdown: planDistribution.map((p) => ({
                    plan: p._id,
                    count: p.count,
                })),
            },
            users: {
                totalRegistered: totalUsers,
                dau,
                wau,
                mau,
                dauMauRatio: mau > 0 ? Math.round((dau / mau) * 100) : 0,
            },
            product: {
                moduleUsage: moduleUsage.map((m) => ({ module: m._id, count: m.eventCount })),
                topFeatures: topFeatures.map((f) => ({
                    module: f._id.module,
                    eventName: f._id.event_name,
                    count: f.count,
                })),
            },
            technical: {
                requestsLast24h: totalReqs,
                errorRatePercent,
                avgDurationMs,
                criticalErrorsCount,
                storageUsedMb: totalStorageMb,
                databaseStorageMb,
                s3StorageMb,
                storageUsedBytes: totalStorageBytes,
            },
        };
    }
}

export const platformAnalyticsService = new ProprietaryPlatformAnalyticsService();
