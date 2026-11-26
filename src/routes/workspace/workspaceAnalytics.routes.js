import { Router } from "express";
import {
    requireAuth,
    requireVerifiedUser,
} from "../../middleware/auth/auth.middleware.js";
import {
    getOverviewBiController,
    getWorkforceBiController,
    getAttendanceBiController,
    getLeaveBiController,
    getPayrollBiController,
} from "../../controllers/workspace/workspaceAnalytics.controller.js";

const router = Router();

router.use(requireAuth);
router.use(requireVerifiedUser);

router.get("/bi/overview", getOverviewBiController);
router.get("/bi/workforce", getWorkforceBiController);
router.get("/bi/attendance", getAttendanceBiController);
router.get("/bi/leave", getLeaveBiController);
router.get("/bi/payroll", getPayrollBiController);

export default router;
