import crypto from "crypto";
import { apmService } from "../../services/observability/apm.service.js";
import { logger } from "../../services/observability/structuredLogger.service.js";
import { runWithRequestContext } from "../../utils/requestContext.js";

/**
 * Normalizes route path by replacing Mongo ObjectIDs, UUIDs, and numeric IDs with placeholders.
 * Prevents high-cardinality endpoint explosions in APM charts.
 */
function normalizeEndpoint(url) {
    if (!url) return "unknown";
    const pathOnly = url.split("?")[0];
    return pathOnly
        .replace(/[a-fA-F0-9]{24}/g, ":id")
        .replace(/[0-9a-fA-F-]{36}/g, ":uuid")
        .replace(/\/d+(\/|$)/g, "/:num$1");
}

export function requestTraceMiddleware(req, res, next) {
    const requestId = req.headers["x-request-id"] || crypto.randomUUID();
    req.id = requestId;
    res.setHeader("X-Request-Id", requestId);

    const startHr = process.hrtime.bigint();

    res.on("finish", () => {
        try {
            const elapsedNanos = process.hrtime.bigint() - startHr;
            const durationMs = Math.round((Number(elapsedNanos) / 1e6) * 100) / 100;
            const normalizedPath = normalizeEndpoint(req.originalUrl || req.url);
            const statusCode = res.statusCode;
            const workspaceId = req.workspace?._id || req.user?.activeWorkspace || null;
            const userId = req.userId || req.user?._id || null;

            // 1. Record in APM telemetry engine
            apmService.recordRequest({
                endpoint: normalizedPath,
                method: req.method,
                statusCode,
                durationMs,
                requestId,
                workspaceId,
            });

            // 2. Emit structured log
            const logLevel = statusCode >= 500 ? "ERROR" : statusCode >= 400 ? "WARN" : "INFO";
            logger.log(logLevel, `${req.method} ${normalizedPath} ${statusCode} - ${durationMs}ms`, {
                requestId,
                workspaceId,
                userId,
                module: "http_access",
                endpoint: normalizedPath,
                method: req.method,
                statusCode,
                durationMs,
                ip: req.ip,
                userAgent: req.headers["user-agent"]?.slice(0, 100),
            });
        } catch {
            // Fail silently
        }
    });

    runWithRequestContext(() => next());
}
