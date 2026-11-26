// src/services/payroll/payroll.service.js
import { SalaryComponent } from "../../model/payroll/salaryComponent.model.js";
import { PayrollBatch } from "../../model/payroll/payrollBatch.model.js";
import { EmployeeLoan } from "../../model/payroll/employeeLoan.model.js";
import { PayrollSettings } from "../../model/payroll/payrollSettings.model.js";
import { SalaryStructure } from "../../model/payroll/salaryStructure.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { LeaveRequest } from "../../model/leave/leave.model.js";
import { calculateAllLeaveBalances } from "../leave/leave.service.js";
import { resolvePlanConfig } from "../workspace/plan.service.js";
import { ApiError } from "../../utils/ApiError.js";
import { evaluateSafeArithmetic } from "../../utils/security.js";

// -------------------------------------------------------------------
// Standard Seed Components for New Workspaces
// -------------------------------------------------------------------
const DEFAULT_WORKSPACE_COMPONENTS = [
    {
        code: "BASIC",
        name: "Basic Salary",
        type: "earning",
        category: "Base Pay",
        description: "Primary contract base salary",
        calculationMethod: "fixed",
        fixedAmount: 75000,
        roundingRule: "nearest_integer",
        isRecurring: true,
        isTaxable: true,
        includeInGross: true,
        includeInOvertime: true,
        showOnPayslip: true,
        frequency: "monthly",
        status: "inactive",
        isSystem: true,
    },
    {
        code: "HRA",
        name: "House Rent Allowance",
        type: "earning",
        category: "Allowance",
        description: "Housing allowance (45% of basic salary)",
        calculationMethod: "percent_basic",
        percentage: 45,
        roundingRule: "nearest_integer",
        isRecurring: true,
        isTaxable: true,
        includeInGross: true,
        includeInOvertime: false,
        showOnPayslip: true,
        frequency: "monthly",
        status: "inactive",
    },
    {
        code: "TAX",
        name: "Income Tax",
        type: "deduction",
        category: "Statutory",
        description: "Statutory income tax withholding",
        calculationMethod: "formula",
        formula: "(gross * 0.05)",
        roundingRule: "nearest_integer",
        isRecurring: true,
        isTaxable: false,
        includeInGross: false,
        includeInOvertime: false,
        showOnPayslip: true,
        frequency: "monthly",
        status: "inactive",
    },
    {
        code: "UNPAID_ABSENCE",
        name: "Unpaid Absence Deduction",
        type: "deduction",
        category: "Attendance",
        description: "Loss of pay per unpaid leave day",
        calculationMethod: "per_day",
        perDayBasis: "basic_30",
        defaultUnits: 0,
        unitName: "Days",
        roundingRule: "nearest_integer",
        isRecurring: false,
        isTaxable: false,
        includeInGross: false,
        includeInOvertime: false,
        showOnPayslip: true,
        frequency: "monthly",
        status: "inactive",
    },
];

// -------------------------------------------------------------------
// Helper: Safe Math Formula Evaluation
// -------------------------------------------------------------------
function evaluateFormula(expr, variables) {
    try {
        let sanitized = String(expr || "0").toLowerCase();
        const sortedKeys = Object.keys(variables).sort((a, b) => b.length - a.length);
        for (const k of sortedKeys) {
            const val = variables[k] ?? 0;
            const regWithBraces = new RegExp(`\\{${k.toLowerCase()}\\}`,'g');
            const regWord = new RegExp(`\\b${k.toLowerCase()}\\b`, 'g');
            sanitized = sanitized.replace(regWithBraces, String(val)).replace(regWord, String(val));
        }
        if (/[^0-9\s+\-*/%().]/.test(sanitized)) return 0;
        const num = evaluateSafeArithmetic(sanitized);
        return isNaN(num) || !isFinite(num) ? 0 : num;
    } catch {
        return 0;
    }
}

// -------------------------------------------------------------------
// Helper: Apply Rounding Rule
// -------------------------------------------------------------------
function applyRounding(amount, rule) {
    switch (rule) {
        case "nearest_integer":
            return Math.round(amount);
        case "ceiling":
            return Math.ceil(amount);
        case "floor":
            return Math.floor(amount);
        case "nearest_10":
            return Math.round(amount / 10) * 10;
        case "nearest_100":
            return Math.round(amount / 100) * 100;
        case "none":
        default:
            return Number(amount.toFixed(2));
    }
}

// -------------------------------------------------------------------
// Calculation Engine for One Employee
// -------------------------------------------------------------------
export function isComponentEligibleForEmployee(comp, emp) {
    if (!comp || !comp.applicableTo || comp.applicableTo === "all") return true;
    if (!emp) return true;

    if (comp.applicableTo === "departments" && comp.applicableDepartments?.length) {
        if (!emp.department || !comp.applicableDepartments.includes(emp.department)) return false;
    }
    if (comp.applicableTo === "employment_types" && comp.applicableEmploymentTypes?.length) {
        const empType = emp.employmentType || emp.employmentStatus;
        if (!empType || !comp.applicableEmploymentTypes.includes(empType)) return false;
    }
    if (comp.applicableTo === "branches" && comp.applicableBranches?.length) {
        const empBranch = emp.workLocation || emp.branch;
        if (!empBranch || !comp.applicableBranches.includes(empBranch)) return false;
    }
    if (comp.applicableTo === "designations" && comp.applicableDesignations?.length) {
        if (!emp.designation || !comp.applicableDesignations.includes(emp.designation)) return false;
    }
    if (comp.applicableTo === "custom") {
        const empId = String(emp._id || emp.id || "");
        const empCode = String(emp.employeeId || "");

        // If specific employees are listed
        if (comp.applicableEmployees && comp.applicableEmployees.length > 0) {
            const match = comp.applicableEmployees.some((id) => String(id) === empId || String(id) === empCode);
            if (!match) return false;
        }

        // If custom criteria are specified
        if (comp.customCriteria) {
            const { minSalary, maxSalary, departments, employmentTypes, branches } = comp.customCriteria;
            const salary = Number(emp.salaryAmount || emp.basicSalary || 0);
            if (minSalary !== null && minSalary !== undefined && minSalary > 0 && salary < minSalary) return false;
            if (maxSalary !== null && maxSalary !== undefined && maxSalary > 0 && salary > maxSalary) return false;
            if (departments?.length && (!emp.department || !departments.includes(emp.department))) return false;
            if (employmentTypes?.length) {
                const empType = emp.employmentType || emp.employmentStatus;
                if (!empType || !employmentTypes.includes(empType)) return false;
            }
            if (branches?.length) {
                const empBranch = emp.workLocation || emp.branch;
                if (!empBranch || !branches.includes(empBranch)) return false;
            }
        }
    }

    return true;
}

export function calculateEmployeePayroll(components, context) {
    const basicSalary = Number(context.basicSalary || 0);
    const workingDays = Number(context.workingDays || 30);
    const unpaidDays = Number(context.unpaidDays || 0);
    const overtimeHours = Number(context.overtimeHours || 0);

    const empDailyHours = Number(context.dailyHours || context.workingHours || 8);
    const computed = {
        basic: basicSalary,
        basic_salary: basicSalary,
        working_days: workingDays,
        unpaid_days: unpaidDays,
        overtime_hours: overtimeHours,
        daily_hours: empDailyHours,
        working_hours: empDailyHours,
    };

    let runningGross = basicSalary;
    let totalEarnings = basicSalary;
    let totalDeductions = 0;
    let totalEmployerContributions = 0;
    let totalReimbursements = 0;
    let totalTaxableIncome = basicSalary;

    const earningsSnapshots = [];
    const deductionsSnapshots = [];
    const employerSnapshots = [];
    const reimbursementSnapshots = [];

    // Filter and sort active components (Basic first)
    const activeComps = components.filter((c) => c.status === "active");

    for (const comp of activeComps) {
        if (comp.code === "BASIC") {
            computed["BASIC"] = basicSalary;
            earningsSnapshots.push({
                code: comp.code,
                name: comp.name,
                type: comp.type,
                amount: basicSalary,
                formulaApplied: `Base Basic Salary = ${basicSalary.toLocaleString()}`,
                isTaxable: comp.isTaxable,
                includeInGross: comp.includeInGross,
            });
            continue;
        }

        // Check eligibility for non-basic components
        if (context.employee && !isComponentEligibleForEmployee(comp, context.employee)) {
            continue;
        }

        computed["gross"] = runningGross;
        computed["gross_salary"] = runningGross;
        computed["total_earnings"] = totalEarnings;

        let rawAmount = 0;
        let explanation = "";

        switch (comp.calculationMethod) {
            case "fixed": {
                const monthBaseDays = context.monthBaseDays || 30;
                if (workingDays < monthBaseDays && comp.isRecurring && comp.type === "earning") {
                    rawAmount = Math.round(((comp.fixedAmount || 0) / monthBaseDays) * workingDays);
                    explanation = `Prorated Fixed (${comp.fixedAmount} monthly): ${rawAmount.toLocaleString()} for ${workingDays} days`;
                } else {
                    rawAmount = comp.fixedAmount || 0;
                    explanation = `Fixed: ${rawAmount.toLocaleString()}`;
                }
                break;
            }

            case "percent_basic": {
                const pct = comp.percentage || 0;
                rawAmount = (basicSalary * pct) / 100;
                explanation = `${pct}% of Basic (${basicSalary.toLocaleString()})`;
                break;
            }

            case "percent_components": {
                const pct = comp.percentage || 0;
                const codes = comp.selectedComponentCodes?.length ? comp.selectedComponentCodes : ["BASIC"];
                let sum = 0;
                for (const c of codes) {
                    sum += computed[c.toUpperCase()] || computed[c.toLowerCase()] || 0;
                }
                rawAmount = (sum * pct) / 100;
                explanation = `${pct}% of [${codes.join(" + ")}]`;
                break;
            }

            case "unit_x_rate": {
                const rate = comp.ratePerUnit || 0;
                let units = 0;
                if (comp.code.includes("OT") || comp.code.includes("OVERTIME") || comp.name?.toUpperCase().includes("OVERTIME")) {
                    units = overtimeHours || (comp.defaultUnits || 0);
                } else {
                    units = context.customUnits?.[comp.code] ?? (comp.defaultUnits || 0);
                }
                rawAmount = units * rate;
                explanation = `${units} ${comp.unitName || "units"} × ${rate}`;
                break;
            }

            case "per_day": {
                let dailyRate = 0;
                if (comp.perDayBasis === "gross_30") {
                    dailyRate = runningGross / workingDays;
                } else if (comp.perDayBasis === "custom_rate") {
                    dailyRate = comp.customDailyRate || 0;
                } else {
                    dailyRate = basicSalary / workingDays;
                }
                const isAbsenceComp = comp.code === "UNPAID_ABSENCE" || comp.code.includes("ABSENCE") || comp.code.includes("LOP");
                const days = isAbsenceComp
                    ? Number(context.unexcusedAbsenceDays !== undefined ? context.unexcusedAbsenceDays : unpaidDays)
                    : (unpaidDays || (comp.defaultUnits || 0));
                rawAmount = days * dailyRate;
                explanation = `${days} day(s) × Daily Rate (${dailyRate.toFixed(2)})`;
                break;
            }

            case "manual": {
                rawAmount = context.manualInputs?.[comp.code] ?? (comp.manualDefaultAmount || 0);
                explanation = `Manual input: ${rawAmount.toLocaleString()}`;
                break;
            }

            case "formula": {
                rawAmount = evaluateFormula(comp.formula, computed);
                explanation = `Formula: ${comp.formula}`;
                break;
            }
        }

        // Apply Min / Max Caps
        let finalAmount = rawAmount;
        if (comp.minAmount !== null && comp.minAmount !== undefined && finalAmount < comp.minAmount) {
            finalAmount = comp.minAmount;
        }
        if (comp.maxAmount !== null && comp.maxAmount !== undefined && finalAmount > comp.maxAmount) {
            finalAmount = comp.maxAmount;
        }

        // Apply Rounding
        finalAmount = applyRounding(finalAmount, comp.roundingRule);

        computed[comp.code.toUpperCase()] = finalAmount;
        computed[comp.code.toLowerCase()] = finalAmount;

        const snapshot = {
            code: comp.code,
            name: comp.name,
            type: comp.type,
            amount: finalAmount,
            formulaApplied: explanation,
            isTaxable: comp.isTaxable,
            includeInGross: comp.includeInGross,
        };

        switch (comp.type) {
            case "earning":
                totalEarnings += finalAmount;
                if (comp.includeInGross) runningGross += finalAmount;
                earningsSnapshots.push(snapshot);
                if (comp.isTaxable) totalTaxableIncome += finalAmount;
                break;

            case "deduction":
                totalDeductions += finalAmount;
                deductionsSnapshots.push(snapshot);
                break;

            case "employer_contribution":
                totalEmployerContributions += finalAmount;
                employerSnapshots.push(snapshot);
                break;

            case "reimbursement":
                totalReimbursements += finalAmount;
                reimbursementSnapshots.push(snapshot);
                break;
        }
    }

    const netSalary = Math.max(0, totalEarnings - totalDeductions + totalReimbursements);
    const costToCompany = totalEarnings + totalEmployerContributions + totalReimbursements;

    return {
        basicSalary,
        grossSalary: runningGross,
        totalEarnings,
        totalDeductions,
        totalEmployerContributions,
        totalReimbursements,
        netSalary,
        costToCompany,
        taxableIncome: totalTaxableIncome,
        earnings: earningsSnapshots,
        deductions: deductionsSnapshots,
        employerContributions: employerSnapshots,
        reimbursements: reimbursementSnapshots,
    };
}

// -------------------------------------------------------------------
// Service Functions
// -------------------------------------------------------------------

export async function getComponents(workspaceId) {
    let comps = await SalaryComponent.find({ workspace: workspaceId }).sort({ createdAt: 1 });

    // Auto-seed default components if workspace has 0 components
    if (!comps || comps.length === 0) {
        const seedPayload = DEFAULT_WORKSPACE_COMPONENTS.map((item) => ({
            ...item,
            workspace: workspaceId,
        }));
        await SalaryComponent.insertMany(seedPayload);
        comps = await SalaryComponent.find({ workspace: workspaceId }).sort({ createdAt: 1 });
    }

    return comps;
}

export async function createComponent(workspaceId, data) {
    const ws = await Workspace.findById(workspaceId).select("subscription").lean();
    const planConfig = resolvePlanConfig(ws?.subscription);
    if (planConfig.maxSalaryComponents !== null) {
        const count = await SalaryComponent.countDocuments({ workspace: workspaceId });
        if (count >= planConfig.maxSalaryComponents) {
            throw ApiError.forbidden(
                `${planConfig.planName} is limited to a maximum of ${planConfig.maxSalaryComponents} salary components. Upgrade to Paid Pro ($49/mo) for unlimited salary components.`,
                "PLAN_UPGRADE_REQUIRED"
            );
        }
    }

    const existing = await SalaryComponent.findOne({
        workspace: workspaceId,
        code: data.code.toUpperCase(),
    });
    if (existing) {
        throw ApiError.badRequest(`Component code "${data.code}" already exists in workspace.`);
    }

    const comp = await SalaryComponent.create({
        ...data,
        code: data.code.toUpperCase(),
        workspace: workspaceId,
    });
    return comp;
}

export async function updateComponent(workspaceId, id, patch) {
    const comp = await SalaryComponent.findOneAndUpdate(
        { _id: id, workspace: workspaceId },
        { ...patch, ...(patch.code ? { code: patch.code.toUpperCase() } : {}) },
        { new: true, runValidators: true }
    );
    if (!comp) {
        throw ApiError.notFound("Salary component not found.");
    }
    return comp;
}

export async function deleteComponent(workspaceId, id) {
    const comp = await SalaryComponent.findOne({ _id: id, workspace: workspaceId });
    if (!comp) {
        throw ApiError.notFound("Salary component not found.");
    }
    if (comp.isSystem) {
        throw ApiError.badRequest("Cannot delete base system component.");
    }
    await SalaryComponent.deleteOne({ _id: id });
    return true;
}

export async function resetComponents(workspaceId) {
    await SalaryComponent.deleteMany({ workspace: workspaceId, isSystem: { $ne: true } });
    const existingBasic = await SalaryComponent.findOne({ workspace: workspaceId, code: "BASIC" });
    if (!existingBasic) {
        await SalaryComponent.deleteMany({ workspace: workspaceId });
    }
    const seedPayload = DEFAULT_WORKSPACE_COMPONENTS.map((item) => ({
        ...item,
        workspace: workspaceId,
    }));
    await SalaryComponent.insertMany(seedPayload);
    return SalaryComponent.find({ workspace: workspaceId }).sort({ createdAt: 1 });
}

// -------------------------------------------------------------------
// Leave & Absence Breakdown Helper for Payroll
// -------------------------------------------------------------------

/**
 * Calculates tenure in the current payroll period for employees who joined or exited mid-period.
 */
export function calculateTenureAndProration({
    employee,
    fromIso,
    toIso,
    effectiveWorkingDays,
    attendanceRecords = [],
    month,
}) {
    if (!employee) {
        return {
            joiningIso: fromIso,
            preJoiningDays: 0,
            postExitDays: 0,
            employedDays: effectiveWorkingDays,
            isNewHireThisMonth: false,
        };
    }

    // Resolve employee effective joining / start date
    let joiningIso = fromIso;
    if (employee.joiningDate) {
        joiningIso = new Date(employee.joiningDate).toISOString().slice(0, 10);
    } else if (employee.createdAt) {
        joiningIso = new Date(employee.createdAt).toISOString().slice(0, 10);
    }

    // Do NOT adopt pre-joining auto attendance records; employee joining date is strictly authoritative
    const isNewHireThisMonth = joiningIso >= fromIso && joiningIso <= toIso;

    // effectiveWorkingDays passed into this function is already the employee's tenure working days
    const employedDays = effectiveWorkingDays;

    return {
        joiningIso,
        preJoiningDays: 0,
        postExitDays: 0,
        employedDays,
        isNewHireThisMonth,
    };
}

/**
 * Calculates attendance, paid leave days, excess/unpaid leave days, and unexcused absences
 * for an employee within a payroll period [fromIso, toIso].
 */
export async function calculateEmployeeLeaveAndAbsenceBreakdown(
    workspace,
    employeeId,
    fromIso,
    toIso,
    effectiveWorkingDays,
    employeeDoc = null
) {
    const employee = employeeDoc || await Employee.findById(employeeId).lean();

    // 1. Fetch attendance records in range
    const attendanceRecords = await AttendanceRecord.find({
        workspace: workspace._id,
        employee: employeeId,
        date: { $gte: fromIso, $lte: toIso },
    }).sort({ date: 1 }).lean();

    // 2. Fetch approved leave requests overlapping with this period
    const approvedLeaves = await LeaveRequest.find({
        workspace: workspace._id,
        employee: employeeId,
        status: "approved",
        startDate: { $lte: toIso },
        endDate: { $gte: fromIso },
    }).lean();

    // 3. Tenure in this period
    const month = fromIso.slice(0, 7);
    const tenure = calculateTenureAndProration({
        employee,
        fromIso,
        toIso,
        effectiveWorkingDays,
        attendanceRecords,
        month,
    });

    // Count present days and absences from attendance records during employed period
    let recordedAbsentCount = 0;
    let recordedHalfDayCount = 0;
    const datesWithAttendance = new Set();
    const attendanceLeaveDates = new Set();

    for (const att of attendanceRecords) {
        datesWithAttendance.add(att.date);
        if (att.date < tenure.joiningIso) continue; // Ignore pre-hire records if any
        const normStatus = String(att.status || "").toLowerCase().trim();
        if (normStatus === "half-day") {
            recordedHalfDayCount += 1;
        } else if (normStatus === "on-leave") {
            attendanceLeaveDates.add(att.date);
        } else if (normStatus === "absent") {
            recordedAbsentCount += 1;
        }
    }

    // If no attendance records logged at all in this period, credit full employed days
    if (attendanceRecords.length === 0 && approvedLeaves.length === 0) {
        const present = Math.max(0, Math.round(tenure.employedDays * 10) / 10);
        const unpaid = Math.min(effectiveWorkingDays, Math.round((effectiveWorkingDays - present) * 10) / 10);
        return {
            presentDays: present,
            paidLeaveDays: 0,
            unpaidLeaveDays: 0,
            unexcusedAbsenceDays: 0,
            preJoiningDays: tenure.preJoiningDays,
            employedDays: tenure.employedDays,
            isNewHireThisMonth: tenure.isNewHireThisMonth,
            joiningIso: tenure.joiningIso,
            unpaidDays: unpaid,
        };
    }

    // 4. Collect all leave dates and leave categories in this period
    // Combine approved leave requests and attendance records marked on-leave
    const leaveBreakdown = [];
    const accountedLeaveDates = new Set();

    const weekendDays = Array.isArray(workspace?.attendance?.weekendDays) && workspace.attendance.weekendDays.length > 0
        ? workspace.attendance.weekendDays
        : [0, 6];

    for (const req of approvedLeaves) {
        const sStr = req.startDate < fromIso ? fromIso : req.startDate;
        const eStr = req.endDate > toIso ? toIso : req.endDate;
        const [sy, sm, sd] = sStr.split("-").map(Number);
        const [ey, em, ed] = eStr.split("-").map(Number);
        const cur = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
        const end = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));

        while (cur <= end) {
            const dateStr = cur.toISOString().slice(0, 10);
            const dow = cur.getUTCDay();
            if (!weekendDays.includes(dow)) {
                if (!accountedLeaveDates.has(dateStr)) {
                    accountedLeaveDates.add(dateStr);
                    leaveBreakdown.push({
                        date: dateStr,
                        category: req.category || "leave",
                        leaveType: req.leaveType || req.type || "annual",
                        isHalfDay: Boolean(req.isHalfDay),
                    });
                }
            }
            cur.setUTCDate(cur.getUTCDate() + 1);
        }
    }

    // Include any attendance records marked 'on-leave' not already accounted
    for (const dateStr of attendanceLeaveDates) {
        if (!accountedLeaveDates.has(dateStr)) {
            accountedLeaveDates.add(dateStr);
            leaveBreakdown.push({
                date: dateStr,
                category: "leave",
                leaveType: "annual",
                isHalfDay: false,
            });
        }
    }

    // 5. Evaluate leave entitlements using calculateAllLeaveBalances
    const leaveSummary = await calculateAllLeaveBalances(workspace, employeeId);
    let paidLeaveDays = 0;
    let unpaidLeaveDays = 0;

    const noLeavePolicy = Boolean(workspace?.attendance?.noLeavePolicy);
    const weekendWorkEarnsLeave = Boolean(workspace?.attendance?.weekendWorkEarnsLeave);

    if (noLeavePolicy) {
        if (weekendWorkEarnsLeave) {
            // Employee earns leaves by working on weekends.
            let availableCredits = Math.max(0, leaveSummary.weekendAccruals?.activeBalance || 0);
            for (const item of leaveBreakdown) {
                const dayWeight = item.isHalfDay ? 0.5 : 1.0;
                if (availableCredits >= dayWeight) {
                    paidLeaveDays += dayWeight;
                    availableCredits -= dayWeight;
                } else if (availableCredits > 0) {
                    paidLeaveDays += availableCredits;
                    unpaidLeaveDays += (dayWeight - availableCredits);
                    availableCredits = 0;
                } else {
                    unpaidLeaveDays += dayWeight;
                }
            }
        } else {
            // No leave policy and no weekend earning: ALL leaves are unpaid!
            for (const item of leaveBreakdown) {
                const dayWeight = item.isHalfDay ? 0.5 : 1.0;
                unpaidLeaveDays += dayWeight;
            }
        }
    } else {
        // Standard leave policy (detailed or unified)
        const balances = leaveSummary.balances || {};
        for (const item of leaveBreakdown) {
            const dayWeight = item.isHalfDay ? 0.5 : 1.0;
            const typeKey = (item.leaveType || "annual").toLowerCase().trim();
            const bal = balances[typeKey] || balances["annual"];

            if (typeKey === "unpaid" || (bal && bal.isPaid === false)) {
                unpaidLeaveDays += dayWeight;
            } else if (bal) {
                const excessForYear = Math.max(0, (bal.used || 0) - (bal.allowance || 0));
                if (excessForYear > 0) {
                    unpaidLeaveDays += Math.min(dayWeight, excessForYear);
                    paidLeaveDays += Math.max(0, dayWeight - excessForYear);
                } else {
                    paidLeaveDays += dayWeight;
                }
            } else {
                unpaidLeaveDays += dayWeight;
            }
        }
    }

    // 6. Compute unexcused absences and unpaid days from real-time records + tenure
    const unexcusedAbsenceDays = Math.round((recordedAbsentCount + (recordedHalfDayCount * 0.5)) * 10) / 10;
    const totalUnpaidDays = Math.min(
        effectiveWorkingDays,
        Math.round((unexcusedAbsenceDays + unpaidLeaveDays) * 10) / 10
    );
    const calculatedPresentDays = Math.max(
        0,
        Math.round((effectiveWorkingDays - totalUnpaidDays) * 10) / 10
    );

    return {
        presentDays: calculatedPresentDays,
        paidLeaveDays: Math.round(paidLeaveDays * 10) / 10,
        unpaidLeaveDays: Math.round(unpaidLeaveDays * 10) / 10,
        unexcusedAbsenceDays,
        preJoiningDays: tenure.preJoiningDays,
        employedDays: tenure.employedDays,
        isNewHireThisMonth: tenure.isNewHireThisMonth,
        joiningIso: tenure.joiningIso,
        unpaidDays: totalUnpaidDays,
    };
}

// -------------------------------------------------------------------
// Payroll Batch Execution Service
// -------------------------------------------------------------------

export async function generatePayrollBatch(workspaceId, month, userId, adjustments = [], payFrequency = "All") {
    const [settings, components, workspace] = await Promise.all([
        getPayrollSettings(workspaceId),
        getComponents(workspaceId),
        Workspace.findById(workspaceId).lean(),
    ]);

    if (!workspace) throw ApiError.notFound("Workspace not found");

    if (userId) {
        const { getCallerRoleContext } = await import("../employee/employee.service.js");
        const { isManager } = await getCallerRoleContext(userId, workspace);
        if (isManager) {
            throw ApiError.forbidden("Managers cannot generate payroll.");
        }
    }

    // Check if a batch already exists for this month and frequency
    const batchFilter = { workspace: workspaceId, month };
    if (payFrequency && payFrequency !== "All") {
        batchFilter.payFrequency = payFrequency;
    }
    let existingBatch = await PayrollBatch.findOne(batchFilter);
    if (existingBatch && existingBatch.status === "disbursed") {
        throw ApiError.badRequest(`Payroll for ${month} (${payFrequency}) has already been disbursed.`);
    }

    // 2. Load all active employees in this workspace sorted alphabetically
    const empFilter = {
        workspace: workspaceId,
        employmentStatus: { $in: ["Active", "Probation", "On Leave"] },
    };
    if (payFrequency && payFrequency !== "All") {
        empFilter.payFrequency = payFrequency;
    }
    const employees = await Employee.find(empFilter).sort({ firstName: 1, lastName: 1 });

    if (employees.length === 0) {
        throw ApiError.badRequest(
            payFrequency && payFrequency !== "All"
                ? `No eligible employees found with pay frequency "${payFrequency}".`
                : "No eligible employees found in workspace."
        );
    }

    // 3. Determine exact date bounds for this month (avoiding UTC timezone shift)
    const [year, mStr] = month.split("-").map(Number);
    const mm = String(mStr).padStart(2, "0");
    const daysInMonth = new Date(year, mStr, 0).getDate();
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const isCurrentOngoingMonth = month === todayIso.slice(0, 7);
    const elapsedDays = isCurrentOngoingMonth ? Math.min(daysInMonth, today.getDate()) : daysInMonth;

    const fromIso = `${year}-${mm}-01`;
    const toIso = `${year}-${mm}-${String(elapsedDays).padStart(2, "0")}`;
    const periodStart = new Date(Date.UTC(year, mStr - 1, 1));
    const periodEnd = new Date(Date.UTC(year, mStr - 1, elapsedDays, 23, 59, 59));

    // When generating payroll for the current ongoing month, working days is elapsed days (past + present = e.g. 15 on 15/11/2026)
    // When generating for a past completed month, working days is the full month standard (e.g. 30 or daysInMonth)
    let effectiveWorkingDays = elapsedDays;
    if (!isCurrentOngoingMonth) {
        if (settings.workingDaysBasis === "fixed_30") effectiveWorkingDays = 30;
        else if (settings.workingDaysBasis === "fixed_26") effectiveWorkingDays = 26;
        else if (settings.workingDaysBasis === "custom") effectiveWorkingDays = settings.customWorkingDays || 30;
        else effectiveWorkingDays = daysInMonth;
    }

    const monthBaseDays = settings.workingDaysBasis === "fixed_30" ? 30 : daysInMonth;

    // Use provided adjustments if explicitly passed (e.g. from Attendance & Adjustments page)
    const effectiveAdjustments = Array.isArray(adjustments) && adjustments.length > 0 ? adjustments : [];

    // 4. Load attendance summaries & loans for this month
    const entries = [];
    let batchGross = 0;
    let batchEarnings = 0;
    let batchDeductions = 0;
    let batchNet = 0;
    let batchEmployer = 0;
    let batchReimbursement = 0;
    let batchCTC = 0;

    for (const emp of employees) {
        // Resolve employee joining date
        let empJoiningIso = fromIso;
        if (emp.joiningDate) {
            empJoiningIso = new Date(emp.joiningDate).toISOString().slice(0, 10);
        } else if (emp.createdAt) {
            empJoiningIso = new Date(emp.createdAt).toISOString().slice(0, 10);
        }

        // Calculate tenure-based working days for this employee
        let empWorkingDays = effectiveWorkingDays;
        if (empJoiningIso.startsWith(month)) {
            const joinDay = parseInt(empJoiningIso.split("-")[2], 10);
            if (isCurrentOngoingMonth) {
                if (joinDay > elapsedDays) {
                    empWorkingDays = 0;
                } else {
                    empWorkingDays = Math.max(1, elapsedDays - joinDay + 1);
                }
            } else {
                if (joinDay > 1) {
                    empWorkingDays = Math.max(1, monthBaseDays - joinDay);
                }
            }
        } else if (empJoiningIso > toIso) {
            empWorkingDays = 0;
        }

        // Check if HR provided manual adjustments for this employee
        const manualAdj = effectiveAdjustments.find(
            (a) =>
                (a.employeeId && String(a.employeeId) === String(emp.employeeId)) ||
                (a.id && String(a.id) === String(emp._id)) ||
                (a.employee && String(a.employee) === String(emp._id))
        );

        if (manualAdj && manualAdj.workingDays !== undefined && manualAdj.workingDays !== null) {
            empWorkingDays = Number(manualAdj.workingDays);
        }

        let presentDays = 0;
        let unpaidDays = 0;
        let paidLeaveDays = 0;
        let unpaidLeaveDays = 0;
        let unexcusedAbsenceDays = 0;
        let overtimeHours = 0;

        let breakdownResult = null;
        if (manualAdj) {
            unpaidDays = Math.max(0, Number(manualAdj.unpaidDays) || 0);
            const breakdown = await calculateEmployeeLeaveAndAbsenceBreakdown(
                workspace,
                emp._id,
                fromIso,
                toIso,
                empWorkingDays,
                emp
            );
            breakdownResult = breakdown;
            unpaidLeaveDays = manualAdj.unpaidLeaveDays !== undefined && manualAdj.unpaidLeaveDays !== null
                ? Math.max(0, Number(manualAdj.unpaidLeaveDays) || 0)
                : Math.min(unpaidDays, breakdown.unpaidLeaveDays);
            paidLeaveDays = manualAdj.paidLeaveDays !== undefined && manualAdj.paidLeaveDays !== null
                ? Math.max(0, Number(manualAdj.paidLeaveDays) || 0)
                : breakdown.paidLeaveDays;
            unexcusedAbsenceDays = Math.max(0, unpaidDays - unpaidLeaveDays);
            overtimeHours = Math.max(0, Number(manualAdj.overtimeHours) || 0);
            presentDays =
                manualAdj.presentDays !== undefined && manualAdj.presentDays !== null
                    ? Math.max(0, Math.min(empWorkingDays, Number(manualAdj.presentDays)))
                    : Math.max(0, empWorkingDays - unpaidDays - paidLeaveDays);
        } else {
            const breakdown = await calculateEmployeeLeaveAndAbsenceBreakdown(
                workspace,
                emp._id,
                fromIso,
                toIso,
                empWorkingDays,
                emp
            );
            breakdownResult = breakdown;
            presentDays = breakdown.presentDays;
            paidLeaveDays = breakdown.paidLeaveDays;
            unpaidLeaveDays = breakdown.unpaidLeaveDays;
            unexcusedAbsenceDays = breakdown.unexcusedAbsenceDays;
            unpaidDays = breakdown.unpaidDays;
        }

        // Check active loan monthly installments
        const activeLoans = await EmployeeLoan.find({
            workspace: workspaceId,
            employee: emp._id,
            status: "active",
            remainingBalance: { $gt: 0 },
        });

        let loanDeductionTotal = 0;
        activeLoans.forEach((l) => {
            loanDeductionTotal += Math.min(l.monthlyInstallment, l.remainingBalance);
        });

        // Check short hours / early departure deductions from attendance records if enabled
        let shortHoursDeductionTotal = 0;
        if (workspace?.attendance?.deductShortHours) {
            const monthRecords = await AttendanceRecord.find({
                workspace: workspaceId,
                employee: emp._id,
                date: { $gte: fromIso, $lte: toIso },
            }).select("deductionAmount").lean();
            shortHoursDeductionTotal = monthRecords.reduce((sum, r) => sum + (Number(r.deductionAmount) || 0), 0);
            shortHoursDeductionTotal = Math.round(shortHoursDeductionTotal * 100) / 100;
        }

        const manualInputs = {};
        if (loanDeductionTotal > 0) {
            manualInputs["LOAN_REC"] = loanDeductionTotal;
        }

        // Run calculation engine for this employee based on effective working days
        const basePay = emp.salaryAmount || emp.basicSalary || (emp.grossSalary ? Math.round(emp.grossSalary * 0.5) : 75000);
        const fullMonthlyDailyRate = basePay / monthBaseDays;
        const periodBasic = Math.round(fullMonthlyDailyRate * empWorkingDays);

        const empWorkingHours = emp.workingHours || (parseFloat(emp.workSchedule) || settings.dailyWorkingHours || 8);
        const calculated = calculateEmployeePayroll(components, {
            basicSalary: periodBasic,
            workingDays: empWorkingDays,
            monthBaseDays,
            presentDays,
            unpaidDays,
            unpaidLeaveDays,
            unexcusedAbsenceDays,
            overtimeHours,
            dailyHours: empWorkingHours,
            workingHours: empWorkingHours,
            manualInputs,
            employee: emp,
        });

        // Ensure functional overtime payout if hours worked > 0
        const hourlyRate = Math.round(fullMonthlyDailyRate / (empWorkingHours || 8));
        const otPayout = overtimeHours * Math.round(hourlyRate * 1.5);
        if (overtimeHours > 0 && !calculated.earnings.some((e) => e.code === "OT" || e.name?.toLowerCase().includes("overtime"))) {
            calculated.earnings.push({
                code: "OT",
                name: "Overtime Allowance",
                type: "earning",
                amount: otPayout,
                formulaApplied: `${overtimeHours} hrs × 1.5 × ${hourlyRate}/hr`,
                isTaxable: true,
                includeInGross: true,
            });
            calculated.totalEarnings += otPayout;
            calculated.grossSalary += otPayout;
            calculated.netSalary += otPayout;
        }

        // Add loan deduction row if applicable
        if (loanDeductionTotal > 0) {
            calculated.deductions.push({
                code: "LOAN_REC",
                name: "Loan & Advance Recovery",
                type: "deduction",
                amount: loanDeductionTotal,
                formulaApplied: `Monthly installment: ${loanDeductionTotal.toLocaleString()}`,
                isTaxable: false,
                includeInGross: false,
            });
            calculated.totalDeductions += loanDeductionTotal;
            calculated.netSalary = Math.max(0, calculated.netSalary - loanDeductionTotal);
        }

        // Add short hours / early departure deduction if applicable
        if (shortHoursDeductionTotal > 0) {
            calculated.deductions.push({
                code: "SHORT_HOURS_DEDUCTION",
                name: "Short Hours / Early Departure Deduction",
                type: "deduction",
                amount: shortHoursDeductionTotal,
                formulaApplied: `Hourly prorated short hours deduction across ${month} attendance records`,
                isTaxable: false,
                includeInGross: false,
            });
            calculated.totalDeductions += shortHoursDeductionTotal;
            calculated.netSalary = Math.max(0, calculated.netSalary - shortHoursDeductionTotal);
        }

        // 1. Calculate Daily Rate based on workspace payroll settings
        let dailyRate = 0;
        if (settings.unpaidAbsenceMethod === "gross_30") {
            dailyRate = calculated.grossSalary / (empWorkingDays || 30);
        } else if (settings.unpaidAbsenceMethod === "custom_rate") {
            dailyRate = settings.customDailyAbsenceRate || 0;
        } else {
            dailyRate = calculated.basicSalary / (empWorkingDays || 30);
        }

        // 2. Excess / Unpaid Leave Deduction (deduct salary if employee takes leaves they don't have)
        if (unpaidLeaveDays > 0) {
            const leaveDeduction = Math.round(unpaidLeaveDays * dailyRate);
            calculated.deductions.push({
                code: "UNPAID_LEAVE_DEDUCTION",
                name: "Excess / Unpaid Leave Deduction",
                type: "deduction",
                amount: leaveDeduction,
                formulaApplied: `${unpaidLeaveDays} day(s) excess/unpaid leave × Daily Rate (${dailyRate.toFixed(2)})`,
                isTaxable: false,
                includeInGross: false,
            });
            calculated.totalDeductions += leaveDeduction;
            calculated.netSalary = Math.max(0, calculated.netSalary - leaveDeduction);
        }

        // 3. Unpaid Absence Deduction (deduct salary for unpaid days out of workingDays)
        const existingAbsenceIdx = calculated.deductions.findIndex(
            (d) => d.code === "UNPAID_ABSENCE" || d.code.includes("ABSENCE") || d.code.includes("LOP")
        );
        if (unpaidDays > 0) {
            const absenceDeduction = Math.round(unpaidDays * dailyRate);
            if (existingAbsenceIdx >= 0) {
                // Adjust existing component so it reflects exact unpaid days
                const prevAmt = calculated.deductions[existingAbsenceIdx].amount || 0;
                calculated.deductions[existingAbsenceIdx].amount = absenceDeduction;
                calculated.deductions[existingAbsenceIdx].formulaApplied = `${unpaidDays} unpaid day(s) × Daily Rate (${dailyRate.toFixed(2)})`;
                calculated.totalDeductions = calculated.totalDeductions - prevAmt + absenceDeduction;
                calculated.netSalary = Math.max(0, calculated.netSalary + prevAmt - absenceDeduction);
            } else {
                calculated.deductions.push({
                    code: "UNPAID_ABSENCE",
                    name: "Unpaid Absence Deduction",
                    type: "deduction",
                    amount: absenceDeduction,
                    formulaApplied: `${unpaidDays} unpaid day(s) × Daily Rate (${dailyRate.toFixed(2)})`,
                    isTaxable: false,
                    includeInGross: false,
                });
                calculated.totalDeductions += absenceDeduction;
                calculated.netSalary = Math.max(0, calculated.netSalary - absenceDeduction);
            }
        } else if (existingAbsenceIdx >= 0) {
            // If employee had 0 unpaid days, remove the 0 absence deduction from total
            const prevAmt = calculated.deductions[existingAbsenceIdx].amount || 0;
            calculated.totalDeductions -= prevAmt;
            calculated.netSalary += prevAmt;
            calculated.deductions.splice(existingAbsenceIdx, 1);
        }

        const employeeCurrency = emp.salaryCurrency || emp.currency || workspace.currency || "PKR";

        entries.push({
            employee: emp._id,
            employeeId: emp.employeeId,
            employeeName: `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name,
            employeeEmail: emp.workEmail || emp.personalEmail || emp.loginEmail || "",
            employeeAvatar: emp.avatar || "",
            department: emp.department || "General",
            designation: emp.designation || "Staff",
            branch: emp.workLocation || emp.branch || "Head Office",
            workingDays: empWorkingDays,
            presentDays,
            paidLeaveDays,
            unpaidLeaveDays,
            unpaidDays,
            overtimeHours,
            currency: employeeCurrency,
            isManualAdjustment: Boolean(manualAdj?.isManualAdjustment),
            basicSalary: calculated.basicSalary,
            earnings: calculated.earnings,
            deductions: calculated.deductions,
            employerContributions: calculated.employerContributions,
            reimbursements: calculated.reimbursements,
            grossSalary: calculated.grossSalary,
            totalEarnings: calculated.totalEarnings,
            totalDeductions: calculated.totalDeductions,
            totalEmployerContributions: calculated.totalEmployerContributions,
            totalReimbursements: calculated.totalReimbursements,
            netSalary: calculated.netSalary,
            costToCompany: calculated.costToCompany,
            taxableIncome: calculated.taxableIncome,
            paymentMethod: emp.payFrequency ? "bank_transfer" : settings.defaultPaymentMethod || "bank_transfer",
            paymentStatus: "pending",
            bankAccountDetails: {
                bankName: (emp.bankName && emp.bankName !== "NILL" && emp.bankName !== "Not Configured")
                    ? emp.bankName.trim()
                    : "Not Configured",
                accountNumber: (emp.bankAccountNumber && emp.bankAccountNumber !== "Pending Setup" && emp.bankAccountNumber !== "Not Configured")
                    ? emp.bankAccountNumber.trim()
                    : "Not Configured",
                accountTitle: `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name,
            },
        });

        batchGross += calculated.grossSalary;
        batchEarnings += calculated.totalEarnings;
        batchDeductions += calculated.totalDeductions;
        batchNet += calculated.netSalary;
        batchEmployer += calculated.totalEmployerContributions;
        batchReimbursement += calculated.totalReimbursements;
        batchCTC += calculated.costToCompany;
    }

    // Uniform alphabetical sort for all batch entries
    entries.sort((a, b) => (a.employeeName || "").localeCompare(b.employeeName || ""));

    const batchTitle = payFrequency && payFrequency !== "All"
        ? `${payFrequency} Payroll - ${new Date(year, mStr - 1).toLocaleString("en-US", { month: "long" })} ${year}`
        : `${new Date(year, mStr - 1).toLocaleString("en-US", { month: "long" })} ${year} Regular Payroll`;

    const currencyBreakdown = buildBatchCurrencyBreakdown(entries, workspace.currency || "PKR");

    const batchData = {
        workspace: workspaceId,
        month,
        payFrequency: payFrequency || "All",
        title: batchTitle,
        periodStart,
        periodEnd,
        status: "draft",
        processedAt: new Date(),
        processedBy: userId,
        totalEmployees: entries.length,
        totalGross: batchGross,
        totalEarnings: batchEarnings,
        totalDeductions: batchDeductions,
        totalNetPay: batchNet,
        totalEmployerContributions: batchEmployer,
        totalReimbursements: batchReimbursement,
        totalCostToCompany: batchCTC,
        currencyBreakdown,
        entries,
    };

    if (existingBatch) {
        Object.assign(existingBatch, batchData);
        await existingBatch.save();
        return existingBatch;
    } else {
        const newBatch = await PayrollBatch.create(batchData);
        return newBatch;
    }
}

/**
 * Returns payroll alerts for different employee pay frequencies.
 * Emits alert: "Time to make payslip for the Pay frequency of Semi Monthly, Weekly, Bi Weekly or Monthly"
 */
export async function getPayrollFrequencyAlerts(workspaceId, month) {
    if (!month) {
        const now = new Date();
        month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    }

    const employees = await Employee.find({
        workspace: workspaceId,
        employmentStatus: { $in: ["Active", "Probation", "On Leave"] },
    }).select("payFrequency employeeId firstName lastName").lean();

    const frequencyCounts = {};
    for (const emp of employees) {
        const freq = emp.payFrequency || "Monthly";
        frequencyCounts[freq] = (frequencyCounts[freq] || 0) + 1;
    }

    const batches = await PayrollBatch.find({
        workspace: workspaceId,
        month,
    }).select("payFrequency status _id").lean();

    const batchMap = new Map();
    for (const b of batches) {
        batchMap.set(b.payFrequency || "All", b);
    }

    const alerts = [];
    const pendingFrequencies = [];

    for (const freq of Object.keys(frequencyCounts)) {
        const count = frequencyCounts[freq];
        if (count > 0) {
            const batch = batchMap.get(freq) || (freq === "Monthly" ? batchMap.get("All") : null);
            const isDisbursed = batch?.status === "disbursed";

            if (!batch || batch.status === "draft") {
                pendingFrequencies.push(freq);
                alerts.push({
                    payFrequency: freq,
                    count,
                    status: batch ? "draft" : "unprocessed",
                    batchId: batch?._id || null,
                    message: `Time to make payslip for the Pay frequency of ${freq}`,
                });
            }
        }
    }

    const narrative = pendingFrequencies.length > 0
        ? `Time to make payslip for the Pay frequency of ${pendingFrequencies.join(", ")}.`
        : "All pay frequencies processed for this cycle.";

    return {
        month,
        alerts,
        pendingFrequencies,
        narrative,
        frequencyCounts,
    };
}

export function buildBatchCurrencyBreakdown(entries = [], fallbackCurrency = "PKR") {
    const map = new Map();
    for (const e of entries || []) {
        const curr = String(
            e.currency ||
                (e.employee && typeof e.employee === "object"
                    ? e.employee.salaryCurrency || e.employee.currency
                    : "") ||
                fallbackCurrency ||
                "PKR"
        ).toUpperCase();

        const bucket = map.get(curr) || {
            currency: curr,
            employeeCount: 0,
            totalBasic: 0,
            totalGross: 0,
            totalEarnings: 0,
            totalDeductions: 0,
            totalEmployerContributions: 0,
            totalReimbursements: 0,
            totalNetPay: 0,
            totalCostToCompany: 0,
        };

        bucket.employeeCount += 1;
        bucket.totalBasic += Number(e.basicSalary) || 0;
        bucket.totalGross += Number(e.grossSalary) || 0;
        bucket.totalEarnings += Number(e.totalEarnings) || 0;
        bucket.totalDeductions += Number(e.totalDeductions) || 0;
        bucket.totalEmployerContributions += Number(e.totalEmployerContributions) || 0;
        bucket.totalReimbursements += Number(e.totalReimbursements) || 0;
        bucket.totalNetPay += Number(e.netSalary) || 0;
        bucket.totalCostToCompany += Number(e.costToCompany) || 0;
        map.set(curr, bucket);
    }

    return Array.from(map.values()).sort((a, b) => {
        if (b.employeeCount !== a.employeeCount) return b.employeeCount - a.employeeCount;
        if (b.totalNetPay !== a.totalNetPay) return b.totalNetPay - a.totalNetPay;
        return a.currency.localeCompare(b.currency);
    });
}

function sanitizeBatch(batch, fallbackCurrency = "PKR") {
    if (!batch) return batch;
    const b = batch.toObject ? batch.toObject() : batch;
    if (Array.isArray(b.entries)) {
        b.entries.forEach((e) => {
            if (e.bankAccountDetails) {
                if (!e.bankAccountDetails.bankName || e.bankAccountDetails.bankName === "NILL" || e.bankAccountDetails.bankName === "Allied Bank") {
                    e.bankAccountDetails.bankName = "Not Configured";
                }
                if (!e.bankAccountDetails.accountNumber || e.bankAccountDetails.accountNumber === "Pending Setup") {
                    e.bankAccountDetails.accountNumber = "Not Configured";
                }
            }
            if (b.status === "disbursed") {
                e.paymentStatus = "paid";
                if (!e.paidAt) e.paidAt = b.disbursedAt || new Date();
            }
            if (e.employee && typeof e.employee === "object") {
                const emp = e.employee;
                if (!e.employeeEmail) {
                    e.employeeEmail = emp.workEmail || emp.personalEmail || emp.loginEmail || emp.linkedUser?.email || "";
                }
                if (!e.employeeAvatar && emp.avatar) {
                    e.employeeAvatar = emp.avatar;
                }
                if (!e.currency) {
                    e.currency = emp.salaryCurrency || emp.currency || fallbackCurrency;
                }
                e.employee = emp._id || e.employee;
            }
        });
        b.entries.sort((a, b) => (a.employeeName || "").localeCompare(b.employeeName || ""));
        b.currencyBreakdown = buildBatchCurrencyBreakdown(b.entries, fallbackCurrency);
    }
    return b;
}

export async function getBatches(workspaceId) {
    const [batches, workspace] = await Promise.all([
        PayrollBatch.find({ workspace: workspaceId })
            .populate({
                path: "entries.employee",
                select: "workEmail personalEmail loginEmail linkedUser avatar salaryCurrency currency",
                populate: { path: "linkedUser", select: "email" },
            })
            .lean(),
        Workspace.findById(workspaceId).select("currency").lean(),
    ]);
    const wsCurrency = (workspace?.currency || "PKR").toUpperCase();

    const statusRank = { disbursed: 4, approved: 3, review: 2, draft: 1, cancelled: 0 };
    batches.sort((a, b) => {
        if (a.month !== b.month) return b.month.localeCompare(a.month);
        const rankDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
    });

    return batches.map((b) => sanitizeBatch(b, wsCurrency));
}

export async function getBatchByMonth(workspaceId, month, payFrequency) {
    const filter = { workspace: workspaceId, month };
    if (payFrequency && payFrequency !== "All") {
        filter.payFrequency = payFrequency;
    }
    const [batches, workspace] = await Promise.all([
        PayrollBatch.find(filter)
            .populate({
                path: "entries.employee",
                select: "workEmail personalEmail loginEmail linkedUser avatar salaryCurrency currency",
                populate: { path: "linkedUser", select: "email" },
            })
            .lean(),
        Workspace.findById(workspaceId).select("currency").lean(),
    ]);

    if (!batches || batches.length === 0) return null;
    const wsCurrency = (workspace?.currency || "PKR").toUpperCase();

    const statusRank = { disbursed: 4, approved: 3, review: 2, draft: 1, cancelled: 0 };
    batches.sort((a, b) => {
        const rankDiff = (statusRank[b.status] || 0) - (statusRank[a.status] || 0);
        if (rankDiff !== 0) return rankDiff;
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
    });

    return sanitizeBatch(batches[0], wsCurrency);
}

export async function getBatchById(workspaceId, batchId) {
    const [batch, workspace] = await Promise.all([
        PayrollBatch.findOne({ _id: batchId, workspace: workspaceId })
            .populate({
                path: "entries.employee",
                select: "workEmail personalEmail loginEmail linkedUser avatar salaryCurrency currency",
                populate: { path: "linkedUser", select: "email" },
            })
            .lean(),
        Workspace.findById(workspaceId).select("currency").lean(),
    ]);
    if (!batch) {
        throw ApiError.notFound("Payroll batch not found.");
    }
    const wsCurrency = (workspace?.currency || "PKR").toUpperCase();
    return sanitizeBatch(batch, wsCurrency);
}

export async function approveBatch(workspaceId, batchId, userId) {
    const workspace = await Workspace.findById(workspaceId).lean();
    if (userId && workspace) {
        const { getCallerRoleContext } = await import("../employee/employee.service.js");
        const { isManager } = await getCallerRoleContext(userId, workspace);
        if (isManager) {
            throw ApiError.forbidden("Managers cannot approve payroll batches.");
        }
    }

    const batch = await PayrollBatch.findOne({ _id: batchId, workspace: workspaceId });
    if (!batch) throw ApiError.notFound("Payroll batch not found.");
    if (batch.status === "disbursed") throw ApiError.badRequest("Batch is already disbursed.");

    batch.status = "approved";
    batch.approvedAt = new Date();
    batch.approvedBy = userId;
    await batch.save();

    // Trigger in-app notification & email reminder
    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const { sendPayrollReminderEmail } = await import("../email/email.service.js");
        const { Workspace } = await import("../../model/workspace/workspace.model.js");
        const { User } = await import("../../model/auth/auth.model.js");

        const ws = await Workspace.findById(workspaceId);
        if (ws) {
            await createNotification({
                workspaceId,
                recipientId: null,
                title: "Payroll Disbursed",
                message: `Payroll for ${batch.month} (${batch.entries.length} employees) has been disbursed successfully.`,
                type: "payroll_reminder",
                link: "/payroll/processing",
                metadata: { batchId: batch._id, month: batch.month },
            });

            const owner = await User.findById(ws.owner);
            if (owner && owner.email) {
                const pref =
                    owner.notificationPreferences?.["ceo-payroll-completed"] ??
                    owner.notificationPreferences?.["hr-payroll-ready-for-review"] ??
                    owner.notificationPreferences?.["payroll-day"] ??
                    true;
                if (pref) {
                    sendPayrollReminderEmail({
                        to: owner.email,
                        userName: owner.fullName,
                        companyName: ws.companyName,
                        period: batch.month,
                        disbursementDate: new Date().toLocaleDateString(),
                    }).catch(() => {});
                }
            }
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error on payroll disburse:", notifErr.message);
    }

    return sanitizeBatch(batch, workspace?.currency || "PKR");
}

export async function disburseBatch(workspaceId, batchId) {
    const [batch, workspace] = await Promise.all([
        PayrollBatch.findOne({ _id: batchId, workspace: workspaceId }),
        Workspace.findById(workspaceId).select("currency").lean(),
    ]);
    if (!batch) throw ApiError.notFound("Payroll batch not found.");
    if (batch.status === "disbursed") throw ApiError.badRequest("Batch is already disbursed.");

    batch.status = "disbursed";
    batch.disbursedAt = new Date();
    batch.entries.forEach((e) => {
        e.paymentStatus = "paid";
        e.paidAt = new Date();
    });

    // Update loan balances for any deducted installments
    for (const entry of batch.entries) {
        const loanRec = entry.deductions.find((d) => d.code === "LOAN_REC");
        if (loanRec && loanRec.amount > 0) {
            const loans = await EmployeeLoan.find({
                workspace: workspaceId,
                employee: entry.employee,
                status: "active",
            });
            for (const loan of loans) {
                const deduction = Math.min(loan.monthlyInstallment, loan.remainingBalance);
                loan.totalRepaid += deduction;
                loan.remainingBalance = Math.max(0, loan.remainingBalance - deduction);
                loan.deductionsHistory.push({
                    month: batch.month,
                    amount: deduction,
                    deductedAt: new Date(),
                    payrollBatchId: batch._id,
                });
                if (loan.remainingBalance === 0) {
                    loan.status = "completed";
                }
                await loan.save();
            }
        }
    }

    batch.markModified("entries");
    await batch.save();
    return sanitizeBatch(batch, workspace?.currency || "PKR");
}

export async function emailPayslip(workspaceId, { batchId, employeeId, month }) {
    if (!employeeId) {
        throw ApiError.badRequest("Employee identifier is required to send payslip email.");
    }

    // 1. Find the appropriate batch
    let batch = null;
    if (batchId) {
        batch = await PayrollBatch.findOne({ _id: batchId, workspace: workspaceId });
    } else if (month) {
        const batches = await PayrollBatch.find({ workspace: workspaceId, month });
        if (batches && batches.length > 0) {
            const statusRank = { disbursed: 4, approved: 3, review: 2, draft: 1, cancelled: 0 };
            batches.sort((a, b) => (statusRank[b.status] || 0) - (statusRank[a.status] || 0));
            batch = batches[0];
        }
    }

    if (!batch) {
        throw ApiError.notFound("No payroll batch found for the specified period.");
    }

    // 2. Locate entry for employee
    const entry = (batch.entries || []).find((e) => {
        return (
            String(e.employeeId) === String(employeeId) ||
            String(e.employee) === String(employeeId) ||
            String(e._id) === String(employeeId)
        );
    });

    if (!entry) {
        throw ApiError.notFound(`Payslip entry not found for employee ${employeeId}.`);
    }

    // 3. Find employee document & linked user for email
    const emp = await Employee.findOne({
        $or: [{ _id: entry.employee }, { employeeId: entry.employeeId }],
        workspace: workspaceId,
    }).populate("linkedUser", "email fullName");

    const email =
        emp?.workEmail ||
        emp?.personalEmail ||
        emp?.loginEmail ||
        emp?.linkedUser?.email ||
        entry.employeeEmail ||
        "";

    if (!email) {
        throw ApiError.badRequest(`Employee ${entry.employeeName} does not have a registered email address.`);
    }

    // 4. Load workspace details for branding
    const workspace = await Workspace.findById(workspaceId).lean();
    const companyName = workspace?.companyName || "Organization";
    const currency = entry.currency || emp?.salaryCurrency || emp?.currency || workspace?.currency || "PKR";
    const payslipSettings = workspace?.payslipSettings || {};

    // Filter components according to payslipSettings
    const allComps = await SalaryComponent.find({ workspace: workspaceId }).lean();
    const compByCode = new Map(allComps.map((c) => [String(c.code || "").toUpperCase(), c]));
    const enforceVisibleIds =
        Boolean(payslipSettings.componentVisibilityConfigured) ||
        (Array.isArray(payslipSettings.visibleComponentIds) && payslipSettings.visibleComponentIds.length > 0);
    const visibleSet = new Set((payslipSettings.visibleComponentIds || []).map(String));

    const filterItems = (items) => {
        return (items || []).filter((item) => {
            const comp = compByCode.get(String(item.code || "").toUpperCase());
            if (!comp) return true;
            if (comp.showOnPayslip === false) return false;
            if (enforceVisibleIds && !visibleSet.has(String(comp._id))) return false;
            return true;
        });
    };

    // 5. Send payslip email
    const { sendPayslipEmail } = await import("../email/email.service.js");
    await sendPayslipEmail({
        to: email,
        userName: entry.employeeName || emp?.fullName || "Staff Member",
        employeeId: entry.employeeId,
        department: entry.department || emp?.department || "General",
        designation: entry.designation || emp?.designation || "Staff",
        companyName,
        period: batch.month,
        currency,
        workingDays: entry.workingDays || 30,
        presentDays: entry.presentDays || 30,
        unpaidDays: entry.unpaidDays || 0,
        basicSalary: entry.basicSalary || 0,
        earnings: filterItems(entry.earnings || []),
        deductions: filterItems(entry.deductions || []),
        grossSalary: entry.grossSalary || 0,
        totalDeductions: entry.totalDeductions || 0,
        netSalary: entry.netSalary || 0,
        paymentMethod: entry.paymentMethod === "cash" ? "Cash" : entry.paymentMethod === "cheque" ? "Cheque" : "Direct Bank Transfer",
        bankName: entry.bankAccountDetails?.bankName || "Not Configured",
        accountNumber: entry.bankAccountDetails?.accountNumber || "Not Configured",
        payslipSettings,
    });

    return {
        success: true,
        email,
        employeeName: entry.employeeName,
        period: batch.month,
        message: `Payslip email successfully sent to ${email}`,
    };
}

// -------------------------------------------------------------------
// Loans & Advances Service
// -------------------------------------------------------------------

export async function getLoans(workspaceId) {
    const [workspace, loans] = await Promise.all([
        Workspace.findById(workspaceId).select("currency").lean(),
        EmployeeLoan.find({ workspace: workspaceId })
            .populate("employee", "firstName lastName employeeId department designation avatar salaryCurrency currency")
            .sort({ createdAt: -1 })
            .lean(),
    ]);
    const wsCurrency = (workspace?.currency || "PKR").toUpperCase();
    return loans.map((loan) => ({
        ...loan,
        currency: String(
            loan.employee?.salaryCurrency || loan.employee?.currency || loan.currency || wsCurrency
        ).toUpperCase(),
    }));
}

export async function createLoan(workspaceId, data) {
    const [emp, workspace] = await Promise.all([
        Employee.findOne({ _id: data.employeeId, workspace: workspaceId }),
        Workspace.findById(workspaceId).select("currency").lean(),
    ]);
    if (!emp) throw ApiError.notFound("Employee not found.");

    const loanCurrency = (emp.salaryCurrency || emp.currency || data.currency || workspace?.currency || "PKR").toUpperCase();

    const loan = await EmployeeLoan.create({
        workspace: workspaceId,
        employee: emp._id,
        loanType: data.loanType || "salary_advance",
        title: data.title || "Salary Advance",
        principalAmount: data.principalAmount,
        totalDisbursed: data.principalAmount,
        totalRepaid: 0,
        remainingBalance: data.principalAmount,
        monthlyInstallment: data.monthlyInstallment,
        startMonth: data.startMonth || new Date().toISOString().slice(0, 7),
        currency: loanCurrency,
        status: "active",
        reason: data.reason || "",
    });

    await loan.populate("employee", "firstName lastName employeeId department designation avatar salaryCurrency currency");
    return loan;
}

export async function updateLoanStatus(workspaceId, loanId, status) {
    const [workspace, loan] = await Promise.all([
        Workspace.findById(workspaceId).select("currency").lean(),
        EmployeeLoan.findOneAndUpdate(
            { _id: loanId, workspace: workspaceId },
            { status },
            { new: true }
        )
            .populate("employee", "firstName lastName employeeId department designation avatar salaryCurrency currency")
            .lean(),
    ]);
    if (!loan) throw ApiError.notFound("Loan record not found.");
    const wsCurrency = (workspace?.currency || "PKR").toUpperCase();
    return {
        ...loan,
        currency: String(
            loan.employee?.salaryCurrency || loan.employee?.currency || loan.currency || wsCurrency
        ).toUpperCase(),
    };
}


// -------------------------------------------------------------------
// Payroll Settings Service
// -------------------------------------------------------------------

export async function getPayrollSettings(workspaceId) {
    let settings = await PayrollSettings.findOne({ workspace: workspaceId });
    if (!settings) {
        settings = await PayrollSettings.create({
            workspace: workspaceId,
            payFrequency: "monthly",
            cutoffDay: 25,
            disbursementDay: 28,
            workingDaysBasis: "fixed_30",
            customWorkingDays: 30,
            dailyWorkingHours: 8,
            overtimeMultiplier: 1.5,
            overtimeFormula: "(base / working_days / daily_hours) * multiplier",
            unpaidAbsenceMethod: "basic_30",
            customDailyAbsenceRate: 0,
            autoMarkLatePenalties: true,
            lateArrivalGraceMinutes: 15,
            lateArrivalGraceCount: 3,
            lateArrivalDeductionType: "fixed",
            lateArrivalDeductionAmount: 500,
            lateArrivalDeductionPercent: 25,
            defaultPaymentMethod: "bank_transfer",
            taxYear: "2026-2027",
            currency: "PKR",
            companyBankName: "",
            companyAccountTitle: "",
            companyIban: "",
            companyBranchCode: "",
            customRules: [],
        });
    }
    return settings;
}

export async function updatePayrollSettings(workspaceId, patch) {
    const settings = await PayrollSettings.findOneAndUpdate(
        { workspace: workspaceId },
        { $set: patch },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return settings;
}

// -------------------------------------------------------------------
// Salary Structures Service
// -------------------------------------------------------------------
const DEFAULT_STRUCTURES = [
    {
        name: "Executive & Director Grade",
        code: "EXEC-G1",
        gradeLevel: "Executive",
        description: "Senior executive package including high-tier HRA, medical, fuel allowances, and executive bonus.",
        baseSalaryRange: { min: 200000, max: 1000000 },
        isActive: true,
    },
    {
        name: "Senior Software Engineering Grade",
        code: "TECH-G2",
        gradeLevel: "Senior",
        description: "Technical professional package with HRA, tech allowance, medical, overtime eligibility, and retirement PF.",
        baseSalaryRange: { min: 100000, max: 350000 },
        isActive: true,
    },
    {
        name: "Operations & Sales Support Grade",
        code: "OPS-G3",
        gradeLevel: "Mid",
        description: "Standard operational package with conveyance, commission incentives, and statutory social security.",
        baseSalaryRange: { min: 60000, max: 150000 },
        isActive: true,
    },
    {
        name: "Standard General Grade",
        code: "GEN-G4",
        gradeLevel: "Standard",
        description: "General staff structure with standard base salary and standard statutory deductions.",
        baseSalaryRange: { min: 40000, max: 100000 },
        isActive: true,
    },
];

export async function getSalaryStructures(workspaceId) {
    let structures = await SalaryStructure.find({ workspace: workspaceId }).sort({ createdAt: 1 }).lean();
    if (!structures || structures.length === 0) {
        const seeded = DEFAULT_STRUCTURES.map((s) => ({ ...s, workspace: workspaceId }));
        structures = await SalaryStructure.insertMany(seeded);
        structures = structures.map((s) => (s.toObject ? s.toObject() : s));
    }

    // Count real employees assigned to each structure by payrollGroup or structure name
    const employees = await Employee.find({ workspace: workspaceId, employmentStatus: { $in: ["Active", "Probation", "On Leave"] } }).lean();
    const countByStructure = {};
    employees.forEach((emp) => {
        const group = emp.payrollGroup || "";
        if (group) {
            countByStructure[group] = (countByStructure[group] || 0) + 1;
        }
    });

    return structures.map((s) => ({
        ...s,
        id: s._id.toString(),
        assignedHeadcount: countByStructure[s.name] || countByStructure[s.code] || 0,
    }));
}

export async function createSalaryStructure(workspaceId, data) {
    const code = (data.code || "STRUCT").toUpperCase().trim();
    const existing = await SalaryStructure.findOne({ workspace: workspaceId, code });
    if (existing) {
        throw ApiError.badRequest(`Salary structure code ${code} already exists.`);
    }
    const created = await SalaryStructure.create({
        ...data,
        code,
        workspace: workspaceId,
    });
    return created;
}

export async function updateSalaryStructure(workspaceId, id, data) {
    const updated = await SalaryStructure.findOneAndUpdate(
        { _id: id, workspace: workspaceId },
        { $set: data },
        { new: true }
    );
    if (!updated) {
        throw ApiError.notFound("Salary structure not found.");
    }
    return updated;
}

export async function deleteSalaryStructure(workspaceId, id) {
    const deleted = await SalaryStructure.findOneAndDelete({ _id: id, workspace: workspaceId });
    if (!deleted) {
        throw ApiError.notFound("Salary structure not found.");
    }
    return { success: true, id };
}

// -------------------------------------------------------------------
// Real-time Attendance & Leave Adjustments Query Service
// -------------------------------------------------------------------
export async function getAttendanceAdjustments(workspaceId, month) {
    const [settings, workspace] = await Promise.all([
        getPayrollSettings(workspaceId),
        Workspace.findById(workspaceId).lean(),
    ]);
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const [year, mStr] = month.split("-").map(Number);
    const mm = String(mStr).padStart(2, "0");
    const daysInMonth = new Date(year, mStr, 0).getDate();
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const isCurrentOngoingMonth = month === todayIso.slice(0, 7);
    const elapsedDays = isCurrentOngoingMonth ? Math.min(daysInMonth, today.getDate()) : daysInMonth;

    const fromIso = `${year}-${mm}-01`;
    const toIso = `${year}-${mm}-${String(elapsedDays).padStart(2, "0")}`;

    let effectiveWorkingDays = elapsedDays;
    if (!isCurrentOngoingMonth) {
        if (settings.workingDaysBasis === "fixed_30") effectiveWorkingDays = 30;
        else if (settings.workingDaysBasis === "fixed_26") effectiveWorkingDays = 26;
        else if (settings.workingDaysBasis === "custom") effectiveWorkingDays = settings.customWorkingDays || 30;
        else effectiveWorkingDays = daysInMonth;
    }

    const monthBaseDays = settings.workingDaysBasis === "fixed_30" ? 30 : daysInMonth;

    // Load active employees
    const employees = await Employee.find({
        workspace: workspaceId,
        employmentStatus: { $in: ["Active", "Probation", "On Leave"] },
    }).sort({ firstName: 1, lastName: 1 }).lean();

    // Load any existing batch for this month
    const existingBatch = await PayrollBatch.findOne({ workspace: workspaceId, month }).lean();

    const adjustments = [];

    for (const emp of employees) {
        // Resolve employee joining date
        let empJoiningIso = fromIso;
        if (emp.joiningDate) {
            empJoiningIso = new Date(emp.joiningDate).toISOString().slice(0, 10);
        } else if (emp.createdAt) {
            empJoiningIso = new Date(emp.createdAt).toISOString().slice(0, 10);
        }

        // Calculate individual tenure-based working days for this employee
        let empWorkingDays = effectiveWorkingDays;
        let isNewHireThisMonth = false;

        if (empJoiningIso.startsWith(month)) {
            const joinDay = parseInt(empJoiningIso.split("-")[2], 10);
            isNewHireThisMonth = true;
            if (isCurrentOngoingMonth) {
                if (joinDay > elapsedDays) {
                    empWorkingDays = 0;
                } else {
                    empWorkingDays = Math.max(1, elapsedDays - joinDay + 1);
                }
            } else {
                if (joinDay > 1) {
                    empWorkingDays = Math.max(1, monthBaseDays - joinDay);
                } else {
                    empWorkingDays = effectiveWorkingDays;
                }
            }
        } else if (empJoiningIso > toIso) {
            empWorkingDays = 0;
            isNewHireThisMonth = true;
        }

        // Calculate dynamic real-time attendance and leaves for this period
        const breakdown = await calculateEmployeeLeaveAndAbsenceBreakdown(
            workspace,
            emp._id,
            fromIso,
            toIso,
            empWorkingDays,
            emp
        );

        // Check if an existing batch entry has an explicit manual override
        const batchEntry = existingBatch?.entries?.find(
            (e) => String(e.employee) === String(emp._id) || String(e.employeeId) === String(emp.employeeId)
        );

        const isManualOverride = Boolean(
            batchEntry && batchEntry.isManualAdjustment
        );

        let finalUnpaid = breakdown.unpaidDays;
        let finalPresent = breakdown.presentDays;
        let finalOt = 0;

        // Check actual overtime hours from attendance punch records
        const attRecords = await AttendanceRecord.find({
            workspace: workspace._id,
            employee: emp._id,
            date: { $gte: fromIso, $lte: toIso },
        }).select("date hoursWorked requiredHours").lean();

        for (const att of attRecords) {
            if (att.date && att.date < empJoiningIso) continue;
            const reqH = att.requiredHours || 8;
            if (att.hoursWorked && att.hoursWorked > reqH) {
                finalOt += Math.round((att.hoursWorked - reqH) * 10) / 10;
            }
        }

        if (isManualOverride && batchEntry) {
            finalUnpaid = Number(batchEntry.unpaidDays) ?? breakdown.unpaidDays;
            finalPresent = Number(batchEntry.presentDays) ?? breakdown.presentDays;
            finalOt = Number(batchEntry.overtimeHours) ?? finalOt;
            if (batchEntry.workingDays) {
                empWorkingDays = Number(batchEntry.workingDays);
            }
        }

        const fullBasic = Number(emp.salaryAmount || emp.basicSalary || 75000);
        const periodBasic = Math.round((fullBasic / monthBaseDays) * empWorkingDays);
        const empCurrency = emp.salaryCurrency || emp.currency || workspace.currency || "PKR";

        adjustments.push({
            id: emp._id.toString(),
            employeeId: emp.employeeId || "EMP-001",
            employeeName: `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.preferredName || "Staff Member",
            employeeAvatar: emp.avatar || "",
            department: emp.department || "General",
            designation: emp.designation || "Employee",
            basicSalary: periodBasic,
            fullBasicSalary: fullBasic,
            workingDays: empWorkingDays,
            presentDays: finalPresent,
            unpaidDays: finalUnpaid,
            overtimeHours: finalOt,
            currency: empCurrency,
            isManualOverride,
            realTimeUnpaidDays: breakdown.unpaidDays,
            realTimePresentDays: breakdown.presentDays,
            isNewHireThisMonth,
            joiningDate: empJoiningIso,
            unexcusedAbsenceDays: breakdown.unexcusedAbsenceDays,
        });
    }

    adjustments.sort((a, b) => a.employeeName.localeCompare(b.employeeName));

    return {
        adjustments,
        month,
        workingDays: effectiveWorkingDays,
    };
}
