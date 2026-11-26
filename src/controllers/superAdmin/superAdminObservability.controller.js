import { platformAnalyticsService } from "../../services/observability/platformAnalytics.service.js";
import { errorTracker } from "../../services/observability/errorTracker.service.js";
import { apmService } from "../../services/observability/apm.service.js";
import { logger } from "../../services/observability/structuredLogger.service.js";
import { aiDataIntelligenceService } from "../../services/observability/aiDataIntelligence.service.js";
import { ApiError } from "../../utils/ApiError.js";

/**
 * Super Admin Overview: Combined platform analytics and health
 */
export async function getObservabilityOverviewController(_req, res, next) {
    try {
        const [platformOverview, errorSummary, apmRealtime] = await Promise.all([
            platformAnalyticsService.getPlatformOverview(),
            errorTracker.getDashboardSummary(),
            apmService.getRealtimeTelemetry(),
        ]);

        res.json({
            success: true,
            data: {
                platform: platformOverview,
                errors: errorSummary,
                apm: apmRealtime,
            },
        });
    } catch (err) {
        next(err);
    }
}

/**
 * Error Tracking: List & summary
 */
export async function getErrorsListController(req, res, next) {
    try {
        const { status, severity, search, page, limit } = req.query;
        const result = await errorTracker.listErrors({
            status,
            severity,
            search,
            page: parseInt(page || "1", 10),
            limit: parseInt(limit || "20", 10),
        });
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
}

export async function getErrorDetailController(req, res, next) {
    try {
        const { fingerprint } = req.params;
        const error = await errorTracker.getErrorDetail(fingerprint);
        if (!error) {
            throw ApiError.notFound("Error fingerprint not found");
        }
        res.json({ success: true, data: error });
    } catch (err) {
        next(err);
    }
}

export async function updateErrorStatusController(req, res, next) {
    try {
        const { fingerprint } = req.params;
        const { status, resolutionNotes } = req.body;
        if (!status || !["unresolved", "investigating", "resolved", "ignored"].includes(status)) {
            throw ApiError.badRequest("Invalid status provided");
        }

        const adminIdentifier = req.superAdmin?.email || "SuperAdmin";
        const updated = await errorTracker.updateErrorStatus(
            fingerprint,
            status,
            adminIdentifier,
            resolutionNotes || ""
        );

        if (!updated) {
            throw ApiError.notFound("Error record not found");
        }

        res.json({ success: true, data: updated });
    } catch (err) {
        next(err);
    }
}

/**
 * APM: Real-time & historical
 */
export async function getApmRealtimeController(_req, res, next) {
    try {
        const data = await apmService.getRealtimeTelemetry();
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getApmHistoryController(req, res, next) {
    try {
        const hours = parseInt(req.query.hours || "24", 10);
        const data = await apmService.getHistoricalSnapshots(hours);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getApmSlowEndpointsController(req, res, next) {
    try {
        const limit = parseInt(req.query.limit || "10", 10);
        const data = await apmService.getSlowestEndpoints(limit);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

/**
 * Structured Logs Explorer
 */
export async function getStructuredLogsController(req, res, next) {
    try {
        const { level, search, requestId, workspaceId, module, startDate, endDate, page, limit } = req.query;
        const result = await logger.queryLogs({
            level,
            search,
            requestId,
            workspaceId,
            module,
            startDate,
            endDate,
            page: parseInt(page || "1", 10),
            limit: parseInt(limit || "50", 10),
        });
        res.json({ success: true, data: result });
    } catch (err) {
        next(err);
    }
}

/**
 * AI Data Intelligence
 */
export async function listAiDatasetsController(_req, res, next) {
    try {
        const datasets = await aiDataIntelligenceService.listDatasets();
        res.json({ success: true, data: datasets });
    } catch (err) {
        next(err);
    }
}

export async function generateAiDatasetController(req, res, next) {
    try {
        const { datasetName, version = "v1.0" } = req.body;
        let record = null;

        switch (datasetName) {
            case "attendance_anomalies":
                record = await aiDataIntelligenceService.extractAttendanceAnomalies(version);
                break;
            case "payroll_anomalies":
                record = await aiDataIntelligenceService.extractPayrollAnomalies(version);
                break;
            case "workforce_forecast":
                record = await aiDataIntelligenceService.extractWorkforceForecast(version);
                break;
            case "leave_trends":
                record = await aiDataIntelligenceService.extractLeaveTrends(version);
                break;
            case "attrition_research":
                record = await aiDataIntelligenceService.extractAttritionResearch(version);
                break;
            default:
                throw ApiError.badRequest(`Unknown dataset name: ${datasetName}`);
        }

        res.json({ success: true, data: record });
    } catch (err) {
        next(err);
    }
}

export async function exportAiDatasetJsonlController(req, res, next) {
    try {
        const { name } = req.params;
        const jsonlContent = await aiDataIntelligenceService.exportDatasetJsonl(name);
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Content-Disposition", `attachment; filename="${name}_export.jsonl"`);
        res.send(jsonlContent);
    } catch (err) {
        next(err);
    }
}
