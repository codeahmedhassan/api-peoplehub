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
    getAuditLogsController,
} from "../../controllers/superAdmin/superAdmin.controller.js";
import {
    superAdminListFeedbacksController,
    superAdminUpdateFeedbackController,
} from "../../controllers/feedback/feedback.controller.js";
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

// -------------------------------------------------------------------
// Feedbacks, Reports & Suggestions Management
// -------------------------------------------------------------------
router.get("/feedbacks", requireSuperAdminAuth, superAdminListFeedbacksController);
router.patch("/feedbacks/:id", requireSuperAdminAuth, superAdminUpdateFeedbackController);

// -------------------------------------------------------------------
// Audit Logs
// -------------------------------------------------------------------
router.get("/audit-logs", requireSuperAdminAuth, getAuditLogsController);

export default router;
