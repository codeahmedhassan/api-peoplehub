import { Router } from "express";
import authRoutes from "./auth/auth.routes.js";
import workspaceRoutes from "./workspace/workspace.routes.js";
import employeeRoutes from "./employee/employee.routes.js";
import attendanceRoutes from "./attendance/attendance.routes.js";
import deviceRoutes from "./attendance/device.routes.js";
import payrollRoutes from "./payroll/payroll.routes.js";
import notificationRoutes from "./notification/notification.routes.js";
import leaveRoutes from "./leave/leave.routes.js";
import performanceRoutes from "./performance/performance.routes.js";
import superAdminRoutes from "./superAdmin/superAdmin.routes.js";
import feedbackRoutes from "./feedback/feedback.routes.js";
import auditLogRoutes from "./audit/auditLog.routes.js";
import chatRoutes from "./chat/chat.routes.js";
import analyticsRoutes from "./analytics/analytics.routes.js";
import workspaceAnalyticsRoutes from "./workspace/workspaceAnalytics.routes.js";
import publicRoutes from "./public/public.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
    res.json({ success: true, message: "API is healthy" });
});

router.use("/auth", authRoutes);
router.use("/workspace", workspaceRoutes);
router.use("/employees", employeeRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/attendance/devices", deviceRoutes);
router.use("/payroll", payrollRoutes);
router.use("/notifications", notificationRoutes);
router.use("/leave", leaveRoutes);
router.use("/performance", performanceRoutes);
router.use("/super-admin", superAdminRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/audit-logs", auditLogRoutes);
router.use("/chat", chatRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/workspace/analytics", workspaceAnalyticsRoutes);
router.use("/public", publicRoutes);

export default router;
