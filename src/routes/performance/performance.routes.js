// src/routes/performance/performance.routes.js
import { Router } from "express";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { noCache } from "../../middleware/cache/no-cache.middleware.js";
import {
    getMyTeamController,
    getPerformanceDashboardController,
    getEmployeeAppraisalDetailsController,
    submitEmployeeAppraisalController,
} from "../../controllers/performance/performance.controller.js";

const router = Router();

router.use(noCache);
router.use(requireAuth);

router.get("/my-team", getMyTeamController);
router.get("/dashboard", getPerformanceDashboardController);
router.get("/employee/:employeeId", getEmployeeAppraisalDetailsController);
router.post("/employee/:employeeId", submitEmployeeAppraisalController);

export default router;
