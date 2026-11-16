// src/routes/payroll/payroll.routes.js
import { Router } from "express";
import { requireAuth, requirePermission } from "../../middleware/auth/auth.middleware.js";
import {
    getComponentsController,
    createComponentController,
    updateComponentController,
    deleteComponentController,
    resetComponentsController,
    getBatchesController,
    getBatchByIdController,
    getBatchByMonthController,
    getPayrollFrequencyAlertsController,
    generateBatchController,
    getAttendanceAdjustmentsController,
    saveAdjustmentsController,
    approveBatchController,
    disburseBatchController,
    emailPayslipController,
    getLoansController,
    createLoanController,
    updateLoanStatusController,
    getSettingsController,
    updateSettingsController,
    getPayrollDashboardSummaryController,
    getSalaryStructuresController,
    createSalaryStructureController,
    updateSalaryStructureController,
    deleteSalaryStructureController,
} from "../../controllers/payroll/payroll.controller.js";

const router = Router();

// Apply requireAuth to all payroll routes
router.use(requireAuth);

// Dashboard Summary & Analytics
router.get("/summary", requirePermission("payroll", "view"), getPayrollDashboardSummaryController);

// Salary Components
router.get("/components", requirePermission("payroll", "view"), getComponentsController);
router.post("/components", requirePermission("payroll", "process"), createComponentController);
router.put("/components/:id", requirePermission("payroll", "process"), updateComponentController);
router.delete("/components/:id", requirePermission("payroll", "process"), deleteComponentController);
router.post("/components/reset", requirePermission("payroll", "process"), resetComponentsController);

// Salary Structures
router.get("/structures", requirePermission("payroll", "view"), getSalaryStructuresController);
router.post("/structures", requirePermission("payroll", "process"), createSalaryStructureController);
router.put("/structures/:id", requirePermission("payroll", "process"), updateSalaryStructureController);
router.delete("/structures/:id", requirePermission("payroll", "process"), deleteSalaryStructureController);

// Batches & Processing
router.get("/frequency-alerts", requirePermission("payroll", "view"), getPayrollFrequencyAlertsController);
router.get("/batches", requirePermission("payroll", "view"), getBatchesController);
router.get("/batches/month/:month", requirePermission("payroll", "view"), getBatchByMonthController);
router.get("/batches/:id", requirePermission("payroll", "view"), getBatchByIdController);
router.get("/attendance-adjustments", requirePermission("payroll", "view"), getAttendanceAdjustmentsController);
router.post("/batches/generate", requirePermission("payroll", "process"), generateBatchController);
router.post("/adjustments", requirePermission("payroll", "process"), saveAdjustmentsController);
router.post("/batches/:id/approve", requirePermission("payroll", "process"), approveBatchController);
router.post("/batches/:id/disburse", requirePermission("payroll", "process"), disburseBatchController);
router.post("/payslips/email", requirePermission("payroll", "process"), emailPayslipController);

// Loans & Advances
router.get("/loans", requirePermission("payroll", "view"), getLoansController);
router.post("/loans", requirePermission("payroll", "process"), createLoanController);
router.patch("/loans/:id/status", requirePermission("payroll", "process"), updateLoanStatusController);

// Payroll Settings
router.get("/settings", requirePermission("payroll", "view"), getSettingsController);
router.put("/settings", requirePermission("payroll", "process"), updateSettingsController);

export default router;
