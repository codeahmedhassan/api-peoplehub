// src/controllers/payroll/payroll.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { getWorkspaceOrThrow } from "../../services/workspace/workspace.service.js";
import { eventEngine } from "../../services/observability/eventEngine.service.js";
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
    buildBatchCurrencyBreakdown,
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

    if (batch) {
        eventEngine.trackEvent({
            eventName: "payroll_generated",
            module: "payroll",
            feature: "generate_batch",
            organizationId: workspace._id,
            userId: req.userId,
            requestId: req.id,
            properties: { month, employeeCount: batch.employeeCount },
            isCritical: true,
        });
    }

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

    if (batch) {
        eventEngine.trackEvent({
            eventName: "payroll_completed",
            module: "payroll",
            feature: "disburse_batch",
            organizationId: workspace._id,
            userId: req.userId,
            requestId: req.id,
            properties: { batchId: id, status: "paid" },
            isCritical: true,
        });
    }

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
    const workspaceCurrency = (workspace.currency || "PKR").toUpperCase();

    // 1. Employee counts & live currency distribution
    const employees = await Employee.find({
        workspace: workspaceId,
        isDeleted: { $ne: true },
        employmentStatus: { $ne: "Terminated" },
    }).select("salaryCurrency currency salaryAmount basicSalary department").lean();
    const totalEmployees = employees.length;

    const empCurrMap = new Map();
    employees.forEach((emp) => {
        const curr = String(emp.salaryCurrency || emp.currency || workspaceCurrency).toUpperCase();
        const entry = empCurrMap.get(curr) || { currency: curr, count: 0, totalBaseSalary: 0 };
        entry.count += 1;
        entry.totalBaseSalary += Number(emp.salaryAmount || emp.basicSalary || 0);
        empCurrMap.set(curr, entry);
    });
    const employeeCurrencyBreakdown = Array.from(empCurrMap.values()).sort((a, b) => b.count - a.count);

    // 2. Batches (populated & normalized with multi-currency breakdowns)
    const allBatches = await getBatches(workspaceId);
    const batches = allBatches.slice(0, 6);
    const latestBatch = batches[0] || null;
    if (latestBatch && (!latestBatch.currencyBreakdown || latestBatch.currencyBreakdown.length === 0)) {
        latestBatch.currencyBreakdown = buildBatchCurrencyBreakdown(latestBatch.entries || [], workspaceCurrency);
    }

    // 3. Loans grouped by currency
    const activeLoans = await EmployeeLoan.find({ workspace: workspaceId, status: "active" })
        .populate("employee", "salaryCurrency currency")
        .lean();
    const totalLoanBalance = activeLoans.reduce((sum, l) => sum + (l.remainingBalance || 0), 0);
    const loanCurrMap = new Map();
    activeLoans.forEach((l) => {
        const curr = String(l.employee?.salaryCurrency || l.employee?.currency || l.currency || workspaceCurrency).toUpperCase();
        const b = loanCurrMap.get(curr) || { currency: curr, amount: 0, count: 0 };
        b.amount += Number(l.remainingBalance || 0);
        b.count += 1;
        loanCurrMap.set(curr, b);
    });
    const loanBalanceByCurrency = Array.from(loanCurrMap.values()).sort((a, b) => b.count - a.count || b.amount - a.amount);

    // 4. Monthly trends
    const trends = batches.map(b => ({
        month: b.month,
        gross: b.totalGross,
        deductions: b.totalDeductions,
        net: b.totalNetPay,
        status: b.status,
        currencyBreakdown: b.currencyBreakdown || buildBatchCurrencyBreakdown(b.entries || [], workspaceCurrency),
    })).reverse();

    // 5. Department breakdown from latest batch
    const departmentBreakdown = {};
    const deptCurrMap = new Map();
    if (latestBatch && Array.isArray(latestBatch.entries)) {
        latestBatch.entries.forEach(e => {
            const dept = e.department || "General";
            const curr = String(e.currency || workspaceCurrency).toUpperCase();
            departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + e.netSalary;
            const key = `${dept}::${curr}`;
            const curItem = deptCurrMap.get(key) || { department: dept, currency: curr, totalNet: 0, count: 0 };
            curItem.totalNet += Number(e.netSalary || 0);
            curItem.count += 1;
            deptCurrMap.set(key, curItem);
        });
    }
    const departmentBreakdownByCurrency = Array.from(deptCurrMap.values());

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                workspaceCurrency,
                totalEmployees,
                latestBatch,
                recentBatches: batches,
                currencyBreakdown: latestBatch?.currencyBreakdown || [],
                employeeCurrencyBreakdown,
                totalLoanBalance,
                loanBalanceByCurrency,
                activeLoansCount: activeLoans.length,
                trends,
                departmentBreakdown,
                departmentBreakdownByCurrency,
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
