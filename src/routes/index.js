import { Router } from "express";
import authRoutes from "./auth/auth.routes.js";
import workspaceRoutes from "./workspace/workspace.routes.js";
import employeeRoutes from "./employee/employee.routes.js";

const router = Router();

router.get("/health", (_req, res) => {
    res.json({ success: true, message: "API is healthy" });
});

router.use("/auth", authRoutes);
router.use("/workspace", workspaceRoutes);
router.use("/employees", employeeRoutes);

export default router;