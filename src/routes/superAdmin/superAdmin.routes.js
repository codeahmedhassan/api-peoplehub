import { Router } from "express";
import {
    loginSuperAdminController,
    verifySuperAdmin2FAController,
    resendSuperAdmin2FAController,
    superAdminMeController,
    logoutSuperAdminController,
    getWorkspacesController,
    approveWorkspaceController,
    rejectWorkspaceController,
    updateWorkspacePlanController,
    sendPaymentFollowUpController,
    revokeWorkspaceAccessController,
    restoreWorkspaceAccessController,
    getAuditLogsController,
} from "../../controllers/superAdmin/superAdmin.controller.js";
import {
    superAdminListFeedbacksController,
    superAdminUpdateFeedbackController,
} from "../../controllers/feedback/feedback.controller.js";
import superAdminObservabilityRoutes from "./superAdminObservability.routes.js";
import { requireSuperAdminAuth } from "../../middleware/superAdmin/superAdmin.middleware.js";
import { superAdminLoginLimiter } from "../../middleware/rateLimit/rateLimit.middleware.js";

const router = Router();

// -------------------------------------------------------------------
// Super Admin Authentication
// -------------------------------------------------------------------
router.post("/auth/login", superAdminLoginLimiter, loginSuperAdminController);
router.post("/auth/verify-2fa", superAdminLoginLimiter, verifySuperAdmin2FAController);
router.post("/auth/resend-2fa", superAdminLoginLimiter, resendSuperAdmin2FAController);
router.get("/auth/me", requireSuperAdminAuth, superAdminMeController);
router.post("/auth/logout", requireSuperAdminAuth, logoutSuperAdminController);

// -------------------------------------------------------------------
// Workspace Verification Management
// -------------------------------------------------------------------
router.get("/workspaces", requireSuperAdminAuth, getWorkspacesController);
router.post("/workspaces/:id/approve", requireSuperAdminAuth, approveWorkspaceController);
router.post("/workspaces/:id/reject", requireSuperAdminAuth, rejectWorkspaceController);
router.patch("/workspaces/:id/plan", requireSuperAdminAuth, updateWorkspacePlanController);
router.post("/workspaces/:id/follow-up", requireSuperAdminAuth, sendPaymentFollowUpController);
router.post("/workspaces/:id/revoke-access", requireSuperAdminAuth, revokeWorkspaceAccessController);
router.post("/workspaces/:id/restore-access", requireSuperAdminAuth, restoreWorkspaceAccessController);

// -------------------------------------------------------------------
// Feedbacks, Reports & Suggestions Management
// -------------------------------------------------------------------
router.get("/feedbacks", requireSuperAdminAuth, superAdminListFeedbacksController);
router.patch("/feedbacks/:id", requireSuperAdminAuth, superAdminUpdateFeedbackController);

// -------------------------------------------------------------------
// Audit Logs
// -------------------------------------------------------------------
router.get("/audit-logs", requireSuperAdminAuth, getAuditLogsController);

// -------------------------------------------------------------------
// Proprietary Observability, APM, Error Tracking & AI Intelligence
// -------------------------------------------------------------------
router.use("/observability", superAdminObservabilityRoutes);

export default router;
