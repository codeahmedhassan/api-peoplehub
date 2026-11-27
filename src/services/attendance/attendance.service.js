// src/services/attendance/attendance.service.js
import mongoose from "mongoose";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { getWorkspaceOrThrow, checkWorkspaceHasHR } from "../workspace/workspace.service.js";
import { getCallerRoleContext, buildManagerDirectReportsMongoFilter, calculateRecordHours } from "../employee/employee.service.js";
import {
    getDateInTimezone,
    getRollupDates,
    isWeekend,
} from "../../utils/timezone.js";
import {
    ROLLUP_LOOKBACK_DAYS,
} from "../../constants/attendance.js";

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function getEmployeeHireDateStr(emp) {
    if (!emp) return null;
    const jd = emp.joiningDate || emp.createdAt;
    if (!jd) return null;
    if (jd instanceof Date) return jd.toISOString().slice(0, 10);
    if (typeof jd === "string") return jd.slice(0, 10);
    return null;
}

/**
 * Build the shared filter used by list / summary / export.
 */
function buildRangeFilter(workspaceId, query) {
    const filter = { workspace: workspaceId };
    if (query.from && query.to) {
        filter.date = { $gte: query.from, $lte: query.to };
    } else if (query.from) {
        filter.date = { $gte: query.from };
    }
    if (query.status) filter.status = query.status;
    return filter;
}

/**
 * Apply employee-based filters (department, employeeId, q) by resolving
 * matching employee ids first. Returns null if nothing matches.
 */
async function resolveEmployeeFilter(workspaceId, query) {
    const empFilter = { workspace: workspaceId };
    let any = false;

    if (query.employeeId) {
        empFilter.employeeId = query.employeeId;
        any = true;
    }
    if (query.department) {
        empFilter.department = query.department;
        any = true;
    }
    if (query.q) {
        const rx = new RegExp(
            query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i"
        );
        empFilter.$or = [{ firstName: rx }, { lastName: rx }, { employeeId: rx }];
        any = true;
    }
    if (!any) return null;

    const employees = await Employee.find(empFilter).select("_id").lean();
    return employees.map((e) => e._id);
}

/**
 * Resolves all employee ObjectIds that report to a manager (or is the manager himself).
 */
async function getManagerEmployeeIds(workspaceId, caller, callerEmployee) {
    const filter = buildManagerDirectReportsMongoFilter(workspaceId, caller, callerEmployee, { includeSelf: true });
    const teamEmployees = await Employee.find(filter).select("_id").lean();
    return teamEmployees.map((e) => e._id);
}

/**
 * Calculates hours worked between checkIn and checkOut, required work hours,
 * and if enabled in workspace attendance settings, deducts salary based on hourly rate.
 */
export function calculateAttendanceHoursAndDeduction({
    checkIn,
    checkOut,
    employee,
    workspace,
}) {
    const requiredHours = Number(employee?.workingHours) || 8;
    const isDeductionEnabled = Boolean(workspace?.attendance?.deductShortHours);

    // Calculate base daily salary
    const baseSalary = Number(employee?.salaryAmount || employee?.basicSalary || 0);
    let dailySalary = 0;
    if (employee?.payFrequency === "Daily") {
        dailySalary = baseSalary;
    } else if (employee?.payFrequency === "Weekly") {
        dailySalary = baseSalary / 5;
    } else if (employee?.payFrequency === "Bi-Weekly") {
        dailySalary = baseSalary / 10;
    } else if (employee?.payFrequency === "Semi-Monthly") {
        dailySalary = baseSalary / 15;
    } else {
        // Monthly or default (based on 30 days or configured working days)
        const workingDays = Number(workspace?.attendance?.workingDaysInMonth) || 30;
        dailySalary = baseSalary / workingDays;
    }

    dailySalary = Math.round(dailySalary * 100) / 100;
    const hourlyRate = requiredHours > 0 ? Math.round((dailySalary / requiredHours) * 100) / 100 : 0;

    if (!checkIn || !checkOut) {
        return {
            hoursWorked: 0,
            requiredHours,
            shortHours: 0,
            hourlyRate,
            dailySalary,
            deductionAmount: 0,
            earnedSalary: 0,
            salaryDeductionApplied: isDeductionEnabled,
        };
    }

    const inDate = new Date(checkIn);
    const outDate = new Date(checkOut);
    let durationMs = outDate.getTime() - inDate.getTime();
    if (durationMs < 0) {
        durationMs += 24 * 60 * 60 * 1000; // Overnight shift crossing midnight
    }
    const hoursWorked = Math.round((durationMs / (1000 * 60 * 60)) * 100) / 100;

    if (isDeductionEnabled) {
        const shortHours = Math.max(0, Math.round((requiredHours - hoursWorked) * 100) / 100);
        const deductionAmount = Math.round(shortHours * hourlyRate * 100) / 100;
        const earnedSalary = Math.max(0, Math.round((dailySalary - deductionAmount) * 100) / 100);

        return {
            hoursWorked,
            requiredHours,
            shortHours,
            hourlyRate,
            dailySalary,
            deductionAmount,
            earnedSalary,
            salaryDeductionApplied: true,
        };
    } else {
        return {
            hoursWorked,
            requiredHours,
            shortHours: 0,
            hourlyRate,
            dailySalary,
            deductionAmount: 0,
            earnedSalary: dailySalary,
            salaryDeductionApplied: false,
        };
    }
}

// -------------------------------------------------------------------
// GET /attendance  (paginated list)
// -------------------------------------------------------------------
export async function listAttendance(userId, query) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isManager } = await getCallerRoleContext(userId, workspace);

    const filter = buildRangeFilter(workspace._id, query);
    let employeeIds = await resolveEmployeeFilter(workspace._id, query);

    // If Manager: only show employees assigned under that manager
    if (isManager) {
        const managerTeamIds = await getManagerEmployeeIds(workspace._id, caller, callerEmployee);
        if (managerTeamIds.length === 0) {
            return {
                records: [],
                pagination: { page: query.page ?? 1, limit: query.limit ?? 50, total: 0, totalPages: 0 },
            };
        }
        if (employeeIds !== null) {
            const teamIdStrings = new Set(managerTeamIds.map((id) => id.toString()));
            employeeIds = employeeIds.filter((id) => teamIdStrings.has(id.toString()));
        } else {
            employeeIds = managerTeamIds;
        }
    }

    if (employeeIds !== null) {
        if (employeeIds.length === 0) {
            return {
                records: [],
                pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
            };
        }
        filter.employee = { $in: employeeIds };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const skip = (page - 1) * limit;

    const [records, total] = await Promise.all([
        AttendanceRecord.find(filter)
            .populate("employee", "firstName lastName employeeId avatar department designation workLocation joiningDate createdAt")
            .populate("markedBy", "fullName")
            .sort({ date: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AttendanceRecord.countDocuments(filter),
    ]);

    const validRecords = records.filter((r) => {
        const emp = r.employee;
        if (!emp || typeof emp !== "object") return true;
        const hireDateStr = getEmployeeHireDateStr(emp);
        if (hireDateStr && r.date < hireDateStr) {
            return false;
        }
        return true;
    });

    return {
        records: validRecords.map((r) => {
            const rowHours = calculateRecordHours(r, Number(r.employee?.workingHours) || 8);
            const safe = new AttendanceRecord(r).toSafeJSON(r.employee);
            return {
                ...r,
                ...safe,
                hoursWorked: rowHours,
                markedBy: r.markedBy ? { id: r.markedBy._id, fullName: r.markedBy.fullName } : null,
            };
        }),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}

// -------------------------------------------------------------------
// GET /attendance/summary  (stats + chart series + breakdown)
// -------------------------------------------------------------------
export async function getAttendanceSummary(userId, query) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isManager } = await getCallerRoleContext(userId, workspace);
    const { from, to } = query;

    const filter = { workspace: workspace._id, date: { $gte: from, $lte: to } };

    if (isManager) {
        const managerTeamIds = await getManagerEmployeeIds(workspace._id, caller, callerEmployee);
        filter.employee = { $in: managerTeamIds };
    }

    const records = await AttendanceRecord.find(filter)
        .populate("employee", "joiningDate createdAt")
        .select("date status source employee")
        .lean();

    const validRecords = records.filter((r) => {
        const emp = r.employee;
        if (!emp || typeof emp !== "object") return true;
        const hireDateStr = getEmployeeHireDateStr(emp);
        if (hireDateStr && r.date < hireDateStr) {
            return false;
        }
        return true;
    });

    const counts = {
        total: validRecords.length,
        present: 0,
        absent: 0,
        late: 0,
        halfDay: 0,
        onLeave: 0,
        holiday: 0,
        weekend: 0,
        unmarked: 0,
        remote: 0,
    };

    const perDate = new Map();

    for (const r of validRecords) {
        switch (r.status) {
            case "present": counts.present++; break;
            case "absent": counts.absent++; break;
            case "late": counts.late++; break;
            case "half-day": counts.halfDay++; break;
            case "on-leave": counts.onLeave++; break;
            case "holiday": counts.holiday++; break;
            case "weekend": counts.weekend++; break;
            case "unmarked": counts.unmarked++; break;
            case "remote": counts.remote++; break;
        }
        if (!perDate.has(r.date)) {
            perDate.set(r.date, { date: r.date, present: 0, absent: 0, late: 0, halfDay: 0, remote: 0 });
        }
        const bucket = perDate.get(r.date);
        if (r.status === "present") bucket.present++;
        else if (r.status === "absent") bucket.absent++;
        else if (r.status === "late") bucket.late++;
        else if (r.status === "half-day") bucket.halfDay++;
        else if (r.status === "remote") bucket.remote = (bucket.remote || 0) + 1;
    }

    const series = Array.from(perDate.values()).sort((a, b) =>
        a.date < b.date ? -1 : 1
    );

    const breakdown = [
        { status: "present", count: counts.present },
        { status: "remote", count: counts.remote },
        { status: "absent", count: counts.absent },
        { status: "late", count: counts.late },
        { status: "half-day", count: counts.halfDay },
        { status: "on-leave", count: counts.onLeave },
        { status: "holiday", count: counts.holiday },
        { status: "weekend", count: counts.weekend },
        { status: "unmarked", count: counts.unmarked },
    ].map((row) => ({
        ...row,
        percent: counts.total > 0 ? Math.round((row.count / counts.total) * 1000) / 10 : 0,
    }));

    return {
        range: { from, to },
        counts,
        series,
        breakdown,
    };
}

// -------------------------------------------------------------------
// Automated Remote Employee Attendance Marking
// -------------------------------------------------------------------

const AUTO_MARK_REMOTE_TTL_MS = 5 * 60 * 1000;
const recentAutoMarkCache = new Map();

/**
 * Automatically mark attendance as "remote" for all active remote employees
 * in the workspace on a given date if they don't already have an attendance record.
 */
export async function autoMarkRemoteAttendanceForWorkspace(workspaceId, targetDate = null, { force = false } = {}) {
    if (!workspaceId) return { marked: 0 };

    const cacheKey = `${workspaceId}:${targetDate || "today"}`;
    if (!force) {
        const lastRun = recentAutoMarkCache.get(cacheKey);
        if (lastRun && Date.now() - lastRun < AUTO_MARK_REMOTE_TTL_MS) {
            return { marked: 0, cached: true };
        }
    }

    try {
        const workspace = await Workspace.findById(workspaceId).lean();
        if (!workspace) return { marked: 0 };

        const date = targetDate || getDateInTimezone(new Date(), workspace.timezone);
        recentAutoMarkCache.set(`${workspaceId}:${targetDate || "today"}`, Date.now());
        recentAutoMarkCache.set(`${workspaceId}:${date}`, Date.now());
        const weekendDays = workspace.attendance?.weekendDays ?? [0, 6];
        const holidays = workspace.attendance?.holidays ?? [];
        const holidayDates = new Set(holidays.map((h) => h.date));

        // If the date is holiday or weekend, do not mark as remote
        if (holidayDates.has(date) || isWeekend(date, weekendDays)) {
            return { marked: 0, reason: "weekend_or_holiday" };
        }

        // Find active remote employees
        const remoteEmployees = await Employee.find({
            workspace: workspaceId,
            isActive: { $ne: false },
            employmentStatus: { $nin: ["Terminated", "Resigned"] },
            workArrangement: { $regex: /remote/i },
        }).select("_id workingHours employeeId firstName lastName").lean();

        if (remoteEmployees.length === 0) return { marked: 0 };

        // Find existing records on this date
        const existingRecords = await AttendanceRecord.find({
            workspace: workspaceId,
            date,
            employee: { $in: remoteEmployees.map((e) => e._id) },
        }).select("employee status").lean();

        const recordedEmployeeIds = new Set(
            existingRecords
                .filter((r) => r.status && r.status !== "unmarked")
                .map((r) => r.employee.toString())
        );

        const ops = [];
        for (const emp of remoteEmployees) {
            if (recordedEmployeeIds.has(emp._id.toString())) continue;

            const reqHours = Number(emp.workingHours) || 8;
            ops.push({
                updateOne: {
                    filter: { workspace: workspaceId, employee: emp._id, date },
                    update: {
                        $set: {
                            workspace: workspaceId,
                            employee: emp._id,
                            date,
                            status: "remote",
                            source: "auto",
                            hoursWorked: reqHours,
                            requiredHours: reqHours,
                            shortHours: 0,
                            hourlyRate: 0,
                            dailySalary: 0,
                            deductionAmount: 0,
                            earnedSalary: 0,
                            salaryDeductionApplied: false,
                            deviceMarkedPresent: false,
                            note: "Auto-marked: Remote work arrangement",
                        },
                    },
                    upsert: true,
                },
            });
        }

        if (ops.length > 0) {
            const res = await AttendanceRecord.bulkWrite(ops, { ordered: false });
            return { marked: (res.upsertedCount || 0) + (res.modifiedCount || 0) };
        }

        return { marked: 0 };
    } catch (err) {
        console.error("[autoMarkRemoteAttendance] error:", err.message);
        return { marked: 0, error: err.message };
    }
}

// -------------------------------------------------------------------
// GET /attendance/today
// Returns employees in the workspace with their row for "today"
// (in workspace TZ). Missing records are reported as "unmarked".
// If caller is Manager: only returns employees assigned under manager.
// -------------------------------------------------------------------
export async function getTodayAttendance(userId, clientDate = null) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);
    const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
    const ceoOverride = workspace.ceoFullControlWithHr !== undefined ? Boolean(workspace.ceoFullControlWithHr) : true;
    const canMarkAttendance = isHR || (isCEO && (!hasHR || ceoOverride));

    const today = (clientDate && /^\d{4}-\d{2}-\d{2}$/.test(String(clientDate).trim()))
        ? String(clientDate).trim()
        : getDateInTimezone(new Date(), workspace.timezone);

    // Ensure remote employees are automatically recorded as "remote" for today
    await autoMarkRemoteAttendanceForWorkspace(workspace._id, today).catch(() => {});

    let empFilter = { workspace: workspace._id };
    if (isManager) {
        empFilter = buildManagerDirectReportsMongoFilter(workspace._id, caller, callerEmployee, { includeSelf: false });
    }

    const [employees, records] = await Promise.all([
        Employee.find(empFilter)
            .select("firstName lastName employeeId avatar department designation workLocation workArrangement workingHours isActive status joiningDate createdAt")
            .sort({ firstName: 1, lastName: 1 })
            .lean(),
        AttendanceRecord.find({ workspace: workspace._id, date: today })
            .populate("markedBy", "fullName")
            .lean(),
    ]);

    const byEmployee = new Map(
        records.map((r) => [r.employee.toString(), r])
    );

    const rows = employees.map((emp) => {
        const rec = byEmployee.get(emp._id.toString());
        const hireDateStr = getEmployeeHireDateStr(emp);
        const base = {
            employeeId: emp.employeeId,
            employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
            employeeAvatar: emp.avatar || "",
            department: emp.department || "",
            designation: emp.designation || "",
            branch: emp.workLocation || "",
            employeeObjectId: emp._id.toString(),
            date: today,
            joiningDate: hireDateStr,
        };
        if (!rec) {
            const isRemote = /remote/i.test(emp.workArrangement || "");
            const reqHours = Number(emp.workingHours) || 8;
            if (isRemote) {
                return {
                    ...base,
                    id: null,
                    status: "remote",
                    source: "auto",
                    checkIn: null,
                    checkOut: null,
                    hoursWorked: reqHours,
                    requiredHours: reqHours,
                    shortHours: 0,
                    hourlyRate: 0,
                    dailySalary: 0,
                    deductionAmount: 0,
                    earnedSalary: 0,
                    salaryDeductionApplied: false,
                    deviceMarkedPresent: false,
                    deviceMarkedAt: null,
                    markedBy: null,
                    note: "Auto-marked: Remote work arrangement",
                };
            }
            return {
                ...base,
                id: null,
                status: "unmarked",
                source: null,
                checkIn: null,
                checkOut: null,
                hoursWorked: 0,
                requiredHours: reqHours,
                shortHours: 0,
                hourlyRate: 0,
                dailySalary: 0,
                deductionAmount: 0,
                earnedSalary: 0,
                salaryDeductionApplied: Boolean(workspace?.attendance?.deductShortHours),
                deviceMarkedPresent: false,
                deviceMarkedAt: null,
                markedBy: null,
                note: "",
            };
        }
        const empReqHours = rec.requiredHours ?? (Number(emp.workingHours) || 8);
        return {
            ...base,
            id: rec._id,
            status: rec.status,
            source: rec.source,
            checkIn: rec.checkIn,
            checkOut: rec.checkOut,
            hoursWorked: calculateRecordHours(rec, empReqHours),
            requiredHours: empReqHours,
            shortHours: rec.shortHours ?? 0,
            hourlyRate: rec.hourlyRate ?? 0,
            dailySalary: rec.dailySalary ?? 0,
            deductionAmount: rec.deductionAmount ?? 0,
            earnedSalary: rec.earnedSalary ?? 0,
            salaryDeductionApplied: Boolean(rec.salaryDeductionApplied),
            deviceMarkedPresent: rec.deviceMarkedPresent,
            deviceMarkedAt: rec.deviceMarkedAt,
            markedBy: rec.markedBy
                ? { id: rec.markedBy._id, fullName: rec.markedBy.fullName }
                : null,
            note: rec.note || "",
        };
    });

    return {
        date: today,
        employees: rows,
        userRole: isCEO ? "CEO" : isHR ? "HR" : isManager ? "Manager" : "Employee",
        canMarkAttendance: Boolean(canMarkAttendance),
        isManager: Boolean(isManager),
        isHR: Boolean(isHR),
        isCEO: Boolean(isCEO),
        hasHR: Boolean(hasHR),
        ceoFullControlWithHr: Boolean(workspace?.ceoFullControlWithHr),
    };
}

// -------------------------------------------------------------------
// POST /attendance/mark  (bulk upsert)
// -------------------------------------------------------------------
export async function markAttendance(userId, body) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    if (isManager) {
        throw ApiError.forbidden("Managers cannot mark attendance. Only HR can manually mark employee attendance.");
    }

    if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }

    const todayStr = getDateInTimezone(new Date(), workspace?.timezone);
    const results = [];
    const errors = [];

    for (const entry of body.records) {
        try {
            if (!entry.date) continue;
            if (entry.date > todayStr) {
                errors.push({
                    employeeId: entry.employeeId,
                    date: entry.date,
                    message: `Cannot mark attendance for upcoming or future dates (today is ${todayStr}).`,
                });
                continue;
            }

            // Resolve employee by employeeId (e.g. EMP-00125)
            const employee = await Employee.findOne({
                workspace: workspace._id,
                employeeId: entry.employeeId,
            });
            if (!employee) {
                errors.push({ employeeId: entry.employeeId, date: entry.date, message: "Employee not found" });
                continue;
            }

            const existing = await AttendanceRecord.findOne({
                workspace: workspace._id,
                employee: employee._id,
                date: entry.date,
            });

            const set = {
                workspace: workspace._id,
                employee: employee._id,
                date: entry.date,
                status: entry.status,
                source: "manual",
                markedBy: userId,
                note: entry.note || "",
            };
            const normalizedStatus = String(entry.status || "").toLowerCase().trim();
            const isAbsentLike = ["absent", "on-leave", "holiday", "weekend", "unmarked"].includes(normalizedStatus);

            if (isAbsentLike) {
                set.checkIn = null;
                set.checkOut = null;
                set.hoursWorked = 0;
                set.shortHours = 0;
                set.deductionAmount = 0;
                set.earnedSalary = 0;
                set.requiredHours = Number(employee.workingHours) || 8;
            } else {
                if (entry.checkIn !== undefined) {
                    set.checkIn = entry.checkIn ? new Date(entry.checkIn) : null;
                }
                if (entry.checkOut !== undefined) {
                    set.checkOut = entry.checkOut ? new Date(entry.checkOut) : null;
                }

                const effectiveCheckIn = set.checkIn !== undefined ? set.checkIn : existing?.checkIn;
                const effectiveCheckOut = set.checkOut !== undefined ? set.checkOut : existing?.checkOut;

                if (effectiveCheckIn && effectiveCheckOut) {
                    const calc = calculateAttendanceHoursAndDeduction({
                        checkIn: effectiveCheckIn,
                        checkOut: effectiveCheckOut,
                        employee,
                        workspace,
                    });
                    Object.assign(set, calc);
                } else if (effectiveCheckIn && !effectiveCheckOut) {
                    set.hoursWorked = 0;
                    set.requiredHours = Number(employee.workingHours) || 8;
                    set.shortHours = 0;
                    set.deductionAmount = 0;
                    set.earnedSalary = 0;
                    set.salaryDeductionApplied = Boolean(workspace?.attendance?.deductShortHours);
                } else {
                    const stdHours = Number(employee.workingHours) || 8;
                    set.requiredHours = stdHours;
                    if (normalizedStatus === "present" || normalizedStatus === "remote") {
                        set.hoursWorked = stdHours;
                    } else if (normalizedStatus === "half-day") {
                        set.hoursWorked = Math.round((stdHours / 2) * 10) / 10;
                    } else if (normalizedStatus === "late") {
                        set.hoursWorked = Math.max(0, stdHours - 1);
                    } else {
                        set.hoursWorked = 0;
                    }
                }
            }

            // Preserve device history when overriding a device-sourced row.
            if (
                existing &&
                existing.source === "device" &&
                existing.status === "present"
            ) {
                set.deviceMarkedPresent = true;
                set.deviceMarkedAt = existing.checkIn || existing.deviceMarkedAt || existing.updatedAt;
            }

            const updated = await AttendanceRecord.findOneAndUpdate(
                { workspace: workspace._id, employee: employee._id, date: entry.date },
                { $set: set },
                { new: true, upsert: true, setDefaultsOnInsert: true }
            );

            results.push({ employeeId: entry.employeeId, date: entry.date, id: updated._id });
        } catch (err) {
            errors.push({ employeeId: entry.employeeId, date: entry.date, message: err.message });
        }
    }

    return { results, errors };
}

// -------------------------------------------------------------------
// Rollup — writes absent/weekend/holiday/remote for past days
// -------------------------------------------------------------------
export async function rollupWorkspace(workspace, dates) {
    const { _id: workspaceId, attendance } = workspace;
    const weekendDays = attendance?.weekendDays ?? [0, 6];
    const holidays = attendance?.holidays ?? [];

    const holidayDates = new Set(holidays.map((h) => h.date));

    // All active employees in the workspace
    const employees = await Employee.find({ workspace: workspaceId })
        .select("_id workArrangement workingHours isActive status joiningDate createdAt")
        .lean();

    if (employees.length === 0) return { created: 0 };

    let created = 0;

    for (const date of dates) {
        // Which employees already have a record on this date?
        const existing = await AttendanceRecord.find({
            workspace: workspaceId,
            date,
        })
            .select("employee")
            .lean();
        const have = new Set(existing.map((r) => r.employee.toString()));

        const isHoliday = holidayDates.has(date);
        const weekend = isWeekend(date, weekendDays);

        // Bulk write for everyone who doesn't have a record
        const ops = [];
        for (const emp of employees) {
            if (have.has(emp._id.toString())) continue;

            const hireDateStr = getEmployeeHireDateStr(emp);
            if (hireDateStr && date < hireDateStr) {
                // Do not generate auto-records for dates before employee was hired
                continue;
            }

            const isRemote = /remote/i.test(emp.workArrangement || "");
            const status = isHoliday ? "holiday" : weekend ? "weekend" : (isRemote ? "remote" : "absent");
            const reqHours = Number(emp.workingHours) || 8;
            const hoursWorked = (status === "remote") ? reqHours : 0;
            const note = (isRemote && !isHoliday && !weekend) ? "Auto-marked: Remote work arrangement" : "";

            ops.push({
                updateOne: {
                    filter: { workspace: workspaceId, employee: emp._id, date },
                    update: {
                        $setOnInsert: {
                            workspace: workspaceId,
                            employee: emp._id,
                            date,
                            status,
                            source: "auto",
                            hoursWorked,
                            requiredHours: reqHours,
                            shortHours: 0,
                            hourlyRate: 0,
                            dailySalary: 0,
                            deductionAmount: 0,
                            earnedSalary: 0,
                            salaryDeductionApplied: false,
                            deviceMarkedPresent: false,
                            note,
                        },
                    },
                    upsert: true,
                },
            });
        }
        if (ops.length > 0) {
            const res = await AttendanceRecord.bulkWrite(ops, { ordered: false });
            created += res.upsertedCount || 0;
        }
    }

    return { created };
}

/**
 * Manual trigger — runs rollup for a single workspace, ignoring the lastRollupDate.
 * If `days` isn't passed, uses the last 7 completed days in workspace TZ.
 */
export async function triggerRollupForWorkspace(workspace, days = null) {
    const today = getDateInTimezone(new Date(), workspace.timezone);
    await autoMarkRemoteAttendanceForWorkspace(workspace._id, today).catch(() => {});

    try {
        const { checkExpiringProbations } = await import("../notification/notification.service.js");
        await checkExpiringProbations(workspace._id);
    } catch {}

    if (!workspace.attendance?.autoMarkAbsent) {
        return { skipped: true, reason: "autoMarkAbsent disabled" };
    }

    const dates = days ?? getRollupDates(today, ROLLUP_LOOKBACK_DAYS);

    const result = await rollupWorkspace(workspace, dates);

    workspace.attendance.lastRollupDate = dates[dates.length - 1];
    await workspace.save();

    return { skipped: false, ...result, dates };
}

/**
 * Walk all workspaces, run rollup for any whose local midnight just passed.
 * Also automatically records remote attendance and sweeps expiring probations.
 * Called by the hourly cron.
 */
export async function runHourlyRollupSweep() {
    let checkExpiringProbations;
    try {
        const notifService = await import("../notification/notification.service.js");
        checkExpiringProbations = notifService.checkExpiringProbations;
    } catch {}

    const allWorkspaces = await Workspace.find().lean();
    let workspacesProcessed = 0;

    for (const ws of allWorkspaces) {
        const today = getDateInTimezone(new Date(), ws.timezone);

        // Always auto-mark remote employees and check expiring probations
        try {
            await autoMarkRemoteAttendanceForWorkspace(ws._id, today);
            if (checkExpiringProbations) {
                await checkExpiringProbations(ws._id);
            }
        } catch (err) {
            console.error(`[sweep] helpers failed for workspace ${ws._id}:`, err.message);
        }

        if (!ws.attendance?.autoMarkAbsent) continue;

        const last = ws.attendance?.lastRollupDate;
        if (last === today) continue; // already processed today

        try {
            await rollupWorkspace(ws, getRollupDates(today, ROLLUP_LOOKBACK_DAYS));
            await Workspace.updateOne(
                { _id: ws._id },
                { $set: { "attendance.lastRollupDate": today } }
            );
            workspacesProcessed += 1;
        } catch (err) {
            console.error(`[rollup] failed for workspace ${ws._id}:`, err.message);
        }
    }

    return { workspacesProcessed, totalWorkspaces: allWorkspaces.length };
}

// -------------------------------------------------------------------
// Web Clock In / Clock Out Services
// -------------------------------------------------------------------

/**
 * Resolve target employee for clock action.
 * Priority:
 * 1. Target employee ID/MongoId if passed (e.g. by Admin/HR).
 * 2. Employee linked to User (linkedUser === userId).
 * 3. Employee with matching loginEmail or personalEmail.
 */
export async function resolveEmployeeForAction(workspace, userId, targetEmployeeId = null) {
    let employee = null;

    if (targetEmployeeId && targetEmployeeId.toString().trim() !== "") {
        const trimmed = targetEmployeeId.toString().trim();
        if (mongoose.Types.ObjectId.isValid(trimmed)) {
            employee = await Employee.findOne({ workspace: workspace._id, _id: trimmed });
        }
        if (!employee) {
            employee = await Employee.findOne({ workspace: workspace._id, employeeId: trimmed });
        }
        if (!employee) {
            throw ApiError.notFound(`Employee "${trimmed}" not found in this workspace.`);
        }
        return employee;
    }

    const user = await User.findById(userId).lean();
    if (user) {
        employee = await Employee.findOne({
            workspace: workspace._id,
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email?.toLowerCase() },
                { personalEmail: user.email?.toLowerCase() },
            ],
        });
    }

    if (!employee) {
        // Fallback: If workspace owner or admin, check if there's any employee record
        throw ApiError.notFound("No employee profile found linked to your user account. Please select an employee or pass employeeId.");
    }

    return employee;
}

/**
 * Clock In an employee for today (in workspace TZ).
 */
export async function clockInEmployee(userId, targetEmployeeId = null) {
    const workspace = await getWorkspaceOrThrow(userId);
    const employee = await resolveEmployeeForAction(workspace, userId, targetEmployeeId);

    const today = getDateInTimezone(new Date(), workspace.timezone);
    const now = new Date();

    let record = await AttendanceRecord.findOne({
        workspace: workspace._id,
        employee: employee._id,
        date: today,
    });

    if (!record) {
        record = new AttendanceRecord({
            workspace: workspace._id,
            employee: employee._id,
            date: today,
            status: "present",
            source: "web",
            checkIn: now,
            markedBy: userId,
            requiredHours: Number(employee.workingHours) || 8,
            hoursWorked: 0,
            shortHours: 0,
            hourlyRate: 0,
            dailySalary: 0,
            deductionAmount: 0,
            earnedSalary: 0,
            salaryDeductionApplied: Boolean(workspace?.attendance?.deductShortHours),
        });
        await record.save();
    } else {
        if (!record.checkIn) {
            record.checkIn = now;
            record.status = "present";
            record.source = record.source || "web";
            record.requiredHours = Number(employee.workingHours) || 8;
            record.salaryDeductionApplied = Boolean(workspace?.attendance?.deductShortHours);
            await record.save();
        } else if (record.checkIn && !record.checkOut) {
            return {
                record: record.toSafeJSON(employee),
                employee: {
                    id: employee._id,
                    employeeId: employee.employeeId,
                    name: `${employee.firstName} ${employee.lastName}`.trim(),
                },
                alreadyClockedIn: true,
                message: `Already clocked in at ${new Date(record.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            };
        } else {
            return {
                record: record.toSafeJSON(employee),
                employee: {
                    id: employee._id,
                    employeeId: employee.employeeId,
                    name: `${employee.firstName} ${employee.lastName}`.trim(),
                },
                alreadyCompleted: true,
                message: `Attendance already recorded for today (in: ${new Date(record.checkIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, out: ${new Date(record.checkOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).`,
            };
        }
    }

    return {
        record: record.toSafeJSON(employee),
        employee: {
            id: employee._id,
            employeeId: employee.employeeId,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
        },
        message: `Clocked in successfully at ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    };
}

/**
 * Clock Out an employee for today (in workspace TZ).
 * Calculates hours worked vs fixed required hours and applies hourly deduction if enabled.
 */
export async function clockOutEmployee(userId, targetEmployeeId = null) {
    const workspace = await getWorkspaceOrThrow(userId);
    const employee = await resolveEmployeeForAction(workspace, userId, targetEmployeeId);

    const today = getDateInTimezone(new Date(), workspace.timezone);

    let record = await AttendanceRecord.findOne({
        workspace: workspace._id,
        employee: employee._id,
        date: today,
    });

    if (!record || !record.checkIn) {
        throw ApiError.badRequest("Cannot clock out without clocking in first.");
    }

    const now = new Date();
    record.checkOut = now;
    if (["absent", "unmarked", "weekend"].includes(record.status)) {
        record.status = "present";
    }

    const calc = calculateAttendanceHoursAndDeduction({
        checkIn: record.checkIn,
        checkOut: record.checkOut,
        employee,
        workspace,
    });

    record.durationHours = calc.hoursWorked;
    record.hoursWorked = calc.hoursWorked;
    record.requiredHours = calc.requiredHours;
    record.shortHours = calc.shortHours;
    record.hourlyRate = calc.hourlyRate;
    record.dailySalary = calc.dailySalary;
    record.deductionAmount = calc.deductionAmount;
    record.earnedSalary = calc.earnedSalary;
    record.salaryDeductionApplied = calc.salaryDeductionApplied;

    await record.save();

    let detailsMsg = `Worked ${calc.hoursWorked}h / ${calc.requiredHours}h required.`;
    if (calc.salaryDeductionApplied) {
        if (calc.shortHours > 0) {
            detailsMsg += ` ${calc.shortHours}h short -> deducted ${calc.deductionAmount} (earned: ${calc.earnedSalary}).`;
        } else {
            detailsMsg += ` Full hours met (earned: ${calc.earnedSalary}).`;
        }
    } else {
        detailsMsg += ` (Hourly salary deduction disabled).`;
    }

    return {
        record: record.toSafeJSON(employee),
        employee: {
            id: employee._id,
            employeeId: employee.employeeId,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
        },
        message: `Clocked out successfully at ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. ${detailsMsg}`,
    };
}

/**
 * Get current clock status for the logged in user or specified employee.
 */
export async function getClockStatus(userId, targetEmployeeId = null) {
    const workspace = await getWorkspaceOrThrow(userId);

    let employee = null;
    try {
        employee = await resolveEmployeeForAction(workspace, userId, targetEmployeeId);
    } catch {
        // Fallback: If user has no employee profile, return general workspace status
        return {
            hasEmployeeProfile: false,
            workspaceDeductShortHours: Boolean(workspace?.attendance?.deductShortHours),
            record: null,
            isClockedIn: false,
            isClockedOut: false,
        };
    }

    const today = getDateInTimezone(new Date(), workspace.timezone);

    const record = await AttendanceRecord.findOne({
        workspace: workspace._id,
        employee: employee._id,
        date: today,
    });

    const isClockedIn = Boolean(record?.checkIn && !record?.checkOut);
    const isClockedOut = Boolean(record?.checkIn && record?.checkOut);

    return {
        hasEmployeeProfile: true,
        employee: {
            id: employee._id,
            employeeId: employee.employeeId,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            workingHours: Number(employee.workingHours) || 8,
            salaryAmount: employee.salaryAmount || employee.basicSalary || 0,
            payFrequency: employee.payFrequency,
        },
        workspaceDeductShortHours: Boolean(workspace?.attendance?.deductShortHours),
        isClockedIn,
        isClockedOut,
        record: record ? record.toSafeJSON(employee) : null,
    };
}