import crypto from "crypto";
import { AnalyticsEvent } from "../../model/observability/analyticsEvent.model.js";
import { AnalyticsOutbox } from "../../model/observability/analyticsOutbox.model.js";
import { redactSensitiveData } from "./redaction.utils.js";
import { logger } from "./structuredLogger.service.js";

const VALID_MODULES = new Set([
    "auth",
    "workspace",
    "organization",
    "employee",
    "attendance",
    "leave",
    "payroll",
    "performance",
    "feedback",
    "general",
    // Extensible future modules
    "finance",
    "inventory",
    "pos",
    "crm",
    "projects",
]);

class ProprietaryEventEngine {
    constructor() {
        this.eventBuffer = [];
        this.maxBufferSize = 50;
        this.flushIntervalMs = 3000;
        this.flushTimer = null;
        this.startFlusher();
        this.startOutboxWorker();
    }

    startFlusher() {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => {
            this.flushBuffer().catch(() => {});
        }, this.flushIntervalMs);

        if (this.flushTimer.unref) {
            this.flushTimer.unref();
        }
    }

    async flushBuffer() {
        if (this.eventBuffer.length === 0) return;
        const eventsToInsert = this.eventBuffer.splice(0, this.eventBuffer.length);
        try {
            const operations = eventsToInsert.map((evt) => ({
                updateOne: {
                    filter: { event_id: evt.event_id },
                    update: { $setOnInsert: evt },
                    upsert: true,
                },
            }));
            await AnalyticsEvent.bulkWrite(operations, { ordered: false });
        } catch (err) {
            // Internal telemetry buffering must never disrupt application flow
            logger.warn("Analytics event buffer flush partial error", {
                module: "analytics",
                error: err.message,
            });
        }
    }

    /**
     * Start background outbox processor for guaranteed event delivery.
     */
    startOutboxWorker() {
        const interval = setInterval(async () => {
            try {
                const pending = await AnalyticsOutbox.find({ status: "pending", retries: { $lt: 5 } })
                    .limit(20)
                    .lean();

                for (const item of pending) {
                    try {
                        await AnalyticsEvent.updateOne(
                            { event_id: item.event_id },
                            { $setOnInsert: item.payload },
                            { upsert: true }
                        );
                        await AnalyticsOutbox.updateOne(
                            { _id: item._id },
                            { $set: { status: "processed", processedAt: new Date() } }
                        );
                    } catch (err) {
                        await AnalyticsOutbox.updateOne(
                            { _id: item._id },
                            { $inc: { retries: 1 }, $set: { error: err.message } }
                        );
                    }
                }
            } catch {
                // Outbox sweep failure
            }
        }, 15000);

        if (interval.unref) interval.unref();
    }

    /**
     * Track a proprietary product event from backend service or controller.
     */
    trackEvent({
        eventName,
        module,
        feature = "general",
        organizationId,
        userId = null,
        userRole = "member",
        requestId = null,
        sessionId = null,
        properties = {},
        isCritical = false,
    }) {
        try {
            if (!eventName || !organizationId) return null;

            const safeModule = VALID_MODULES.has(String(module).toLowerCase())
                ? String(module).toLowerCase()
                : "general";

            const eventId = crypto.randomUUID();
            const sanitizedProps = redactSensitiveData(properties);

            const payload = {
                event_id: eventId,
                event_name: eventName,
                organization_id: organizationId,
                user_id: userId,
                user_role: userRole,
                module: safeModule,
                feature,
                timestamp: new Date(),
                application_version: process.env.APP_VERSION || "1.0.0",
                session_id: sessionId,
                request_id: requestId,
                event_properties: sanitizedProps,
            };

            // Queue in memory for async batch insert
            this.eventBuffer.push(payload);
            if (this.eventBuffer.length >= this.maxBufferSize) {
                this.flushBuffer().catch(() => {});
            }

            // If critical, also persist to outbox for transactional durability
            if (isCritical) {
                AnalyticsOutbox.create({
                    event_id: eventId,
                    payload,
                    status: "pending",
                }).catch(() => {});
            }

            return eventId;
        } catch {
            return null;
        }
    }

    /**
     * Ingest event sent from client (HTTP endpoint).
     * Server strictly derives the organizationId from authenticated session.
     */
    async ingestClientEvent(req, clientPayload) {
        const organizationId = req.workspace?._id || req.user?.activeWorkspace;
        if (!organizationId) {
            throw new Error("Cannot track event without authenticated organization context");
        }

        const {
            event_name,
            module = "general",
            feature = "ui_interaction",
            event_properties = {},
            session_id,
        } = clientPayload;

        if (!event_name || typeof event_name !== "string") {
            throw new Error("Invalid event_name");
        }

        return this.trackEvent({
            eventName: event_name.trim(),
            module,
            feature,
            organizationId,
            userId: req.userId || req.user?._id,
            userRole: req.user?.role || "member",
            requestId: req.id,
            sessionId: session_id || null,
            properties: event_properties,
        });
    }
}

export const eventEngine = new ProprietaryEventEngine();
