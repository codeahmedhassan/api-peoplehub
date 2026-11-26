import crypto from "crypto";
import { SystemError } from "../../model/observability/systemError.model.js";
import { redactSensitiveData } from "./redaction.utils.js";
import { logger } from "./structuredLogger.service.js";

class ProprietaryErrorTracker {
    /**
     * Compute a deterministic fingerprint for an error based on name, normalized message, and top stack frames.
     */
    generateFingerprint(err, endpoint = "unknown") {
        try {
            const errName = err.name || "Error";
            // Normalize message: replace object IDs, UUIDs, and numeric IDs with placeholders
            const normalizedMsg = (err.message || "")
                .replace(/[a-fA-F0-9]{24}/g, ":id")
                .replace(/[0-9a-fA-F-]{36}/g, ":uuid")
                .replace(/\d+/g, ":num")
                .trim();

            let topFrames = "";
            if (err.stack) {
                const lines = err.stack.split("\n").slice(1, 4);
                topFrames = lines
                    .map((line) => line.trim().replace(/\(.*?\)/g, "").replace(/:\d+:\d+/g, ""))
                    .join("|");
            }

            const rawSignature = `${errName}:${normalizedMsg}:${endpoint}:${topFrames}`;
            return crypto.createHash("sha256").update(rawSignature).digest("hex").slice(0, 16);
        } catch {
            return crypto.randomBytes(8).toString("hex");
        }
    }

    /**
     * Classify error into a recognizable category.
     */
    classifyError(err, statusCode) {
        if (err.name === "ValidationError" || statusCode === 400) return "validation";
        if (statusCode === 401 || err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") return "auth";
        if (statusCode === 403) return "authorization";
        if (
            err.name === "MongoError" ||
            err.name === "MongoServerError" ||
            err.name === "MongooseError" ||
            err.message?.includes("Mongo")
        ) {
            return "database";
        }
        if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
            return "network";
        }
        return "internal_server";
    }

    /**
     * Determine severity level.
     */
    determineSeverity(err, statusCode, classification, endpoint) {
        if (
            statusCode >= 500 &&
            (endpoint?.includes("/payroll") || classification === "database" || err.isFatal)
        ) {
            return "critical";
        }
        if (statusCode >= 500) {
            return "high";
        }
        if (statusCode === 401 || statusCode === 403 || statusCode === 409) {
            return "medium";
        }
        return "low";
    }

    /**
     * Centralized non-blocking error collection.
     */
    async trackError(err, req = null, customMetadata = {}) {
        try {
            const endpoint = req?.originalUrl?.split("?")[0] || customMetadata.endpoint || "background_job";
            const method = req?.method || customMetadata.method || "SYS";
            const statusCode = err.statusCode || (err.status && typeof err.status === "number" ? err.status : 500);
            const requestId = req?.id || req?.headers?.["x-request-id"] || customMetadata.requestId || null;
            const workspaceId = req?.workspace?._id || req?.user?.activeWorkspace || null;
            const userId = req?.userId || req?.user?._id || null;

            const fingerprint = this.generateFingerprint(err, endpoint);
            const classification = this.classifyError(err, statusCode);
            const severity = this.determineSeverity(err, statusCode, classification, endpoint);

            // Redact request context
            const sanitizedParams = redactSensitiveData(req?.params || {});
            const sanitizedQuery = redactSensitiveData(req?.query || {});
            const sanitizedBody = req?.body ? redactSensitiveData(req.body) : {};

            const sampleContext = {
                classification,
                workspaceId,
                userId,
                params: sanitizedParams,
                query: sanitizedQuery,
                body: sanitizedBody,
                ...customMetadata,
            };

            const now = new Date();

            // Atomic upsert with frequency tracking
            await SystemError.findOneAndUpdate(
                { fingerprint },
                {
                    $setOnInsert: {
                        fingerprint,
                        name: err.name || "Error",
                        firstSeenAt: now,
                        status: "unresolved",
                        environment: process.env.NODE_ENV || "development",
                        appVersion: process.env.APP_VERSION || "1.0.0",
                    },
                    $set: {
                        message: err.message || "An unexpected error occurred",
                        stack: err.stack || "",
                        severity,
                        statusCode,
                        endpoint,
                        method,
                        lastSeenAt: now,
                        sampleContext,
                    },
                    $inc: { count: 1 },
                    $push: {
                        sampleRequestIds: {
                            $each: requestId ? [requestId] : [],
                            $slice: -15, // Retain last 15 sample request IDs
                        },
                    },
                },
                { upsert: true, new: true }
            );

            // Critical alert dispatcher
            if (severity === "critical") {
                this.dispatchCriticalAlert({
                    fingerprint,
                    errorName: err.name,
                    message: err.message,
                    endpoint,
                    statusCode,
                    requestId,
                });
            }
        } catch {
            // Never allow error tracking itself to break the caller
        }
    }

    /**
     * Dispatches alert for critical failures without external SaaS.
     */
    dispatchCriticalAlert(alertPayload) {
        logger.error(`CRITICAL SYSTEM FAILURE DETECTED: [${alertPayload.fingerprint}] ${alertPayload.errorName}: ${alertPayload.message}`, {
            module: "error_tracker",
            action: "critical_alert",
            alertPayload,
        });
    }

    /**
     * Dashboard Summary Metrics for Super Admin.
     */
    async getDashboardSummary() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [
            totalErrors,
            newErrors,
            resolvedErrors,
            criticalErrors,
            mostFrequent,
            affectedEndpoints,
            recentTrends,
        ] = await Promise.all([
            SystemError.countDocuments(),
            SystemError.countDocuments({ firstSeenAt: { $gte: oneDayAgo } }),
            SystemError.countDocuments({ status: "resolved" }),
            SystemError.countDocuments({ severity: "critical", status: { $ne: "resolved" } }),
            SystemError.find({ status: { $ne: "resolved" } })
                .sort({ count: -1 })
                .limit(5)
                .select("fingerprint name message severity count endpoint lastSeenAt")
                .lean(),
            SystemError.aggregate([
                { $group: { _id: "$endpoint", errorCount: { $sum: "$count" }, uniqueErrors: { $sum: 1 } } },
                { $sort: { errorCount: -1 } },
                { $limit: 5 },
            ]),
            SystemError.aggregate([
                { $match: { lastSeenAt: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: "%Y-%m-%d", date: "$lastSeenAt" },
                        },
                        occurrences: { $sum: "$count" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
        ]);

        return {
            totalErrors,
            newErrors,
            resolvedErrors,
            criticalErrors,
            mostFrequent,
            affectedEndpoints: affectedEndpoints.map((e) => ({
                endpoint: e._id,
                errorCount: e.errorCount,
                uniqueErrors: e.uniqueErrors,
            })),
            recentTrends: recentTrends.map((t) => ({
                date: t._id,
                occurrences: t.occurrences,
            })),
        };
    }

    /**
     * List Errors with filtering and pagination.
     */
    async listErrors({ status, severity, search, page = 1, limit = 20 }) {
        const query = {};
        if (status && status !== "ALL") query.status = status;
        if (severity && severity !== "ALL") query.severity = severity;
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: "i" } },
                { message: { $regex: search, $options: "i" } },
                { endpoint: { $regex: search, $options: "i" } },
                { fingerprint: { $regex: search, $options: "i" } },
            ];
        }

        const skip = (Math.max(1, page) - 1) * limit;
        const [errors, total] = await Promise.all([
            SystemError.find(query)
                .sort({ lastSeenAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            SystemError.countDocuments(query),
        ]);

        return {
            errors,
            total,
            page: Number(page),
            limit: Number(limit),
            pages: Math.ceil(total / limit) || 1,
        };
    }

    /**
     * Get single error details by fingerprint.
     */
    async getErrorDetail(fingerprint) {
        return SystemError.findOne({ fingerprint }).lean();
    }

    /**
     * Update error resolution status (resolved, ignored, investigating).
     */
    async updateErrorStatus(fingerprint, status, adminIdentifier, resolutionNotes = "") {
        const update = {
            status,
            resolutionNotes,
        };
        if (status === "resolved") {
            update.resolvedAt = new Date();
            update.resolvedBy = adminIdentifier;
        } else {
            update.resolvedAt = null;
            update.resolvedBy = null;
        }

        return SystemError.findOneAndUpdate({ fingerprint }, { $set: update }, { new: true });
    }
}

export const errorTracker = new ProprietaryErrorTracker();
