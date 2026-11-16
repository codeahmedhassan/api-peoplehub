// src/routes/leave/leave.routes.js
import { Router } from "express";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { noCache } from "../../middleware/cache/no-cache.middleware.js";
import {
    getLeaveSummaryController,
    listLeaveRequestsController,
    createLeaveRequestController,
    forwardLeaveRequestController,
    managerRejectLeaveRequestController,
    reviewLeaveRequestController,
    resubmitLeaveRequestController,
    getEmployeeLeaveHistoryController,
    getLeaveCalendarController,
    getAttendanceCheckController,
    cancelLeaveRequestController,
    cancelApprovedLeaveController,
    requestLeaveCancellationController,
    getTeamMembersController,
    getLeaveTypesCatalogController,
    addCustomLeaveTypeController,
    deleteCustomLeaveTypeController,
} from "../../controllers/leave/leave.controller.js";

const router = Router();

router.use(noCache);
router.use(requireAuth);

router.get("/types", getLeaveTypesCatalogController);
router.post("/custom-types", addCustomLeaveTypeController);
router.delete("/custom-types/:key", deleteCustomLeaveTypeController);

router.get("/summary", getLeaveSummaryController);
router.get("/requests", listLeaveRequestsController);
router.post("/requests", createLeaveRequestController);
router.get("/team-members", getTeamMembersController);
router.get("/calendar", getLeaveCalendarController);
router.get("/employee/:id/balance-history", getEmployeeLeaveHistoryController);
router.get("/requests/:id/attendance-check", getAttendanceCheckController);

router.post("/requests/:id/forward", forwardLeaveRequestController);
router.post("/requests/:id/manager-reject", managerRejectLeaveRequestController);
router.patch("/requests/:id/review", reviewLeaveRequestController);
router.post("/requests/:id/resubmit", resubmitLeaveRequestController);
router.patch("/requests/:id/cancel", cancelLeaveRequestController);
router.post("/requests/:id/cancel-approved", cancelApprovedLeaveController);
router.post("/requests/request-cancellation", requestLeaveCancellationController);

export default router;
