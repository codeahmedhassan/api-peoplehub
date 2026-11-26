import { StructuredLog } from "../../model/observability/structuredLog.model.js";
import { redactSensitiveData } from "./redaction.utils.js";

const LOG_LEVEL_SEVERITY = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
};

class ProprietaryStructuredLogger {
    constructor() {
        this.buffer = [];
        this.maxBufferSize = 100;
        this.flushIntervalMs = 2500;
        this.minConsoleLevel = process.env.NODE_ENV === "production" ? "INFO" : "DEBUG";
        this.flushTimer = null;
        this.startBufferFlusher();
    }

    startBufferFlusher() {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => {
            this.flushBuffer().catch(() => {});
        }, this.flushIntervalMs);

        // Ensure timer doesn't hold process open during tests or graceful exits
        if (this.flushTimer.unref) {
            this.flushTimer.unref();
        }
    }

    async flushBuffer() {
        if (this.buffer.length === 0) return;
        const toInsert = this.buffer.splice(0, this.buffer.length);
        try {
            await StructuredLog.insertMany(toInsert, { ordered: false });
        } catch {
            // Internal log persistence failure must NEVER interrupt application operation.
        }
    }

    log(level, message, context = {}) {
        try {
            const sanitizedContext = redactSensitiveData(context || {});
            const timestamp = new Date();
            const logEntry = {
                timestamp,
                level,
                message: String(message),
                requestId: sanitizedContext.requestId || sanitizedContext.reqId || null,
                traceId: sanitizedContext.traceId || null,
                workspaceId: sanitizedContext.workspaceId || null,
                userId: sanitizedContext.userId || null,
                module: sanitizedContext.module || "core",
                action: sanitizedContext.action || null,
                durationMs: typeof sanitizedContext.durationMs === "number" ? sanitizedContext.durationMs : null,
                statusCode: typeof sanitizedContext.statusCode === "number" ? sanitizedContext.statusCode : null,
                context: sanitizedContext,
                tags: Array.isArray(sanitizedContext.tags) ? sanitizedContext.tags : [],
            };

            // 1. Output structured JSON to console
            if (
                (LOG_LEVEL_SEVERITY[level] || 20) >=
                (LOG_LEVEL_SEVERITY[this.minConsoleLevel] || 20)
            ) {
                const stream = level === "ERROR" ? process.stderr : process.stdout;
                stream.write(JSON.stringify(logEntry) + "\n");
            }

            // 2. Buffer for asynchronous non-blocking MongoDB storage
            this.buffer.push(logEntry);
            if (this.buffer.length >= this.maxBufferSize) {
                this.flushBuffer().catch(() => {});
            }
        } catch {
            // Fail silently to prevent crashing application
        }
    }

    info(message, context = {}) {
        this.log("INFO", message, context);
    }

    warn(message, context = {}) {
        this.log("WARN", message, context);
    }

    error(message, context = {}) {
        this.log("ERROR", message, context);
    }

    debug(message, context = {}) {
        this.log("DEBUG", message, context);
    }

    /**
     * Query structured logs with filtering and pagination (Super Admin only).
     */
    async queryLogs({
        level,
        search,
        requestId,
        workspaceId,
        module,
        startDate,
        endDate,
        page = 1,
        limit = 50,
    }) {
        const query = {};

        if (level && level !== "ALL") {
            query.level = level.toUpperCase();
        }
        if (requestId) {
            query.requestId = requestId;
        }
        if (workspaceId) {
            query.workspaceId = workspaceId;
        }
        if (module) {
            query.module = module;
        }
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate) query.timestamp.$gte = new Date(startDate);
            if (endDate) query.timestamp.$lte = new Date(endDate);
        }
        if (search) {
            query.message = { $regex: search, $options: "i" };
        }

        const skip = (Math.max(1, page) - 1) * limit;
        const [logs, total] = await Promise.all([
            StructuredLog.find(query)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            StructuredLog.countDocuments(query),
        ]);

        return {
            logs,
            total,
            page: Number(page),
            limit: Number(limit),
            pages: Math.ceil(total / limit) || 1,
        };
    }
}

export const logger = new ProprietaryStructuredLogger();
