import { Router } from "express";
import { requireSuperAdminAuth } from "../../middleware/superAdmin/superAdmin.middleware.js";
import {
    getObservabilityOverviewController,
    getErrorsListController,
    getErrorDetailController,
    updateErrorStatusController,
    getApmRealtimeController,
    getApmHistoryController,
    getApmSlowEndpointsController,
    getStructuredLogsController,
    listAiDatasetsController,
    generateAiDatasetController,
    exportAiDatasetJsonlController,
} from "../../controllers/superAdmin/superAdminObservability.controller.js";

const router = Router();

// Strict Super Admin Authentication for all observability endpoints
router.use(requireSuperAdminAuth);

// Overview
router.get("/overview", getObservabilityOverviewController);

// Error Tracking
router.get("/errors", getErrorsListController);
router.get("/errors/:fingerprint", getErrorDetailController);
router.patch("/errors/:fingerprint/status", updateErrorStatusController);

// APM & Telemetry
router.get("/apm/realtime", getApmRealtimeController);
router.get("/apm/history", getApmHistoryController);
router.get("/apm/slow-endpoints", getApmSlowEndpointsController);

// Structured Logs Explorer
router.get("/logs", getStructuredLogsController);

// AI Data Intelligence
router.get("/ai/datasets", listAiDatasetsController);
router.post("/ai/datasets/generate", generateAiDatasetController);
router.get("/ai/datasets/:name/export", exportAiDatasetJsonlController);

export default router;
