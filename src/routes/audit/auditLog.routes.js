import { Router } from "express";
import { requireAuth, requirePermission } from "../../middleware/auth/auth.middleware.js";
import { getWorkspaceAuditLogsController } from "../../controllers/audit/auditLog.controller.js";

const router = Router();

router.get("/", requireAuth, requirePermission("auditLogs", "view"), getWorkspaceAuditLogsController);

export default router;
