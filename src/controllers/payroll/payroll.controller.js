// src/controllers/payroll/payroll.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { getWorkspaceOrThrow } from "../../services/workspace/workspace.service.js";
import {
    getComponents,
    createComponent,
    updateComponent,
    deleteComponent,
    resetComponents,
    generatePayrollBatch,
    getBatches,
    getBatchById,
    getBatchByMonth,
    approveBatch,
    disburseBatch,
    emailPayslip,
    getLoans,
    createLoan,
    updateLoanStatus,
    getPayrollSettings,
    updatePayrollSettings,
    getSalaryStructures,
    createSalaryStructure,
    updateSalaryStructure,
    deleteSalaryStructure,
} from "../../services/payroll/payroll.service.js";
import { Employee } from "../../model/employee/employee.model.js";
import { PayrollBatch } from "../../model/payroll/payrollBatch.model.js";
import { EmployeeLoan } from "../../model/payroll/employeeLoan.model.js";

// ===================================================================
// Salary Components Controllers
// ===================================================================

export const getComponentsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const components = await getComponents(workspace._id);
    return res.status(200).json(new ApiResponse(200, { components }, "Salary components retrieved"));
});

export const createComponentController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const component = await createComponent(workspace._id, req.body);
    return res.status(201).json(new ApiResponse(201, { component }, "Salary component created successfully"));
});

export const updateComponentController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const component = await updateComponent(workspace._id, id, req.body);
    return res.status(200).json(new ApiResponse(200, { component }, "Salary component updated successfully"));
});

export const deleteComponentController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const result = await deleteComponent(workspace._id, id);
    return res.status(200).json(new ApiResponse(200, result, "Salary component deleted successfully"));
});

export const resetComponentsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const components = await resetComponents(workspace._id);
    return res.status(200).json(new ApiResponse(200, { components }, "Salary components reset to standard defaults"));
});

// ===================================================================
// Payroll Batch & Processing Controllers
// ===================================================================

export const getBatchesController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const batches = await getBatches(workspace._id);
    return res.status(200).json(new ApiResponse(200, { batches }, "Payroll batches retrieved"));
});

export const getBatchByIdController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const batch = await getBatchById(workspace._id, id);
    return res.status(200).json(new ApiResponse(200, { batch }, "Payroll batch details retrieved"));
});

export const getBatchByMonthController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { month } = req.params;
    const batch = await getBatchByMonth(workspace._id, month);
    return res.status(200).json(new ApiResponse(200, { batch }, "Payroll batch details retrieved"));
});

export const getPayrollFrequencyAlertsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { month } = req.query;
    const { getPayrollFrequencyAlerts } = await import("../../services/payroll/payroll.service.js");
    const alerts = await getPayrollFrequencyAlerts(workspace._id, month);
    return res.status(200).json(new ApiResponse(200, alerts, "Payroll frequency alerts retrieved"));
});

export const generateBatchController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { month, adjustments, payFrequency } = req.body;
    if (!month) throw ApiError.badRequest("Month (YYYY-MM) is required");
    const batch = await generatePayrollBatch(workspace._id, month, req.userId, adjustments, payFrequency);
    return res.status(201).json(new ApiResponse(201, { batch }, "Payroll batch generated"));
});

export const getAttendanceAdjustmentsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        throw ApiError.badRequest("Valid month (YYYY-MM) is required");
    }
    const { getAttendanceAdjustments } = await import("../../services/payroll/payroll.service.js");
    const data = await getAttendanceAdjustments(workspace._id, month);
    return res.status(200).json(new ApiResponse(200, data, "Attendance adjustments retrieved"));
});

export const saveAdjustmentsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { month, adjustments } = req.body;
    if (!month || !Array.isArray(adjustments)) {
        throw ApiError.badRequest("Month and adjustments are required");
    }
    const markedAdjustments = adjustments.map((a) => ({
        ...a,
        isManualAdjustment: true,
    }));
    const batch = await generatePayrollBatch(workspace._id, month, req.userId, markedAdjustments);
    return res.status(200).json(new ApiResponse(200, { batch }, "Attendance adjustments saved and payroll recalculated"));
});

export const approveBatchController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const batch = await approveBatch(workspace._id, id, req.userId);
    return res.status(200).json(new ApiResponse(200, { batch }, "Payroll batch approved"));
});

export const disburseBatchController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const batch = await disburseBatch(workspace._id, id);
    return res.status(200).json(new ApiResponse(200, { batch }, "Payroll batch disbursed and paid"));
});

export const emailPayslipController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { batchId, employeeId, month } = req.body;
    const result = await emailPayslip(workspace._id, { batchId, employeeId, month });
    return res.status(200).json(new ApiResponse(200, result, "Payslip email dispatched successfully"));
});

// ===================================================================
// Loans & Advances Controllers
// ===================================================================

export const getLoansController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const loans = await getLoans(workspace._id);
    return res.status(200).json(new ApiResponse(200, { loans }, "Employee loans retrieved"));
});

export const createLoanController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const loan = await createLoan(workspace._id, req.body);
    return res.status(201).json(new ApiResponse(201, { loan }, "Employee loan/advance created"));
});

export const updateLoanStatusController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const { status } = req.body;
    const loan = await updateLoanStatus(workspace._id, id, status);
    return res.status(200).json(new ApiResponse(200, { loan }, "Loan status updated"));
});

// ===================================================================
// Payroll Settings Controllers
// ===================================================================

export const getSettingsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const settings = await getPayrollSettings(workspace._id);
    return res.status(200).json(new ApiResponse(200, { settings }, "Payroll settings retrieved"));
});

export const updateSettingsController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const settings = await updatePayrollSettings(workspace._id, req.body);
    return res.status(200).json(new ApiResponse(200, { settings }, "Payroll settings updated successfully"));
});

// ===================================================================
// Dashboard Summary & Analytics Controller
// ===================================================================

export const getPayrollDashboardSummaryController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const workspaceId = workspace._id;

    // 1. Employee counts
    const totalEmployees = await Employee.countDocuments({ workspace: workspaceId, employmentStatus: { $ne: "Terminated" } });

    // 2. Batches
    const batches = await PayrollBatch.find({ workspace: workspaceId }).sort({ month: -1 }).limit(6);
    const latestBatch = batches[0] || null;

    // 3. Loans
    const activeLoans = await EmployeeLoan.find({ workspace: workspaceId, status: "active" });
    const totalLoanBalance = activeLoans.reduce((sum, l) => sum + (l.remainingBalance || 0), 0);

    // 4. Monthly trends
    const trends = batches.map(b => ({
        month: b.month,
        gross: b.totalGross,
        deductions: b.totalDeductions,
        net: b.totalNetPay,
        status: b.status,
    })).reverse();

    // 5. Department breakdown from latest batch
    const departmentBreakdown = {};
    if (latestBatch && Array.isArray(latestBatch.entries)) {
        latestBatch.entries.forEach(e => {
            const dept = e.department || "General";
            departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + e.netSalary;
        });
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                totalEmployees,
                latestBatch,
                recentBatches: batches,
                totalLoanBalance,
                activeLoansCount: activeLoans.length,
                trends,
                departmentBreakdown,
            },
            "Payroll dashboard summary loaded"
        )
    );
});

// ===================================================================
// Salary Structures Controllers
// ===================================================================

export const getSalaryStructuresController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const structures = await getSalaryStructures(workspace._id);
    return res.status(200).json(new ApiResponse(200, { structures }, "Salary structures retrieved"));
});

export const createSalaryStructureController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const structure = await createSalaryStructure(workspace._id, req.body);
    return res.status(201).json(new ApiResponse(201, { structure }, "Salary structure created successfully"));
});

export const updateSalaryStructureController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const structure = await updateSalaryStructure(workspace._id, id, req.body);
    return res.status(200).json(new ApiResponse(200, { structure }, "Salary structure updated successfully"));
});

export const deleteSalaryStructureController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { id } = req.params;
    const result = await deleteSalaryStructure(workspace._id, id);
    return res.status(200).json(new ApiResponse(200, result, "Salary structure deleted successfully"));
});
