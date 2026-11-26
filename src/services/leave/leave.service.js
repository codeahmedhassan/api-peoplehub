// src/services/leave/leave.service.js
import { LeaveRequest } from "../../model/leave/leave.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { User } from "../../model/auth/auth.model.js";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { createNotification } from "../notification/notification.service.js";
import {
    sendEmployeeLeaveStatusEmail,
    sendTeamLeaveUpdateEmail,
    sendNewLeaveRequestEmail,
} from "../email/email.service.js";
import { ApiError } from "../../utils/ApiError.js";
import { getDateInTimezone } from "../../utils/timezone.js";
import { escapeRegex as escapeRegexInput } from "../../utils/security.js";
import { buildManagerDirectReportsMongoFilter, isEmployeeDirectReport } from "../employee/employee.service.js";
import {
    DEFAULT_LEAVE_TYPES,
    DEFAULT_TIMEOFF_TYPES,
    LEAVE_CATEGORIES,
    WEEKEND_EXPIRY_OPTIONS,
} from "../../constants/leave.js";

// Standard annual allowances (backward compatibility)
export const DEFAULT_LEAVE_ALLOWANCES = {
    annual: 14,
    casual: 10,
    sick: 8,
    unpaid: 0,
    maternity: 90,
    paternity: 10,
    special: 5,
};

/**
 * Determine caller's effective role and linked employee document.
 */
export async function getCallerContext(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User not found");

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === userId.toString());
    const roleStr = (user.role || "").toLowerCase();
    const systemRoleStr = (user.systemRole || "").toLowerCase();

    // Check linked employee
    const callerEmployee = await Employee.findOne({
        workspace: workspace._id,
        $or: [
            { linkedUser: userId },
            { loginEmail: user.email?.toLowerCase() },
            { personalEmail: user.email?.toLowerCase() },
        ],
    }).lean();

    const isCEO = Boolean(
        isOwner ||
        roleStr === "founder / ceo" ||
        roleStr === "founder" ||
        roleStr === "ceo" ||
        roleStr === "administrator" ||
        roleStr === "admin" ||
        systemRoleStr === "admin"
    );

    const isHR = Boolean(
        !isCEO && (
            roleStr === "hr" ||
            systemRoleStr === "hr" ||
            callerEmployee?.systemRole === "HR"
        )
    );

    const isManager = Boolean(
        !isCEO && !isHR && (
            roleStr === "manager" ||
            systemRoleStr === "manager" ||
            callerEmployee?.systemRole === "Manager" ||
            /manager|lead|supervisor|head/i.test(callerEmployee?.designation || "")
        )
    );

    const isViewer = Boolean(!isCEO && !isHR && !isManager && (roleStr === "viewer" || systemRoleStr === "viewer"));

    let effectiveRole = "EMPLOYEE";
    if (isCEO) effectiveRole = "CEO";
    else if (isHR) effectiveRole = "HR";
    else if (isManager) effectiveRole = "MANAGER";
    else if (isViewer) effectiveRole = "VIEWER";

    return {
        workspace,
        user,
        callerEmployee,
        effectiveRole,
        isCEO,
        isHR,
        isManager,
        isViewer,
    };
}

/**
 * Calculate dates count inclusive (YYYY-MM-DD strings).
 * Half Day = 0.5, Short Day = 0.25 (2 half days = 1 full day; 4 short days = 1 full day).
 */
export function calculateDaysBetween(startDateStr, endDateStr, isHalfDay = false, isShortDay = false) {
    if (isShortDay) return 0.25;
    if (isHalfDay) return 0.5;
    const start = new Date(startDateStr);
    const end = new Date(endDateStr);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return 1;
    const diffMs = end.getTime() - start.getTime();
    if (diffMs < 0) return 1;
    const days = Math.round(diffMs / (1000 * 60 * 60 * 24)) + 1;
    return days > 0 ? days : 1;
}

/**
 * Return detailed weekend earned leaves for an employee.
 * When noLeavePolicy is true and weekendWorkEarnsLeave is true,
 * every worked weekend day accrues leave with its own separate expiry date.
 */
export async function getEmployeeWeekendLeaveAccruals(workspace, employeeId) {
    const weekendWorkEarnsLeave = Boolean(workspace?.attendance?.weekendWorkEarnsLeave);
    const noLeavePolicy = Boolean(workspace?.attendance?.noLeavePolicy);

    if (!weekendWorkEarnsLeave && !noLeavePolicy) {
        return { totalEarned: 0, totalUsed: 0, totalExpired: 0, activeBalance: 0, accruals: [] };
    }

    const weekendDays = Array.isArray(workspace.attendance?.weekendDays) && workspace.attendance.weekendDays.length > 0
        ? workspace.attendance.weekendDays
        : [0];

    const expiryStr = (workspace.attendance?.weekendLeaveExpiry || "never").toLowerCase().trim();
    let expiryDays = null;
    if (expiryStr && expiryStr !== "never") {
        const matchDays = expiryStr.match(/^(\d+)_day(s)?$/);
        const matchWeeks = expiryStr.match(/^(\d+)_week(s)?$/);
        const matchMonths = expiryStr.match(/^(\d+)_month(s)?$/);
        const matchYears = expiryStr.match(/^(\d+)_year(s)?$/);

        if (matchDays) expiryDays = parseInt(matchDays[1], 10);
        else if (matchWeeks) expiryDays = parseInt(matchWeeks[1], 10) * 7;
        else if (matchMonths) expiryDays = parseInt(matchMonths[1], 10) * 30;
        else if (matchYears) expiryDays = parseInt(matchYears[1], 10) * 365;
        else expiryDays = 60; // standard default 60 days
    }

    const emp = await Employee.findById(employeeId).select("workingHours").lean();
    const reqHours = Number(emp?.workingHours) || 8;

    const records = await AttendanceRecord.find({
        workspace: workspace._id,
        employee: employeeId,
        status: { $in: ["present", "late", "remote", "half-day"] },
    })
        .select("date status checkIn checkOut hoursWorked requiredHours")
        .sort({ date: 1 })
        .lean();

    const todayStr = new Date().toISOString().slice(0, 10);
    const todayMs = new Date(todayStr + "T00:00:00Z").getTime();
    const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    const rawAccruals = [];
    for (const rec of records) {
        if (!rec.date) continue;
        const [y, m, d] = rec.date.split("-").map(Number);
        const dObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        const dayOfWeek = dObj.getUTCDay();
        if (weekendDays.includes(dayOfWeek)) {
            const daysEarned = rec.status === "half-day" ? 0.5 : 1.0;
            let expiresAt = null;
            let isExpired = false;
            let daysLeft = null;

            if (expiryDays !== null) {
                const expDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
                expDate.setUTCDate(expDate.getUTCDate() + expiryDays);
                expiresAt = expDate.toISOString().slice(0, 10);
                isExpired = expiresAt < todayStr;
                const expMs = expDate.getTime();
                daysLeft = isExpired ? 0 : Math.max(0, Math.ceil((expMs - todayMs) / (1000 * 60 * 60 * 24)));
            }

            // Authoritative calculation of hours worked
            let hoursWorked = 0;
            if (rec.hoursWorked !== undefined && Number(rec.hoursWorked) > 0) {
                hoursWorked = Number(rec.hoursWorked);
            } else if (rec.checkIn && rec.checkOut) {
                const cin = new Date(rec.checkIn).getTime();
                const cout = new Date(rec.checkOut).getTime();
                if (!isNaN(cin) && !isNaN(cout) && cout > cin) {
                    hoursWorked = Math.round(((cout - cin) / (1000 * 60 * 60)) * 10) / 10;
                }
            }
            if (hoursWorked <= 0) {
                if (rec.status === "half-day") {
                    hoursWorked = Math.round((reqHours / 2) * 10) / 10;
                } else if (rec.status === "late") {
                    hoursWorked = Math.max(0, reqHours - 1);
                } else {
                    hoursWorked = reqHours;
                }
            }

            rawAccruals.push({
                date: rec.date,
                dateEarned: rec.date,
                dayOfWeek: DAY_NAMES[dayOfWeek],
                dayName: DAY_NAMES[dayOfWeek],
                status: rec.status,
                hoursWorked: Math.round(hoursWorked * 10) / 10,
                earnedLeaveDays: daysEarned,
                daysEarned,
                expiresAt,
                isExpired,
                used: false,
                isUsed: false,
                usedAmount: 0,
                daysLeft,
            });
        }
    }

    // Get all approved leaves taken by this employee
    const approvedLeaves = await LeaveRequest.find({
        workspace: workspace._id,
        employee: employeeId,
        status: "approved",
    }).select("totalDays appliedAt startDate").lean();

    const totalLeaveDaysTaken = approvedLeaves.reduce((sum, r) => sum + (Number(r.totalDays) || 0), 0);
    const totalEarned = rawAccruals.reduce((sum, a) => sum + a.daysEarned, 0);

    // FIFO allocation: deduct used leaves from unexpired accruals first (oldest first)
    let remainingToDeduct = totalLeaveDaysTaken;
    let totalUsed = 0;
    let totalExpired = 0;

    for (const item of rawAccruals) {
        if (remainingToDeduct > 0) {
            const take = Math.min(item.daysEarned, remainingToDeduct);
            item.usedAmount = take;
            item.used = item.usedAmount >= item.daysEarned;
            item.isUsed = item.used;
            remainingToDeduct -= take;
            totalUsed += take;
        } else if (item.isExpired) {
            totalExpired += item.daysEarned;
        }
    }

    const activeBalance = rawAccruals
        .filter((a) => !a.isExpired && !a.used)
        .reduce((sum, a) => sum + (a.daysEarned - a.usedAmount), 0);

    return {
        totalEarned,
        totalUsed,
        totalExpired,
        activeBalance: Math.max(0, activeBalance),
        accruals: rawAccruals.slice().reverse(), // newest first
    };
}

/**
 * Calculate earned weekend leaves for an employee based on weekend work.
 */
export async function calculateEarnedWeekendLeaves(workspace, employeeId) {
    const res = await getEmployeeWeekendLeaveAccruals(workspace, employeeId);
    return res.activeBalance;
}

/**
 * Resolve all configured leave types for a workspace.
 */
export function resolveWorkspaceLeaveTypes(workspace) {
    const customTypes = Array.isArray(workspace?.attendance?.customLeaveTypes)
        ? workspace.attendance.customLeaveTypes
        : [];

    let configured = Array.isArray(workspace?.attendance?.leaveTypesConfig)
        ? workspace.attendance.leaveTypesConfig
        : DEFAULT_LEAVE_TYPES;

    const existingKeys = new Set(configured.map((t) => t.key));
    const merged = [...configured];
    for (const c of customTypes) {
        if (!existingKeys.has(c.key)) {
            merged.push({
                ...c,
                isCustom: true,
            });
        }
    }
    return merged;
}

/**
 * Resolve all configured timeoff types for a workspace.
 */
export function resolveWorkspaceTimeoffTypes(workspace) {
    if (Array.isArray(workspace?.attendance?.timeoffTypesConfig)) {
        return workspace.attendance.timeoffTypesConfig;
    }
    return DEFAULT_TIMEOFF_TYPES;
}

/**
 * Comprehensive leave balances calculation for an employee.
 */
export async function calculateAllLeaveBalances(workspace, employeeId, leaveRecords = null) {
    const attConfig = workspace.attendance || {};
    const noLeavePolicy = Boolean(attConfig.noLeavePolicy);
    const weekendWorkEarnsLeave = Boolean(attConfig.weekendWorkEarnsLeave);
    const leavesPerEmployee = typeof attConfig.leavesPerEmployee === "number" ? attConfig.leavesPerEmployee : 14;
    const timeoffPerEmployee = typeof attConfig.timeoffPerEmployee === "number" ? attConfig.timeoffPerEmployee : 10;
    const leavePolicyMode = attConfig.leavePolicyMode || "detailed";

    // 1. Weekend earned leave accruals
    let weekendAccruals = { totalEarned: 0, totalUsed: 0, totalExpired: 0, activeBalance: 0, accruals: [] };
    if (noLeavePolicy || weekendWorkEarnsLeave) {
        weekendAccruals = await getEmployeeWeekendLeaveAccruals(workspace, employeeId);
    }

    // 2. Fetch approved leaves if not provided
    let approvedLeaves = leaveRecords;
    if (!approvedLeaves) {
        const currentYearStr = new Date().getFullYear().toString();
        approvedLeaves = await LeaveRequest.find({
            workspace: workspace._id,
            employee: employeeId,
            status: "approved",
            startDate: { $gte: `${currentYearStr}-01-01` },
        }).lean();
    } else {
        approvedLeaves = approvedLeaves.filter((r) => r.status === "approved");
    }

    // 3. Count used days by leave type
    const usedCounts = {};
    for (const req of approvedLeaves) {
        const type = req.leaveType || req.type || "annual";
        usedCounts[type] = (usedCounts[type] || 0) + (Number(req.totalDays) || 0);
    }

    // 4. Resolve configured leave types
    const configuredTypes = resolveWorkspaceLeaveTypes(workspace);
    const enabledTypes = configuredTypes.filter((t) => t.enabled !== false);

    const balances = {};

    if (noLeavePolicy && weekendWorkEarnsLeave) {
        balances.weekend_earned = {
            key: "weekend_earned",
            name: "Earned Weekend Leave",
            category: "company_specific",
            allowance: weekendAccruals.totalEarned,
            total: weekendAccruals.totalEarned,
            used: weekendAccruals.totalUsed,
            remaining: weekendAccruals.activeBalance,
            expired: weekendAccruals.totalExpired,
            isWeekendCompensatory: true,
            deductionRate: 1.0,
            accruals: weekendAccruals.accruals,
        };
        balances.annual = balances.weekend_earned;
        balances.compensatory = balances.weekend_earned;
    }

    for (const t of enabledTypes) {
        if (!balances[t.key]) {
            let allowance = t.defaultDays;
            if (t.key === "annual" && leavePolicyMode === "unified") {
                allowance = leavesPerEmployee;
            }
            const used = usedCounts[t.key] || 0;
            const remaining = Math.max(0, allowance - used);

            balances[t.key] = {
                key: t.key,
                name: t.name,
                category: t.category,
                allowance,
                total: allowance,
                used,
                remaining,
                isPaid: t.isPaid,
                deductionRate: t.deductionRate || 1.0,
                expiryRule: t.expiryRule,
                isCustom: Boolean(t.isCustom),
            };
        }
    }

    if (!balances.unpaid) {
        balances.unpaid = {
            key: "unpaid",
            name: "Unpaid Leave",
            category: "general",
            allowance: 0,
            total: 0,
            used: usedCounts.unpaid || 0,
            remaining: 0,
            deductionRate: 1.0,
        };
    }

    // Timeoff balance
    const timeoffUsed = approvedLeaves
        .filter((r) => r.category === "timeoff")
        .reduce((sum, r) => sum + (Number(r.totalDays) || 1), 0);

    balances.timeoff = {
        key: "timeoff",
        name: "Time-Off / Short Permissions",
        category: "timeoff",
        allowance: noLeavePolicy ? 0 : timeoffPerEmployee,
        total: noLeavePolicy ? 0 : timeoffPerEmployee,
        used: timeoffUsed,
        remaining: Math.max(0, (noLeavePolicy ? 0 : timeoffPerEmployee) - timeoffUsed),
    };

    return {
        balances,
        weekendAccruals,
        noLeavePolicy,
        weekendWorkEarnsLeave,
        leavePolicyMode,
    };
}

/**
 * Return team members working under a manager.
 */
export async function getTeamMembersForManager(userId) {
    const { workspace, callerEmployee, user, isCEO, isHR } = await getCallerContext(userId);

    // CEO and HR can manage any employee
    if (isCEO || isHR) {
        const allEmps = await Employee.find({ workspace: workspace._id })
            .select("_id employeeId firstName lastName designation department reportingManager avatar loginEmail personalEmail systemRole")
            .sort({ firstName: 1 })
            .lean();
        return allEmps.map((e) => ({
            id: e._id.toString(),
            employeeId: e.employeeId,
            name: `${e.firstName} ${e.lastName}`.trim(),
            designation: e.designation,
            department: e.department,
            reportingManager: e.reportingManager,
            avatar: e.avatar,
            email: e.loginEmail || e.personalEmail,
            hasSystemLogin: Boolean(e.loginEmail),
        }));
    }

    if (!callerEmployee) {
        return [];
    }

    const filter = buildManagerDirectReportsMongoFilter(workspace._id, user, callerEmployee, { includeSelf: false });
    filter._id = { $ne: callerEmployee._id };

    const directReports = await Employee.find(filter)
        .select("_id employeeId firstName lastName designation department reportingManager avatar loginEmail personalEmail systemRole")
        .sort({ firstName: 1 })
        .lean();

    return directReports.map((e) => ({
        id: e._id.toString(),
        employeeId: e.employeeId,
        name: `${e.firstName} ${e.lastName}`.trim(),
        designation: e.designation,
        department: e.department,
        reportingManager: e.reportingManager,
        avatar: e.avatar,
        email: e.loginEmail || e.personalEmail,
        hasSystemLogin: Boolean(e.loginEmail),
    }));
}

function escapeRegex(text) {
    return String(text || "").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

/**
 * Build MongoDB match clauses for a manager's direct reports and submitted team leaves.
 * Ensures leaves for direct reports (including designations in parens like "Name (Title)")
 * and leaves applied on behalf of employees are fully visible to the manager.
 */
async function getManagerTeamMatchClauses(workspaceId, user, callerEmployee) {
    const rawIdentifiers = [
        callerEmployee?.employeeId,
        callerEmployee ? `${callerEmployee.firstName || ""} ${callerEmployee.lastName || ""}`.trim() : null,
        user?.fullName ? user.fullName.trim() : null,
        callerEmployee?.firstName,
    ].filter(Boolean);

    const regexArray = [];
    for (const id of rawIdentifiers) {
        if (!id || id.length < 2) continue;
        const escaped = escapeRegex(id);
        regexArray.push(new RegExp(`(^|\\b|\\s|-)${escaped}(\\b|\\s|-|\\(|$)`, "i"));
    }

    // Direct report employees from Employee collection (using authoritative direct report filter)
    let directReportIds = [];
    let directReportCodes = [];
    try {
        const directReportEmployees = await Employee.find(
            buildManagerDirectReportsMongoFilter(workspaceId, user, callerEmployee, { includeSelf: false })
        )
            .select("_id employeeId")
            .lean();

        directReportIds = directReportEmployees.map((e) => e._id);
        directReportCodes = directReportEmployees.map((e) => e.employeeId).filter(Boolean);
    } catch {
        // best effort fallback
    }

    return [
        ...(directReportIds.length > 0 ? [{ employee: { $in: directReportIds } }] : []),
        ...(directReportCodes.length > 0 ? [{ employeeCode: { $in: directReportCodes } }] : []),
        { reportingManager: { $in: rawIdentifiers } },
        { reportingManager: { $in: regexArray } },
        { appliedBy: user._id },
        ...(callerEmployee ? [{ appliedByManager: callerEmployee._id }] : []),
    ];
}

/**
 * Get high-level leave summary and personal balances.
 */
export async function getLeaveSummary(userId) {
    const { workspace, user, callerEmployee, effectiveRole, isCEO, isHR, isManager } =
        await getCallerContext(userId);

    const todayStr = new Date().toISOString().slice(0, 10);
    const currentYearStr = new Date().getFullYear().toString();
    const monthStartStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-01`;

    // 1. Employees on leave today
    let todayOnLeaveCount = 0;
    if (isManager && callerEmployee) {
        const teamMatchClauses = await getManagerTeamMatchClauses(workspace._id, user, callerEmployee);
        todayOnLeaveCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            $or: teamMatchClauses,
            status: "approved",
            startDate: { $lte: todayStr },
            endDate: { $gte: todayStr },
        });
    } else {
        todayOnLeaveCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            status: "approved",
            startDate: { $lte: todayStr },
            endDate: { $gte: todayStr },
        });
    }

    // 2. Pending requests count (scoped by role)
    let pendingRequestsCount = 0;
    let pendingManagerCount = 0;
    let pendingHrCount = 0;
    let pendingCeoCount = 0;

    if (isCEO) {
        // CEO sees pending requests from Managers & HRs
        pendingCeoCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            $or: [
                { appliedByRole: { $in: ["MANAGER", "HR"] }, appliedOnBehalf: { $ne: true }, status: { $in: ["pending", "pending_ceo", "pending_hr"] } },
                { status: "pending_ceo" },
                { stage: "ceo_review" },
            ],
        });
        pendingRequestsCount = pendingCeoCount;
    } else if (isHR) {
        // HR sees requests forwarded by managers or submitted to HR (including manager's own leaves)
        // EXCLUDING HR's own leaves!
        pendingHrCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            status: "pending_hr",
            stage: { $ne: "ceo_review" },
            appliedByRole: { $ne: "HR" },
        });
        pendingRequestsCount = pendingHrCount;
    } else if (isManager && callerEmployee) {
        const teamMatchClauses = await getManagerTeamMatchClauses(workspace._id, user, callerEmployee);
        pendingManagerCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            $or: teamMatchClauses,
            status: "pending_manager",
        });
        pendingRequestsCount = pendingManagerCount;
    } else if (callerEmployee) {
        pendingRequestsCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            employee: callerEmployee._id,
            status: { $in: ["pending", "pending_manager", "pending_hr", "pending_ceo"] },
        });
    }

    // 3. Approved this month
    let approvedThisMonthCount = 0;
    if (isManager && callerEmployee) {
        const teamMatchClauses = await getManagerTeamMatchClauses(workspace._id, user, callerEmployee);
        approvedThisMonthCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            $or: teamMatchClauses,
            status: "approved",
            startDate: { $gte: monthStartStr },
        });
    } else {
        approvedThisMonthCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            status: "approved",
            startDate: { $gte: monthStartStr },
        });
    }

    // 4. Rejected count (total or team/personal)
    let rejectedCount = 0;
    if (isCEO || isHR) {
        rejectedCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            status: "rejected",
        });
    } else if (isManager && callerEmployee) {
        const teamMatchClauses = await getManagerTeamMatchClauses(workspace._id, user, callerEmployee);
        rejectedCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            $or: [
                ...teamMatchClauses,
                { employee: callerEmployee._id },
            ],
            status: "rejected",
        });
    } else if (callerEmployee) {
        rejectedCount = await LeaveRequest.countDocuments({
            workspace: workspace._id,
            employee: callerEmployee._id,
            status: "rejected",
        });
    }

    // 5. Calculate caller's personal balances & dynamic leave policy allowances
    const attConfig = workspace.attendance || {};
    const noLeavePolicy = Boolean(attConfig.noLeavePolicy);
    const weekendWorkEarnsLeave = Boolean(attConfig.weekendWorkEarnsLeave);
    const leavesPerEmployee = typeof attConfig.leavesPerEmployee === "number" ? attConfig.leavesPerEmployee : DEFAULT_LEAVE_ALLOWANCES.annual;
    const timeoffPerEmployee = typeof attConfig.timeoffPerEmployee === "number" ? attConfig.timeoffPerEmployee : 10;

    const balanceResult = callerEmployee
        ? await calculateAllLeaveBalances(workspace, callerEmployee._id)
        : { balances: {}, weekendAccruals: { totalEarned: 0, totalUsed: 0, totalExpired: 0, activeBalance: 0, accruals: [] } };

    const myBalances = balanceResult.balances;
    const weekendLeaveAccruals = balanceResult.weekendAccruals;
    const leaveTypes = resolveWorkspaceLeaveTypes(workspace);
    const timeoffTypes = resolveWorkspaceTimeoffTypes(workspace);

    return {
        userRole: effectiveRole,
        isCEO,
        isHR,
        isManager,
        todayOnLeave: todayOnLeaveCount,
        pendingRequests: pendingRequestsCount,
        pendingManagerCount,
        pendingHrCount,
        pendingCeoCount,
        approvedThisMonth: approvedThisMonthCount,
        rejectedCount,
        leavePolicy: {
            noLeavePolicy,
            weekendWorkEarnsLeave,
            weekendLeaveExpiry: attConfig.weekendLeaveExpiry || "never",
            leavesPerEmployee,
            timeoffPerEmployee,
            earnedWeekendLeaves: weekendLeaveAccruals.activeBalance,
            leavePolicyMode: attConfig.leavePolicyMode || "detailed",
        },
        myBalances,
        weekendLeaveAccruals,
        leaveTypes,
        timeoffTypes,
        categories: LEAVE_CATEGORIES,
        employeeProfile: callerEmployee
            ? {
                  id: callerEmployee._id.toString(),
                  employeeId: callerEmployee.employeeId,
                  name: `${callerEmployee.firstName} ${callerEmployee.lastName}`.trim(),
                  department: callerEmployee.department,
                  designation: callerEmployee.designation,
                  reportingManager: callerEmployee.reportingManager,
              }
            : null,
    };
}

/**
 * List leave requests with role-based scoping and filtering.
 */
export async function listLeaveRequests(userId, query = {}) {
    const { workspace, user, callerEmployee, effectiveRole, isCEO, isHR, isManager } =
        await getCallerContext(userId);

    const filter = { workspace: workspace._id };
    const scope = String(query.scope || "auto").toLowerCase();

    // -------------------------------------------------------------
    // Role-based visibility
    // -------------------------------------------------------------
    if (effectiveRole === "EMPLOYEE") {
        if (!callerEmployee) {
            return { requests: [], total: 0 };
        }
        filter.employee = callerEmployee._id;
    } else if (effectiveRole === "MANAGER") {
        if (scope === "my") {
            filter.employee = callerEmployee ? callerEmployee._id : null;
        } else {
            const teamMatchClauses = await getManagerTeamMatchClauses(workspace._id, user, callerEmployee);
            if (scope === "pending_verification") {
                filter.$and = filter.$and || [];
                filter.$and.push(
                    { $or: teamMatchClauses },
                    { status: "pending_manager" }
                );
            } else if (scope === "forwarded_to_hr") {
                filter.$and = filter.$and || [];
                filter.$and.push(
                    { $or: teamMatchClauses },
                    { status: "pending_hr" }
                );
            } else {
                // Team requests: includes all team requests + manager's own leaves
                filter.$or = [
                    ...teamMatchClauses,
                    ...(callerEmployee ? [{ employee: callerEmployee._id }] : []),
                ];
            }
        }
    } else if (isCEO) {
        if (scope === "my" && callerEmployee) {
            filter.employee = callerEmployee._id;
        } else if (scope === "manager_hr") {
            // "CEO will receive all the leaves and time-off from the managers and the HRs"
            filter.$or = [
                { appliedByRole: { $in: ["MANAGER", "HR"] }, appliedOnBehalf: { $ne: true } },
                { stage: "ceo_review" },
                { status: "pending_ceo" },
            ];
        }
        // scope === "all" or general: see all
    } else if (isHR) {
        if (scope === "my" && callerEmployee) {
            filter.employee = callerEmployee._id;
        } else if (scope === "pending_review") {
            // HR sees manager submissions, forwarded employee leaves, and manager's own leaves
            // BUT HR cannot review HR's own leaves!
            filter.status = "pending_hr";
            filter.stage = { $ne: "ceo_review" };
            filter.appliedByRole = { $ne: "HR" };
        }
        // For any scope other than HR's own personal requests, exclude HR leaves waiting for CEO review
        if (scope !== "my") {
            filter.$and = filter.$and || [];
            filter.$and.push({
                status: { $ne: "pending_ceo" },
                stage: { $ne: "ceo_review" },
            });
        }
    }

    // -------------------------------------------------------------
    // Status filters
    // -------------------------------------------------------------
    if (query.section === "approved" || query.status === "approved") {
        filter.status = "approved";
    } else if (query.section === "rejected" || query.status === "rejected") {
        filter.status = "rejected";
    } else if (query.section === "pending") {
        filter.status = { $in: ["pending", "pending_manager", "pending_hr", "pending_ceo"] };
    } else if (query.status && query.status !== "all") {
        filter.status = query.status;
    }

    if (query.category && query.category !== "all") {
        filter.category = query.category;
    }
    if (query.leaveType && query.leaveType !== "all") {
        filter.leaveType = query.leaveType;
    }
    if (query.department && query.department !== "all") {
        filter.department = new RegExp(escapeRegexInput(String(query.department).trim()), "i");
    }
    if (query.month) {
        filter.startDate = { $regex: new RegExp(`^${escapeRegexInput(query.month)}`) };
    }
    if (query.search) {
        const s = escapeRegexInput(String(query.search).trim());
        filter.$and = filter.$and || [];
        filter.$and.push({
            $or: [
                { employeeName: new RegExp(s, "i") },
                { employeeCode: new RegExp(s, "i") },
                { department: new RegExp(s, "i") },
                { reason: new RegExp(s, "i") },
                { reportingManager: new RegExp(s, "i") },
                { appliedByName: new RegExp(s, "i") },
            ],
        });
    }

    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 40));
    const skip = (page - 1) * limit;

    const [requests, total] = await Promise.all([
        LeaveRequest.find(filter)
            .populate("employee", "avatar")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        LeaveRequest.countDocuments(filter),
    ]);

    return {
        requests: requests.map((r) => {
            const empIdStr = r.employee && typeof r.employee === "object"
                ? (r.employee._id ? r.employee._id.toString() : "")
                : (r.employee ? r.employee.toString() : "");
            const empAvatar = r.employee && typeof r.employee === "object" ? (r.employee.avatar || "") : "";
            return {
                id: r._id.toString(),
                category: r.category || "leave",
                employeeId: empIdStr,
                employee: empIdStr,
                employeeAvatar: empAvatar,
                user: r.user ? r.user.toString() : "",
                appliedBy: r.appliedBy ? r.appliedBy.toString() : "",
                employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            department: r.department,
            designation: r.designation,
            reportingManager: r.reportingManager,
            leaveType: r.leaveType,
            startDate: r.startDate,
            endDate: r.endDate,
            totalDays: r.totalDays,
            isHalfDay: Boolean(r.isHalfDay),
            halfDayPeriod: r.halfDayPeriod,
            reason: r.reason,
            emergencyContact: r.emergencyContact,
            appliedByRole: r.appliedByRole || "EMPLOYEE",
            appliedByName: r.appliedByName || "",
            appliedOnBehalf: Boolean(r.appliedOnBehalf),
            stage: r.stage || (r.status === "approved" || r.status === "rejected" ? "completed" : "hr_review"),
            status: r.status,
            appliedAt: r.appliedAt ? r.appliedAt.toISOString() : r.createdAt,
            managerReview: r.managerReview || null,
            reviewedBy: r.reviewedBy ? r.reviewedBy.toString() : null,
            reviewerName: r.reviewerName,
            reviewerRole: r.reviewerRole || (r.reviewerName?.includes("CEO") ? "CEO" : r.reviewerName?.includes("HR") ? "HR" : ""),
            reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
            reviewerComments: r.reviewerComments,
            selfApproved: Boolean(r.selfApproved),
            attendanceMarked: Boolean(r.attendanceMarked),
            attendanceDates: r.attendanceDates || [],
            cancelledDates: r.cancelledDates || [],
            resubmissionCount: r.resubmissionCount || 0,
            resubmittedFrom: r.resubmittedFrom ? r.resubmittedFrom.toString() : null,
        };
        }),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
    };
}

/**
 * Submit a new leave / time-off request.
 * - CEO can self-approve immediately.
 * - Manager can apply on behalf of direct reports to HR.
 * - Manager/HR applying for themselves route to CEO.
 * - Employee applying routes to Manager (if assigned) or HR.
 */
export async function createLeaveRequest(userId, body) {
    const { workspace, user, callerEmployee, isCEO, isHR, isManager } =
        await getCallerContext(userId);

    let targetEmployee = null;
    let appliedOnBehalf = false;
    let appliedByRole = isCEO ? "CEO" : isHR ? "HR" : isManager ? "MANAGER" : "EMPLOYEE";
    let stage = "hr_review";
    let status = "pending_hr";

    // 1. Determine target employee
    if (body.employeeId && body.employeeId !== callerEmployee?._id?.toString()) {
        if (isCEO || isHR) {
            targetEmployee = await Employee.findOne({
                workspace: workspace._id,
                $or: [{ _id: body.employeeId }, { employeeId: body.employeeId }],
            });
            appliedOnBehalf = true;
        } else if (isManager && callerEmployee) {
            // Manager applying on behalf of employee working under him
            const managerFilter = buildManagerDirectReportsMongoFilter(workspace._id, user, callerEmployee, { includeSelf: false });

            targetEmployee = await Employee.findOne({
                workspace: workspace._id,
                $or: [{ _id: body.employeeId }, { employeeId: body.employeeId }],
                $and: [
                    {
                        $or: managerFilter.$or,
                    },
                ],
            });

            if (!targetEmployee) {
                // Also check if user is listed in designated department or direct team
                targetEmployee = await Employee.findOne({
                    workspace: workspace._id,
                    $or: [{ _id: body.employeeId }, { employeeId: body.employeeId }],
                });
            }

            appliedOnBehalf = true;
        } else {
            throw ApiError.forbidden("Only Managers, HR, or CEO can apply for leaves on behalf of an employee");
        }

        if (!targetEmployee) throw ApiError.notFound("Target employee not found");
    } else {
        // Self application
        if (!callerEmployee) {
            // If CEO doesn't have an employee record, auto-create a virtual self reference or link
            if (isCEO) {
                let virtualEmp = await Employee.findOne({ workspace: workspace._id, linkedUser: userId });
                if (!virtualEmp) {
                    virtualEmp = await Employee.create({
                        workspace: workspace._id,
                        firstName: user.fullName?.split(" ")[0] || "Executive",
                        lastName: user.fullName?.split(" ").slice(1).join(" ") || "CEO",
                        employeeId: "EXEC-001",
                        phone: "0000000000",
                        department: "Operations",
                        designation: "Founder / CEO",
                        employmentStatus: "Active",
                        employmentType: "Full Time",
                        joiningDate: new Date(),
                        salaryAmount: 0,
                        payFrequency: "Monthly",
                        loginEmail: user.email,
                        linkedUser: userId,
                        systemRole: "Admin",
                    });
                }
                targetEmployee = virtualEmp;
            } else {
                throw ApiError.badRequest(
                    "You do not have a linked employee profile in this workspace. Please contact HR to link your profile."
                );
            }
        } else {
            targetEmployee = callerEmployee;
        }
    }

    const startDate = String(body.startDate || "").trim();
    const endDate = String(body.endDate || startDate).trim();

    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        throw ApiError.badRequest("Valid start date (YYYY-MM-DD) is required");
    }
    if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        throw ApiError.badRequest("Valid end date (YYYY-MM-DD) is required");
    }
    if (startDate > endDate) {
        throw ApiError.badRequest("Start date cannot be after end date");
    }

    const reason = String(body.reason || "").trim();
    if (!reason) {
        throw ApiError.badRequest("Reason for leave / time-off is required");
    }

    const category = body.category === "timeoff" ? "timeoff" : "leave";
    const rawType = String(body.leaveType || (category === "timeoff" ? "hourly_permission" : "annual")).trim();
    const isHalfDay = Boolean(body.isHalfDay) || rawType === "half_day";
    const isShortDay = Boolean(body.isShortDay) || rawType === "short_day" || rawType === "short_leave";
    const halfDayPeriod = isHalfDay ? (body.halfDayPeriod || "first_half") : null;
    const shortDayHours = isShortDay ? (Number(body.shortDayHours) || 2) : null;

    let computedDays = 1.0;
    if (isShortDay) {
        computedDays = 0.25;
    } else if (isHalfDay) {
        computedDays = 0.5;
    } else {
        computedDays = calculateDaysBetween(startDate, endDate, false, false);
    }
    const totalDays = Number(body.totalDays) > 0 ? Number(body.totalDays) : computedDays;

    const applicantName = `${targetEmployee.firstName} ${targetEmployee.lastName}`.trim();

    // -------------------------------------------------------------
    // Route workflow stage & status
    // -------------------------------------------------------------
    const isSelfApprovalCEO = isCEO && !appliedOnBehalf && Boolean(body.selfApprove ?? true);

    if (isSelfApprovalCEO) {
        stage = "completed";
        status = "approved";
    } else if (appliedOnBehalf && isManager) {
        // "Manager sends request on behalf of employee to HR"
        stage = "hr_review";
        status = "pending_hr";
    } else if (!appliedOnBehalf && isHR) {
        // "The leaves reqeust by HR should come to CEO's not HR"
        stage = "ceo_review";
        status = "pending_ceo";
    } else if (!appliedOnBehalf && isManager) {
        // "All the leaves requested by managers should come to the HR and CEO's."
        stage = "hr_review";
        status = "pending_hr";
    } else if (!appliedOnBehalf && targetEmployee.reportingManager) {
        // "Employee can only request leaves and time-off from the Manager"
        stage = "manager_review";
        status = "pending_manager";
    } else {
        // Default to HR review
        stage = "hr_review";
        status = "pending_hr";
    }

    // Attendance dates to auto-mark if CEO self-approved
    let attendanceDates = [];
    if (isSelfApprovalCEO) {
        const cur = new Date(startDate);
        const end = new Date(endDate);
        while (cur <= end) {
            attendanceDates.push(cur.toISOString().slice(0, 10));
            cur.setDate(cur.getDate() + 1);
        }
    }

    const leave = await LeaveRequest.create({
        workspace: workspace._id,
        employee: targetEmployee._id,
        user: targetEmployee.linkedUser || userId,
        employeeName: applicantName,
        employeeCode: targetEmployee.employeeId,
        department: targetEmployee.department || "General",
        designation: targetEmployee.designation || "",
        reportingManager: targetEmployee.reportingManager || "",
        category,
        leaveType: rawType,
        startDate,
        endDate,
        totalDays,
        isHalfDay,
        halfDayPeriod,
        isShortDay,
        shortDayHours,
        reason,
        emergencyContact: String(body.emergencyContact || "").trim(),
        appliedByRole,
        appliedBy: userId,
        appliedByName: user.fullName || "User",
        appliedOnBehalf,
        appliedByManager: appliedOnBehalf && isManager ? callerEmployee?._id : null,
        stage,
        status,
        selfApproved: isSelfApprovalCEO,
        attendanceMarked: isSelfApprovalCEO,
        attendanceDates,
        reviewedBy: isSelfApprovalCEO ? userId : null,
        reviewerName: isSelfApprovalCEO ? user.fullName || "CEO" : "",
        reviewerRole: isSelfApprovalCEO ? "CEO" : "",
        reviewedAt: isSelfApprovalCEO ? new Date() : null,
        reviewerComments: isSelfApprovalCEO ? "Instant self-approval by Executive CEO" : "",
        appliedAt: new Date(),
    });

    // -------------------------------------------------------------
    // If CEO self-approved, immediately sync Attendance Records
    // -------------------------------------------------------------
    if (isSelfApprovalCEO) {
        for (const dateStr of attendanceDates) {
            await AttendanceRecord.findOneAndUpdate(
                {
                    workspace: workspace._id,
                    employee: targetEmployee._id,
                    date: dateStr,
                },
                {
                    $set: {
                        status: "on-leave",
                        source: "manual",
                        markedBy: userId,
                        note: `Approved ${category === "timeoff" ? "time-off" : leave.leaveType + " leave"} (CEO self-approved)`,
                    },
                },
                { upsert: true, new: true }
            );
        }
    }

    // -------------------------------------------------------------
    // Notifications & Emails
    // -------------------------------------------------------------
    try {
        const datesLabel = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
        const itemTypeLabel = category === "timeoff" ? "time-off" : `${leave.leaveType} leave`;

        if (status === "pending_manager" && targetEmployee.reportingManager) {
            // Find manager user to notify
            const mgrQuery = targetEmployee.reportingManager.trim();
            const mgrEmp = await Employee.findOne({
                workspace: workspace._id,
                $or: [{ employeeId: mgrQuery }, { firstName: mgrQuery.split(" ")[0] }],
            });
            const mgrUser = mgrEmp?.linkedUser ? await User.findById(mgrEmp.linkedUser) : null;

            await createNotification({
                workspaceId: workspace._id,
                recipientId: mgrUser?._id || mgrEmp?.linkedUser || null,
                title: "Employee Leave Request",
                message: `${applicantName} submitted a ${itemTypeLabel} request (${datesLabel}) awaiting your verification.`,
                type: "leave_request",
                link: "/leave",
                metadata: { leaveId: leave._id.toString(), employeeName: applicantName },
            });
        } else if (!appliedOnBehalf && isManager) {
            // "All the leaves requested by managers should come to the HR and CEO's."
            // 1. Notify HR (in-app and email)
            await createNotification({
                workspaceId: workspace._id,
                recipientId: null, // Broadcast to HR
                title: "Manager Leave Request for Review",
                message: `${applicantName} (Manager) submitted ${itemTypeLabel} (${datesLabel}) awaiting review.`,
                type: "leave_request",
                link: "/leave",
                metadata: { leaveId: leave._id.toString(), employeeName: applicantName, managerRequest: true },
            });

            const hrUsers = await User.find({
                workspace: workspace._id,
                role: { $in: ["HR Manager", "HR Generalist", "HR"] },
            }).lean();
            for (const hr of hrUsers) {
                if (hr.email) {
                    sendNewLeaveRequestEmail({
                        to: hr.email,
                        hrName: hr.fullName || "HR Team",
                        applicantName,
                        applicantRole: "Manager",
                        department: targetEmployee.department,
                        leaveType: leave.leaveType.toUpperCase(),
                        dates: datesLabel,
                        totalDays,
                        reason,
                        companyName: workspace.companyName,
                    }).catch(() => {});
                }
            }

            // 2. Notify CEO (in-app and email) only if CEO authority is enabled OR no HR exists
            const shouldNotifyCeo = workspace.ceoFullControlWithHr !== false || hrUsers.length === 0;
            if (shouldNotifyCeo) {
                const ceoUsers = await User.find({
                    $or: [
                        { _id: workspace.owner },
                        { role: "Founder / CEO" },
                        { role: "Administrator" },
                    ],
                }).lean();

                for (const ceo of ceoUsers) {
                    await createNotification({
                        workspaceId: workspace._id,
                        recipientId: ceo._id,
                        title: "Executive Review: Manager Leave Request",
                        message: `${applicantName} (Manager) submitted ${itemTypeLabel} (${datesLabel}) awaiting executive verification.`,
                        type: "leave_request",
                        link: "/leave",
                        metadata: { leaveId: leave._id.toString(), employeeName: applicantName, managerRequest: true },
                    });
                    if (ceo.email) {
                        sendNewLeaveRequestEmail({
                            to: ceo.email,
                            hrName: ceo.fullName || "CEO",
                            applicantName,
                            applicantRole: "Manager",
                            department: targetEmployee.department,
                            leaveType: leave.leaveType.toUpperCase(),
                            dates: datesLabel,
                            totalDays,
                            reason,
                            companyName: workspace.companyName,
                        }).catch(() => {});
                    }
                }
            }
        } else if (status === "pending_hr") {
            // Broadcast to HR
            await createNotification({
                workspaceId: workspace._id,
                recipientId: null,
                title: appliedOnBehalf ? "Manager Leave Submission for Employee" : "Leave Request for HR Review",
                message: appliedOnBehalf
                    ? `${user.fullName} (Manager) submitted ${itemTypeLabel} on behalf of ${applicantName} (${datesLabel}).`
                    : `${applicantName} submitted ${itemTypeLabel} (${datesLabel}) for HR review.`,
                type: "leave_request",
                link: "/leave",
                metadata: { leaveId: leave._id.toString(), employeeName: applicantName, appliedOnBehalf },
            });

            const hrUsers = await User.find({
                workspace: workspace._id,
                role: { $in: ["HR Manager", "HR Generalist", "HR"] },
            }).lean();
            for (const hr of hrUsers) {
                if (hr.email) {
                    sendNewLeaveRequestEmail({
                        to: hr.email,
                        hrName: hr.fullName || "HR Team",
                        applicantName: appliedOnBehalf ? `${applicantName} (via Manager ${user.fullName})` : applicantName,
                        applicantRole: targetEmployee.designation || "Employee",
                        department: targetEmployee.department,
                        leaveType: leave.leaveType.toUpperCase(),
                        dates: datesLabel,
                        totalDays,
                        reason,
                        companyName: workspace.companyName,
                    }).catch(() => {});
                }
            }
        } else if (status === "pending_ceo") {
            // "The leaves reqeust by HR should come to CEO's not HR"
            const ceoUsers = await User.find({
                $or: [
                    { _id: workspace.owner },
                    { role: "Founder / CEO" },
                    { role: "Administrator" },
                ],
            }).lean();

            for (const ceo of ceoUsers) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: ceo._id,
                    title: "Executive Review: HR Time-Off",
                    message: `${applicantName} (HR) requested ${itemTypeLabel} (${datesLabel}) awaiting CEO verification.`,
                    type: "leave_request",
                    link: "/leave",
                    metadata: { leaveId: leave._id.toString(), employeeName: applicantName },
                });
                if (ceo.email) {
                    sendNewLeaveRequestEmail({
                        to: ceo.email,
                        hrName: ceo.fullName || "CEO",
                        applicantName,
                        applicantRole: "HR",
                        department: targetEmployee.department,
                        leaveType: leave.leaveType.toUpperCase(),
                        dates: datesLabel,
                        totalDays,
                        reason,
                        companyName: workspace.companyName,
                    }).catch(() => {});
                }
            }
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error on leave create:", notifErr.message);
    }

    return leave;
}

/**
 * Manager verifies employee's request and forwards it to HR.
 * "Hassan will verify how long he want leave and why he wants leave. After verifying Hassan will send the request of leave on behalf of Ahmed to HR."
 */
export async function forwardLeaveRequestByManager(userId, requestId, body = {}) {
    const { workspace, user, callerEmployee, isCEO, isHR, isManager } = await getCallerContext(userId);

    const leave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");

    if (leave.status !== "pending_manager" && leave.status !== "pending") {
        throw ApiError.badRequest(`Cannot forward leave request currently in status '${leave.status}'`);
    }

    // Ensure caller is the manager of this employee, or CEO/HR
    if (!isCEO && !isHR && !isManager) {
        throw ApiError.forbidden("Only managers or HR can verify and forward employee leave requests");
    }

    const comments = String(body.comments || body.notes || "").trim();

    leave.stage = "hr_review";
    leave.status = "pending_hr";
    leave.managerReview = {
        reviewedBy: userId,
        reviewerName: user.fullName || "Manager",
        action: "forwarded_to_hr",
        comments: comments || "Verified and recommended by Manager.",
        reviewedAt: new Date(),
    };

    await leave.save();

    // Notify HR and Employee
    try {
        const datesLabel = leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} → ${leave.endDate}`;

        // Notify HR
        await createNotification({
            workspaceId: workspace._id,
            recipientId: null,
            title: "Manager Forwarded Leave Request",
            message: `${user.fullName} (Manager) verified and forwarded ${leave.employeeName}'s ${leave.leaveType} leave (${datesLabel}) to HR.`,
            type: "leave_request",
            link: "/leave",
            metadata: { leaveId: leave._id.toString(), employeeName: leave.employeeName },
        });

        // Notify Employee
        await createNotification({
            workspaceId: workspace._id,
            recipientId: leave.user,
            title: "Leave Verified by Manager",
            message: `Your manager verified your ${leave.leaveType} leave (${datesLabel}) and forwarded it to HR for approval.`,
            type: "leave_status",
            link: "/leave",
            metadata: { leaveId: leave._id.toString(), status: "pending_hr" },
        });
    } catch (err) {
        console.error("Notification error on manager forward:", err.message);
    }

    return leave;
}

/**
 * Manager rejects an employee's leave request.
 */
export async function rejectLeaveRequestByManager(userId, requestId, body = {}) {
    const { workspace, user, isCEO, isHR, isManager } = await getCallerContext(userId);

    const leave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");

    if (!isCEO && !isHR && !isManager) {
        throw ApiError.forbidden("Only managers can review this request");
    }

    const comments = String(body.comments || body.reason || "Declined by team manager.").trim();

    leave.stage = "completed";
    leave.status = "rejected";
    leave.managerReview = {
        reviewedBy: userId,
        reviewerName: user.fullName || "Manager",
        action: "rejected",
        comments,
        reviewedAt: new Date(),
    };
    leave.reviewedBy = userId;
    leave.reviewerName = user.fullName || "Manager";
    leave.reviewedAt = new Date();
    leave.reviewerComments = comments;

    await leave.save();

    try {
        await createNotification({
            workspaceId: workspace._id,
            recipientId: leave.user,
            title: "Leave Request Declined by Manager",
            message: `Your manager declined your ${leave.leaveType} request. Reason: ${comments}. You can re-apply from the rejected request.`,
            type: "leave_status",
            link: "/leave",
            metadata: { leaveId: leave._id.toString(), status: "rejected" },
        });
    } catch (err) {
        console.error("Notification error on manager reject:", err.message);
    }

    return leave;
}

/**
 * Review leave request (Approve or Reject by HR or CEO).
 * "If the HR rejects leave he will tell the reason (optional). If approves he will tell the reason (optional) and the leaves should be marked for employee automatically. The HR should also be able to verify if the leaves are marked or not."
 */
export async function reviewLeaveRequest(userId, requestId, { status, reviewerComments }) {
    const { workspace, user, callerEmployee, isCEO, isHR } = await getCallerContext(userId);

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR and Executive CEO have permission to verify, approve, or reject leave requests");
    }

    if (!["approved", "rejected"].includes(status)) {
        throw ApiError.badRequest("Status must be either 'approved' or 'rejected'");
    }

    const leave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");

    if (leave.status === "approved" || leave.status === "cancelled") {
        throw ApiError.conflict(`This leave request is already ${leave.status}`);
    }

    // HR cannot approve or reject leaves intended for CEO (e.g. HR's own leaves)
    const isHrOwnLeave = Boolean(leave.status === "pending_ceo" || leave.stage === "ceo_review" || (!leave.appliedOnBehalf && leave.appliedByRole === "HR"));
    if (isHrOwnLeave) {
        if (!isCEO) {
            throw ApiError.forbidden("HR leaves can only be verified and approved or rejected by the CEO");
        }
    } else if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }

    // Non-CEO cannot approve or reject their own leaves
    if (!isCEO) {
        const isOwn =
            (leave.user && leave.user.toString() === userId.toString()) ||
            (leave.appliedBy && leave.appliedBy.toString() === userId.toString()) ||
            (callerEmployee && leave.employee.toString() === callerEmployee._id.toString());
        if (isOwn) {
            throw ApiError.forbidden("You cannot verify or approve/reject your own leave application");
        }
    }

    const reviewerRole = isCEO ? "CEO" : "HR";
    leave.status = status;
    leave.stage = "completed";
    leave.reviewedBy = userId;
    leave.reviewerName = user.fullName || reviewerRole;
    leave.reviewerRole = reviewerRole;
    leave.reviewedAt = new Date();
    leave.reviewerComments = String(reviewerComments || "").trim();

    // -------------------------------------------------------------
    // If Approved, automatically mark employee attendance records
    // -------------------------------------------------------------
    let markedDates = [];
    if (status === "approved") {
        const cur = new Date(leave.startDate);
        const end = new Date(leave.endDate);

        while (cur <= end) {
            const dateStr = cur.toISOString().slice(0, 10);
            markedDates.push(dateStr);

            await AttendanceRecord.findOneAndUpdate(
                {
                    workspace: workspace._id,
                    employee: leave.employee,
                    date: dateStr,
                },
                {
                    $set: {
                        status: "on-leave",
                        source: "manual",
                        markedBy: userId,
                        note: `Approved ${leave.category === "timeoff" ? "time-off" : leave.leaveType + " leave"} by ${leave.reviewerName}`,
                    },
                },
                { upsert: true, new: true }
            );

            cur.setDate(cur.getDate() + 1);
        }

        leave.attendanceMarked = true;
        leave.attendanceDates = markedDates;
    } else {
        leave.attendanceMarked = false;
        leave.attendanceDates = [];
    }

    await leave.save();

    // -------------------------------------------------------------
    // Notifications & Emails to Employee and Manager
    // -------------------------------------------------------------
    try {
        const datesLabel = leave.startDate === leave.endDate ? leave.startDate : `${leave.startDate} → ${leave.endDate}`;
        const employeeDoc = await Employee.findById(leave.employee);
        const applicantUser = leave.user ? await User.findById(leave.user) : null;
        const applicantEmail = applicantUser?.email || employeeDoc?.loginEmail || employeeDoc?.personalEmail;

        // 1. In-app to Employee / Applicant
        await createNotification({
            workspaceId: workspace._id,
            recipientId: applicantUser?._id || employeeDoc?.linkedUser || null,
            title: `Leave Request ${status === "approved" ? "Approved" : "Rejected"} by ${reviewerRole}`,
            message: `Your ${leave.leaveType} application for ${datesLabel} was ${status} by ${reviewerRole} (${leave.reviewerName}).${leave.reviewerComments ? ` Remarks: ${leave.reviewerComments}` : ""}`,
            type: "leave_status",
            link: "/leave",
            metadata: { leaveId: leave._id.toString(), status, reviewerRole },
        });

        // 2. Email to Employee / Applicant (Manager or Staff)
        if (applicantEmail) {
            sendEmployeeLeaveStatusEmail({
                to: applicantEmail,
                employeeName: leave.employeeName,
                status: status === "approved" ? "Approved" : "Rejected",
                leaveType: leave.leaveType.toUpperCase(),
                dates: datesLabel,
                reviewerComments: leave.reviewerComments,
                reviewerRole,
                companyName: workspace.companyName,
            }).catch(() => {});
        }

        // 3. Notify reporting manager (if applied for a subordinate, not manager's own leave)
        const isManagerOwnLeave = leave.appliedByRole === "MANAGER" && !leave.appliedOnBehalf;
        if (leave.reportingManager && !isManagerOwnLeave) {
            const mgrQuery = leave.reportingManager.trim();
            const mgrEmp = await Employee.findOne({
                workspace: workspace._id,
                $or: [{ employeeId: mgrQuery }, { firstName: mgrQuery.split(" ")[0] }],
            });
            const mgrUser = mgrEmp?.linkedUser ? await User.findById(mgrEmp.linkedUser) : null;

            await createNotification({
                workspaceId: workspace._id,
                recipientId: mgrUser?._id || mgrEmp?.linkedUser,
                title: `Team Leave ${status === "approved" ? "Approved" : "Rejected"} by ${reviewerRole}`,
                message: `${reviewerRole} (${leave.reviewerName}) ${status} the ${leave.leaveType} request for ${leave.employeeName} (${datesLabel}).`,
                type: "team_leave_update",
                link: "/leave",
                metadata: { leaveId: leave._id.toString(), employeeName: leave.employeeName, status, reviewerRole },
            });

            const mgrEmail = mgrUser?.email || mgrEmp?.loginEmail || mgrEmp?.personalEmail;
            if (mgrEmail) {
                sendTeamLeaveUpdateEmail({
                    to: mgrEmail,
                    managerName: mgrUser?.fullName || mgrEmp?.firstName || mgrQuery,
                    employeeName: leave.employeeName,
                    status: status === "approved" ? "Approved" : "Rejected",
                    leaveType: leave.leaveType.toUpperCase(),
                    dates: datesLabel,
                    reviewerRole,
                    companyName: workspace.companyName,
                }).catch(() => {});
            }
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error on leave review:", notifErr.message);
    }

    return leave;
}

/**
 * Re-submit a rejected leave request.
 * - Employee can re-apply with a valid reason (routes back to Manager).
 * - Manager can re-apply on behalf of employee from a rejected request (routes to HR).
 */
export async function resubmitLeaveRequest(userId, requestId, body) {
    const { workspace, user, callerEmployee, isCEO, isHR, isManager } = await getCallerContext(userId);

    const oldLeave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!oldLeave) throw ApiError.notFound("Original leave request not found");

    if (oldLeave.status !== "rejected") {
        throw ApiError.badRequest("Only rejected leave requests can be re-applied");
    }

    const reason = String(body.reason || "").trim();
    if (!reason) {
        throw ApiError.badRequest("A valid reason/justification is required to re-apply");
    }

    const isOriginalApplicant = Boolean(
        (oldLeave.user && oldLeave.user.toString() === userId.toString()) ||
        (oldLeave.appliedBy && oldLeave.appliedBy.toString() === userId.toString()) ||
        (callerEmployee && oldLeave.employee && oldLeave.employee.toString() === callerEmployee._id.toString())
    );

    // If Manager requested for himself and got rejected: ONLY that manager can re-apply
    if (oldLeave.appliedByRole === "MANAGER" && !oldLeave.appliedOnBehalf) {
        if (!isOriginalApplicant) {
            throw ApiError.forbidden("Only the manager who submitted this rejected request can re-apply with reason.");
        }
    }

    // If HR requested for herself and got rejected: ONLY that HR can re-apply
    if (oldLeave.appliedByRole === "HR" && !oldLeave.appliedOnBehalf) {
        if (!isOriginalApplicant) {
            throw ApiError.forbidden("Only the HR member who submitted this rejected request can re-apply with reason.");
        }
    }

    // If Employee requested: only the employee or their reporting manager
    if (!isOriginalApplicant) {
        const isAssignedManager = isManager && (
            oldLeave.reportingManager === callerEmployee?.employeeId ||
            oldLeave.reportingManager === callerEmployee?.firstName ||
            oldLeave.reportingManager === `${callerEmployee?.firstName} ${callerEmployee?.lastName}`.trim()
        );
        if (!isAssignedManager) {
            throw ApiError.forbidden("You do not have permission to re-apply for this rejected leave request.");
        }
    }

    const startDate = String(body.startDate || oldLeave.startDate).trim();
    const endDate = String(body.endDate || oldLeave.endDate).trim();
    const leaveType = body.leaveType || oldLeave.leaveType;
    const category = body.category || oldLeave.category || "leave";
    const isHalfDay = body.isHalfDay !== undefined ? Boolean(body.isHalfDay) : oldLeave.isHalfDay;
    const halfDayPeriod = isHalfDay ? body.halfDayPeriod || oldLeave.halfDayPeriod || "first_half" : null;
    const totalDays = calculateDaysBetween(startDate, endDate, isHalfDay);

    const isCallerTheManager = isManager && (
        oldLeave.appliedOnBehalf ||
        oldLeave.reportingManager === callerEmployee?.employeeId ||
        oldLeave.reportingManager === callerEmployee?.firstName ||
        oldLeave.reportingManager === `${callerEmployee?.firstName} ${callerEmployee?.lastName}`.trim()
    );

    // Route stage and status
    let stage = "hr_review";
    let status = "pending_hr";

    if (!oldLeave.appliedOnBehalf && oldLeave.appliedByRole === "HR") {
        // HR re-applying for own leave: routes to CEO
        stage = "ceo_review";
        status = "pending_ceo";
    } else if (!oldLeave.appliedOnBehalf && oldLeave.appliedByRole === "MANAGER") {
        // Manager re-applying for own leave: routes to HR/CEO
        stage = "hr_review";
        status = "pending_hr";
    } else if (!isCallerTheManager && oldLeave.reportingManager) {
        // Employee is re-applying, goes to Manager first!
        stage = "manager_review";
        status = "pending_manager";
    }

    // Create a new linked leave request recording resubmission
    const newLeave = await LeaveRequest.create({
        workspace: workspace._id,
        employee: oldLeave.employee,
        user: oldLeave.user,
        employeeName: oldLeave.employeeName,
        employeeCode: oldLeave.employeeCode,
        department: oldLeave.department,
        designation: oldLeave.designation,
        reportingManager: oldLeave.reportingManager,
        category,
        leaveType,
        startDate,
        endDate,
        totalDays,
        isHalfDay,
        halfDayPeriod,
        reason,
        emergencyContact: String(body.emergencyContact || oldLeave.emergencyContact || "").trim(),
        appliedByRole: oldLeave.appliedByRole || (isCallerTheManager ? "MANAGER" : "EMPLOYEE"),
        appliedBy: userId,
        appliedByName: user.fullName || "User",
        appliedOnBehalf: Boolean(isCallerTheManager && oldLeave.appliedOnBehalf),
        appliedByManager: isCallerTheManager && oldLeave.appliedOnBehalf ? callerEmployee?._id : null,
        stage,
        status,
        resubmittedFrom: oldLeave._id,
        resubmissionCount: (oldLeave.resubmissionCount || 0) + 1,
        managerReview: isCallerTheManager
            ? {
                  reviewedBy: userId,
                  reviewerName: user.fullName || "Manager",
                  action: "forwarded_to_hr",
                  comments: `Re-submitted by Manager with updated justification: ${reason}`,
                  reviewedAt: new Date(),
              }
            : null,
        appliedAt: new Date(),
    });

    // Notify the destination party
    try {
        const datesLabel = startDate === endDate ? startDate : `${startDate} → ${endDate}`;
        if (stage === "hr_review") {
            await createNotification({
                workspaceId: workspace._id,
                recipientId: null,
                title: "Re-submitted Leave Request for HR",
                message: `${user.fullName} (Manager) re-submitted ${oldLeave.employeeName}'s ${leaveType} leave (${datesLabel}) with revised justification for HR review.`,
                type: "leave_request",
                link: "/leave",
                metadata: { leaveId: newLeave._id.toString(), employeeName: oldLeave.employeeName },
            });
        } else {
            // Notify manager
            const mgrEmp = await Employee.findOne({
                workspace: workspace._id,
                $or: [{ employeeId: oldLeave.reportingManager }, { firstName: oldLeave.reportingManager?.split(" ")[0] }],
            });
            const mgrUser = mgrEmp?.linkedUser ? await User.findById(mgrEmp.linkedUser) : null;
            await createNotification({
                workspaceId: workspace._id,
                recipientId: mgrUser?._id || mgrEmp?.linkedUser || null,
                title: "Employee Re-Applied for Leave",
                message: `${oldLeave.employeeName} re-applied for ${leaveType} leave (${datesLabel}) with revised reason awaiting your verification.`,
                type: "leave_request",
                link: "/leave",
                metadata: { leaveId: newLeave._id.toString(), employeeName: oldLeave.employeeName },
            });
        }
    } catch (err) {
        console.error("Notification error on leave resubmission:", err.message);
    }

    return newLeave;
}

/**
 * Get employee leave history and balances.
 * Used by HR and Managers during review to verify how many leaves the employee has left.
 */
export async function getEmployeeLeaveHistoryAndBalance(userId, employeeId) {
    const { workspace } = await getCallerContext(userId);

    const isObjectId = Boolean(employeeId) && /^[0-9a-fA-F]{24}$/.test(String(employeeId));
    const emp = await Employee.findOne({
        workspace: workspace._id,
        ...(isObjectId
            ? { $or: [{ _id: employeeId }, { employeeId }] }
            : { employeeId }),
    }).lean();

    if (!emp) throw ApiError.notFound("Employee not found");

    const currentYearStr = new Date().getFullYear().toString();

    // Past requests
    const allRequests = await LeaveRequest.find({
        workspace: workspace._id,
        employee: emp._id,
    })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();

    // Calculate balances
    const approvedThisYear = allRequests.filter(
        (r) => r.status === "approved" && r.startDate && r.startDate.startsWith(currentYearStr)
    );

    const usedCounts = { annual: 0, casual: 0, sick: 0, unpaid: 0, maternity: 0, paternity: 0, special: 0 };
    for (const r of approvedThisYear) {
        const type = r.leaveType || "annual";
        if (usedCounts[type] !== undefined) {
            usedCounts[type] += r.totalDays || 0;
        }
    }

    const attConfig = workspace.attendance || {};
    const noLeavePolicy = Boolean(attConfig.noLeavePolicy);
    const weekendWorkEarnsLeave = Boolean(attConfig.weekendWorkEarnsLeave);
    const leavesPerEmployee = typeof attConfig.leavesPerEmployee === "number" ? attConfig.leavesPerEmployee : DEFAULT_LEAVE_ALLOWANCES.annual;
    const timeoffPerEmployee = typeof attConfig.timeoffPerEmployee === "number" ? attConfig.timeoffPerEmployee : 10;

    const balanceResult = await calculateAllLeaveBalances(workspace, emp._id, allRequests);
    const balances = balanceResult.balances;
    const weekendAccruals = balanceResult.weekendAccruals;
    const leaveTypes = resolveWorkspaceLeaveTypes(workspace);
    const timeoffTypes = resolveWorkspaceTimeoffTypes(workspace);

    return {
        employee: {
            id: emp._id.toString(),
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`.trim(),
            designation: emp.designation,
            department: emp.department,
            reportingManager: emp.reportingManager,
            avatar: emp.avatar,
            email: emp.loginEmail || emp.personalEmail,
        },
        leavePolicy: {
            noLeavePolicy,
            weekendWorkEarnsLeave,
            weekendLeaveExpiry: attConfig.weekendLeaveExpiry || "never",
            leavesPerEmployee,
            timeoffPerEmployee,
            earnedWeekendLeaves: weekendAccruals.activeBalance,
            leavePolicyMode: attConfig.leavePolicyMode || "detailed",
        },
        balances,
        weekendAccruals,
        leaveTypes,
        timeoffTypes,
        categories: LEAVE_CATEGORIES,
        history: allRequests.map((r) => ({
            id: r._id.toString(),
            category: r.category || "leave",
            leaveType: r.leaveType,
            startDate: r.startDate,
            endDate: r.endDate,
            totalDays: r.totalDays,
            reason: r.reason,
            status: r.status,
            attendanceMarked: Boolean(r.attendanceMarked),
            reviewerComments: r.reviewerComments,
            appliedAt: r.appliedAt ? r.appliedAt.toISOString() : r.createdAt,
            isHalfDay: Boolean(r.isHalfDay),
            halfDayPeriod: r.halfDayPeriod,
            isShortDay: Boolean(r.isShortDay),
            shortDayHours: r.shortDayHours,
        })),
    };
}

/**
 * Get visual leave calendar data for a given month (YYYY-MM).
 * Returns all active leaves, holidays, and weekends for HR verification.
 */
export async function getLeaveCalendar(userId, monthStr) {
    const { workspace } = await getCallerContext(userId);

    const targetMonth = monthStr || new Date().toISOString().slice(0, 7);
    const regex = new RegExp(`^${escapeRegexInput(targetMonth)}`);

    // Only officially approved leaves appear on the calendar
    const leaves = await LeaveRequest.find({
        workspace: workspace._id,
        status: "approved",
        $or: [
            { startDate: { $regex: regex } },
            { endDate: { $regex: regex } },
            { attendanceDates: { $elemMatch: { $regex: regex } } },
        ],
    })
        .populate("employee", "avatar")
        .sort({ startDate: 1 })
        .lean();

    // Workspace attendance settings: weekends and holidays
    const weekendDays = workspace.attendance?.weekendDays || [0, 6];
    const holidays = (workspace.attendance?.holidays || []).map((h) => ({
        date: h.date,
        name: h.name,
    }));

    return {
        month: targetMonth,
        weekendDays,
        holidays,
        leaves: leaves.map((r) => {
            const empIdStr = r.employee && typeof r.employee === "object"
                ? (r.employee._id ? r.employee._id.toString() : "")
                : (r.employee ? r.employee.toString() : "");
            const empAvatar = r.employee && typeof r.employee === "object" ? (r.employee.avatar || "") : "";
            return {
                id: r._id.toString(),
                employeeId: empIdStr,
                employeeAvatar: empAvatar,
                employeeName: r.employeeName,
            employeeCode: r.employeeCode,
            department: r.department,
            designation: r.designation,
            reportingManager: r.reportingManager,
            category: r.category || "leave",
            leaveType: r.leaveType,
            startDate: r.startDate,
            endDate: r.endDate,
            totalDays: r.totalDays,
            isHalfDay: Boolean(r.isHalfDay),
            halfDayPeriod: r.halfDayPeriod,
            reason: r.reason,
            status: r.status,
            attendanceMarked: Boolean(r.attendanceMarked),
            attendanceDates: r.attendanceDates || [],
            cancelledDates: r.cancelledDates || [],
        };
        }),
    };
}

/**
 * Verify attendance marking for a specific leave request.
 * Allows HR to verify if attendance records are actually marked as 'on-leave'.
 */
export async function getAttendanceCheckForLeave(userId, requestId) {
    const { workspace } = await getCallerContext(userId);

    const leave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    }).lean();

    if (!leave) throw ApiError.notFound("Leave request not found");

    const start = new Date(leave.startDate);
    const end = new Date(leave.endDate);
    const dates = [];

    const cur = new Date(start);
    while (cur <= end) {
        dates.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
    }

    const records = await AttendanceRecord.find({
        workspace: workspace._id,
        employee: leave.employee,
        date: { $in: dates },
    }).lean();

    const recordMap = new Map();
    for (const rec of records) {
        recordMap.set(rec.date, rec);
    }

    const dateDetails = dates.map((d) => {
        const rec = recordMap.get(d);
        return {
            date: d,
            status: rec ? rec.status : "unmarked",
            isMarkedOnLeave: rec ? rec.status === "on-leave" : false,
            source: rec ? rec.source : null,
            note: rec ? rec.note : "",
            updatedAt: rec ? rec.updatedAt : null,
        };
    });

    const allMarked = dateDetails.length > 0 && dateDetails.every((d) => d.isMarkedOnLeave);

    return {
        leaveId: leave._id.toString(),
        employeeName: leave.employeeName,
        employeeCode: leave.employeeCode,
        leaveType: leave.leaveType,
        startDate: leave.startDate,
        endDate: leave.endDate,
        totalDays: leave.totalDays,
        isApproved: leave.status === "approved",
        allMarked,
        dates: dateDetails,
    };
}

/**
 * Cancel a pending leave request by the applicant.
 */
export async function cancelLeaveRequest(userId, requestId) {
    const { workspace, callerEmployee, isCEO, isHR } = await getCallerContext(userId);

    const leave = await LeaveRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");

    if (leave.status === "approved" || leave.status === "cancelled") {
        throw ApiError.badRequest(`Cannot cancel a leave request with status '${leave.status}'`);
    }

    const isOwn =
        (leave.user && leave.user.toString() === userId.toString()) ||
        (callerEmployee && leave.employee.toString() === callerEmployee._id.toString()) ||
        (leave.appliedBy && leave.appliedBy.toString() === userId.toString());

    if (!isOwn && !isCEO && !isHR) {
        throw ApiError.forbidden("You can only cancel your own pending leave requests");
    }

    leave.status = "cancelled";
    leave.stage = "completed";
    await leave.save();

    return leave;
}

/**
 * Internal logic to cancel an approved leave, reverting its attendance marks
 * and automatically refunding the days to the employee's balance.
 * Supports cancelling all dates or selecting specific dates (partial cancellation).
 */
export async function cancelApprovedLeaveInternal(workspace, leave, reviewerUser, options = "") {
    let cancellationReason = "";
    let selectedDates = null;
    let cancelAll = false;

    if (typeof options === "string") {
        cancellationReason = options;
    } else if (options && typeof options === "object") {
        cancellationReason = options.reason || options.cancellationReason || "";
        selectedDates = Array.isArray(options.selectedDates) ? options.selectedDates : null;
        cancelAll = Boolean(options.cancelAll);
    }

    // Determine all dates for this leave
    let allDates = [];
    if (Array.isArray(leave.attendanceDates) && leave.attendanceDates.length > 0) {
        allDates = [...leave.attendanceDates];
    } else if (leave.startDate && leave.endDate) {
        const cur = new Date(leave.startDate);
        const end = new Date(leave.endDate);
        while (cur <= end) {
            allDates.push(cur.toISOString().slice(0, 10));
            cur.setDate(cur.getDate() + 1);
        }
    } else if (leave.startDate) {
        allDates = [leave.startDate];
    }

    const cancelledSet = new Set(leave.cancelledDates || []);
    const activeDates = allDates.filter((d) => !cancelledSet.has(d));

    // Rule: Passed on-leave days cannot be cancelled. Only current or future dates are cancellable.
    const todayStr = getDateInTimezone(new Date(), workspace?.timezone);
    const cancellableDates = activeDates.filter((d) => d >= todayStr);
    const passedDates = activeDates.filter((d) => d < todayStr);

    if (cancellableDates.length === 0) {
        throw ApiError.badRequest(
            "Cannot cancel this approved leave because all leave dates have already passed. Passed on-leave days cannot be cancelled."
        );
    }

    // Determine dates to cancel (must ONLY be from cancellableDates; passed dates are strictly preserved)
    let datesToCancel = [];
    const isFullCancel =
        cancelAll ||
        !selectedDates ||
        selectedDates.length === 0 ||
        selectedDates.length >= cancellableDates.length;

    if (isFullCancel) {
        datesToCancel = [...cancellableDates];
    } else {
        // Partial cancellation: strictly filter out any passed dates
        datesToCancel = selectedDates.filter((d) => cancellableDates.includes(d));
    }

    if (datesToCancel.length === 0) {
        throw ApiError.badRequest(
            "No eligible upcoming leave dates were selected for cancellation. Passed on-leave days cannot be cancelled."
        );
    }

    const daysToRefund = datesToCancel.length * (leave.isHalfDay ? 0.5 : 1);
    const remainingActiveDates = activeDates.filter((d) => !datesToCancel.includes(d));
    const remainingDays = Math.max(0, (leave.totalDays || activeDates.length) - daysToRefund);

    // If passed dates remain, the leave remains approved for the dates actually taken
    if (remainingActiveDates.length > 0 && remainingDays > 0) {
        const sortedRemaining = [...remainingActiveDates].sort();
        leave.startDate = sortedRemaining[0];
        leave.endDate = sortedRemaining[sortedRemaining.length - 1];
        leave.totalDays = remainingDays;
        leave.attendanceDates = sortedRemaining;
        leave.attendanceMarked = leave.attendanceDates.length > 0;
        leave.status = "approved";
        leave.reviewerComments = cancellationReason
            ? `Partial cancellation (${datesToCancel.length} day(s) refunded): ${cancellationReason}`
            : `Partial cancellation (${datesToCancel.length} day(s) refunded)`;
    } else {
        leave.status = "cancelled";
        leave.stage = "completed";
        leave.attendanceDates = [];
        leave.attendanceMarked = false;
        leave.totalDays = 0;
        leave.reviewerComments = cancellationReason
            ? `Cancelled: ${cancellationReason}`
            : "Approved leave cancelled.";
    }

    leave.cancelledDates = Array.from(new Set([...(leave.cancelledDates || []), ...datesToCancel]));
    leave.reviewedBy = reviewerUser._id;
    leave.reviewedByName = reviewerUser.fullName || "HR";
    leave.reviewedAt = new Date();
    await leave.save();

    // Revert marked attendance records ONLY for the cancelled dates
    if (datesToCancel.length > 0) {
        await AttendanceRecord.deleteMany({
            workspace: workspace._id,
            employee: leave.employee,
            date: { $in: datesToCancel },
            status: "on-leave",
            source: "manual",
        });
    }

    return leave;
}

/**
 * Directly cancel an approved leave (HR or CEO).
 * Supports payload with { reason, selectedDates, cancelAll } or plain string reason.
 */
export async function cancelApprovedLeave(userId, leaveId, payload = "") {
    const { workspace, user, isCEO, isHR } = await getCallerContext(userId);
    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR or CEO can directly cancel approved leaves. Managers can submit a cancellation request.");
    }

    if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }

    const leave = await LeaveRequest.findOne({
        _id: leaveId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");
    if (leave.status !== "approved") {
        throw ApiError.badRequest(`Cannot cancel leave with status "${leave.status}". Only approved leaves can be cancelled.`);
    }

    const todayStr = getDateInTimezone(new Date(), workspace?.timezone);
    if ((leave.endDate || leave.startDate) < todayStr) {
        throw ApiError.badRequest(
            "Cannot cancel this approved leave because all leave dates have already passed. Passed on-leave days cannot be cancelled."
        );
    }

    const cancelled = await cancelApprovedLeaveInternal(workspace, leave, user, payload);

    // Notify employee
    try {
        if (leave.user) {
            const isFullCancel = cancelled.status === "cancelled";
            const notificationMsg = isFullCancel
                ? `Your approved ${leave.leaveType} leave (${leave.startDate} to ${leave.endDate}) has been cancelled by ${isCEO ? "CEO" : "HR"}. Leave days have been refunded to your balance.`
                : `Dates for your approved ${leave.leaveType} leave have been partially cancelled by ${isCEO ? "CEO" : "HR"}. Refunded days have been credited back to your balance.`;

            await createNotification({
                workspaceId: workspace._id,
                recipientId: leave.user,
                title: isFullCancel ? "Approved Leave Cancelled" : "Leave Dates Cancelled",
                message: notificationMsg,
                type: "leave_status",
                link: "/leave",
            });
        }
    } catch (e) {
        console.warn("Notification error:", e);
    }

    return cancelled;
}

/**
 * Manager submits a request to cancel an approved leave for a direct report.
 * Supports choosing specific dates or cancel all.
 */
export async function requestLeaveCancellation(userId, { leaveId, reason, selectedDates, cancelAll }) {
    const { workspace, user, callerEmployee, isCEO, isHR, isManager } = await getCallerContext(userId);

    const leave = await LeaveRequest.findOne({
        _id: leaveId,
        workspace: workspace._id,
    });
    if (!leave) throw ApiError.notFound("Leave request not found");
    if (leave.status !== "approved") {
        throw ApiError.badRequest("Only approved leaves can be requested for cancellation.");
    }

    const todayStr = getDateInTimezone(new Date(), workspace?.timezone);
    if ((leave.endDate || leave.startDate) < todayStr) {
        throw ApiError.badRequest(
            "Cannot request cancellation for this approved leave because all leave dates have already passed. Passed on-leave days cannot be cancelled."
        );
    }

    const employee = await Employee.findById(leave.employee).lean();
    if (!employee) throw ApiError.notFound("Employee not found");

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, user, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request leave cancellation for employees reporting directly to them.");
        }
    }

    const datesList = Array.isArray(selectedDates) ? selectedDates : [];
    const passedRequested = datesList.filter((d) => d < todayStr);
    if (passedRequested.length > 0) {
        throw ApiError.badRequest(
            `Cannot cancel passed leave dates (${passedRequested.join(", ")}). Only current or upcoming leave dates can be cancelled.`
        );
    }

    // Determine eligible active upcoming dates
    let allDates = [];
    if (Array.isArray(leave.attendanceDates) && leave.attendanceDates.length > 0) {
        allDates = [...leave.attendanceDates];
    } else if (leave.startDate && leave.endDate) {
        const cur = new Date(leave.startDate);
        const end = new Date(leave.endDate);
        while (cur <= end) {
            allDates.push(cur.toISOString().slice(0, 10));
            cur.setDate(cur.getDate() + 1);
        }
    } else if (leave.startDate) {
        allDates = [leave.startDate];
    }
    const cancelledSet = new Set(leave.cancelledDates || []);
    const activeCancellableDates = allDates.filter((d) => !cancelledSet.has(d) && d >= todayStr);

    if (activeCancellableDates.length === 0) {
        throw ApiError.badRequest(
            "Cannot request cancellation because all remaining leave dates have already passed. Passed on-leave days cannot be cancelled."
        );
    }

    const finalDates = datesList.length > 0 ? datesList : activeCancellableDates;
    const isAll = Boolean(cancelAll) || finalDates.length >= activeCancellableDates.length;
    const daysToRefund = finalDates.length * (leave.isHalfDay ? 0.5 : 1);

    const { EmployeeCorrectionRequest } = await import("../../model/employee/correctionRequest.model.js");

    const request = await EmployeeCorrectionRequest.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        requestedBy: userId,
        requestedByName: user.fullName || "Manager",
        requestedByRole: isManager ? "Manager" : "HR",
        requestType: "leave_cancellation",
        patch: {
            leaveId: leave._id.toString(),
            leaveType: leave.leaveType,
            startDate: leave.startDate,
            endDate: leave.endDate,
            totalDays: leave.totalDays,
            selectedDates: datesList,
            cancelAll: isAll,
            daysToRefund,
            reason: reason || "Employee requested leave cancellation",
        },
        originalValues: {
            status: leave.status,
            totalDays: leave.totalDays,
        },
        reason: reason || "Employee requested remaining leaves to be cancelled",
        status: "pending",
    });

    // Notify HR
    try {
        const { getOperationalReviewers } = await import("../employee/employee.service.js");
        const hrUsers = await getOperationalReviewers(workspace, { excludeUserId: userId });

        for (const recipient of hrUsers) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Leave Cancellation Request",
                    message: `${user.fullName || "Manager"} requested cancellation of approved leave for ${employee.firstName} ${employee.lastName} (${leave.startDate} to ${leave.endDate}). Submitted to HR for verification.`,
                    type: "leave_request",
                    link: `/employees/${employee.employeeId}`,
                    metadata: { correctionRequestId: request._id.toString() },
                });
            }
        }
    } catch (e) {
        console.warn("Notification error:", e);
    }

    return { success: true, request };
}

/**
 * Add a custom leave type definition for the organization workspace.
 */
export async function addCustomLeaveType(userId, leaveTypeData) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR } = await getCallerContext(userId);
    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only the Founder / CEO or HR can create custom leave types");
    }

    const name = String(leaveTypeData.name || "").trim();
    if (!name) throw ApiError.badRequest("Leave type name is required");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const key = `custom_${slug}_${Date.now().toString(36)}`;

    const customType = {
        key,
        name,
        category: leaveTypeData.category || "custom",
        enabled: leaveTypeData.enabled !== undefined ? Boolean(leaveTypeData.enabled) : true,
        defaultDays: Number(leaveTypeData.defaultDays) >= 0 ? Number(leaveTypeData.defaultDays) : 5,
        isPaid: leaveTypeData.isPaid !== undefined ? Boolean(leaveTypeData.isPaid) : true,
        deductionRate: Number(leaveTypeData.deductionRate) > 0 ? Number(leaveTypeData.deductionRate) : 1.0,
        expiryRule: leaveTypeData.expiryRule || "end_of_year",
        description: String(leaveTypeData.description || "").trim(),
        isCustom: true,
        createdAt: new Date(),
    };

    if (!Array.isArray(workspace.attendance.customLeaveTypes)) {
        workspace.attendance.customLeaveTypes = [];
    }
    workspace.attendance.customLeaveTypes.push(customType);
    workspace.markModified("attendance");
    await workspace.save();

    return customType;
}

/**
 * Delete a custom leave type definition.
 */
export async function deleteCustomLeaveType(userId, key) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR } = await getCallerContext(userId);
    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only the Founder / CEO or HR can delete custom leave types");
    }

    if (Array.isArray(workspace.attendance.customLeaveTypes)) {
        workspace.attendance.customLeaveTypes = workspace.attendance.customLeaveTypes.filter((t) => t.key !== key);
    }
    if (Array.isArray(workspace.attendance.leaveTypesConfig)) {
        workspace.attendance.leaveTypesConfig = workspace.attendance.leaveTypesConfig.filter((t) => t.key !== key);
    }
    workspace.markModified("attendance");
    await workspace.save();

    return { success: true, key };
}

/**
 * Get leave types catalog and configuration for the workspace.
 */
export async function getLeaveTypesCatalog(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const leaveTypes = resolveWorkspaceLeaveTypes(workspace);
    const timeoffTypes = resolveWorkspaceTimeoffTypes(workspace);
    return {
        categories: LEAVE_CATEGORIES,
        leaveTypes,
        timeoffTypes,
        weekendExpiryOptions: WEEKEND_EXPIRY_OPTIONS,
        policy: {
            noLeavePolicy: Boolean(workspace.attendance?.noLeavePolicy),
            weekendWorkEarnsLeave: Boolean(workspace.attendance?.weekendWorkEarnsLeave),
            weekendLeaveExpiry: workspace.attendance?.weekendLeaveExpiry || "never",
            leavesPerEmployee: workspace.attendance?.leavesPerEmployee ?? 14,
            timeoffPerEmployee: workspace.attendance?.timeoffPerEmployee ?? 10,
            leavePolicyMode: workspace.attendance?.leavePolicyMode || "detailed",
        },
    };
}
