// src/services/attendance/attendance.service.js
import mongoose from "mongoose";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
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

async function getWorkspaceOrThrow(userId) {
    const ws = await Workspace.findOne({ owner: userId });
    if (!ws) throw ApiError.forbidden("No workspace found");
    return ws;
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

// -------------------------------------------------------------------
// GET /attendance  (paginated list)
// -------------------------------------------------------------------
export async function listAttendance(userId, query) {
    const workspace = await getWorkspaceOrThrow(userId);

    const filter = buildRangeFilter(workspace._id, query);
    const employeeIds = await resolveEmployeeFilter(workspace._id, query);

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
            .populate("employee", "firstName lastName employeeId avatar department designation workLocation")
            .populate("markedBy", "fullName")
            .sort({ date: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        AttendanceRecord.countDocuments(filter),
    ]);

    return {
        records: records.map((r) => ({
            ...r,
            ...new AttendanceRecord(r).toSafeJSON(r.employee),
            markedBy: r.markedBy ? { id: r.markedBy._id, fullName: r.markedBy.fullName } : null,
        })),
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
    const { from, to } = query;

    const filter = { workspace: workspace._id, date: { $gte: from, $lte: to } };

    const records = await AttendanceRecord.find(filter)
        .select("date status")
        .lean();

    const counts = {
        total: records.length,
        present: 0,
        absent: 0,
        late: 0,
        halfDay: 0,
        onLeave: 0,
        holiday: 0,
        weekend: 0,
        unmarked: 0,
    };

    const perDate = new Map();

    for (const r of records) {
        switch (r.status) {
            case "present": counts.present++; break;
            case "absent": counts.absent++; break;
            case "late": counts.late++; break;
            case "half-day": counts.halfDay++; break;
            case "on-leave": counts.onLeave++; break;
            case "holiday": counts.holiday++; break;
            case "weekend": counts.weekend++; break;
            case "unmarked": counts.unmarked++; break;
        }
        if (!perDate.has(r.date)) {
            perDate.set(r.date, { date: r.date, present: 0, absent: 0, late: 0, halfDay: 0 });
        }
        const bucket = perDate.get(r.date);
        if (r.status === "present") bucket.present++;
        else if (r.status === "absent") bucket.absent++;
        else if (r.status === "late") bucket.late++;
        else if (r.status === "half-day") bucket.halfDay++;
    }

    const series = Array.from(perDate.values()).sort((a, b) =>
        a.date < b.date ? -1 : 1
    );

    const breakdown = [
        { status: "present", count: counts.present },
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
// GET /attendance/today
// Returns every employee in the workspace with their row for "today"
// (in workspace TZ). Missing records are reported as "unmarked".
// -------------------------------------------------------------------
export async function getTodayAttendance(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const today = getDateInTimezone(new Date(), workspace.timezone);

    const [employees, records] = await Promise.all([
        Employee.find({ workspace: workspace._id })
            .select("firstName lastName employeeId avatar department designation workLocation")
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
        const base = {
            employeeId: emp.employeeId,
            employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
            employeeAvatar: emp.avatar || "",
            department: emp.department || "",
            designation: emp.designation || "",
            branch: emp.workLocation || "",
            employeeObjectId: emp._id.toString(),
            date: today,
        };
        if (!rec) {
            return {
                ...base,
                id: null,
                status: "unmarked",
                source: null,
                checkIn: null,
                checkOut: null,
                deviceMarkedPresent: false,
                deviceMarkedAt: null,
                markedBy: null,
                note: "",
            };
        }
        return {
            ...base,
            id: rec._id,
            status: rec.status,
            source: rec.source,
            checkIn: rec.checkIn,
            checkOut: rec.checkOut,
            deviceMarkedPresent: rec.deviceMarkedPresent,
            deviceMarkedAt: rec.deviceMarkedAt,
            markedBy: rec.markedBy
                ? { id: rec.markedBy._id, fullName: rec.markedBy.fullName }
                : null,
            note: rec.note || "",
        };
    });

    return { date: today, employees: rows };
}

// -------------------------------------------------------------------
// POST /attendance/mark  (bulk upsert)
// -------------------------------------------------------------------
export async function markAttendance(userId, body) {
    const workspace = await getWorkspaceOrThrow(userId);

    const results = [];
    const errors = [];

    for (const entry of body.records) {
        try {
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
            if (entry.checkIn !== undefined) {
                set.checkIn = entry.checkIn ? new Date(entry.checkIn) : null;
            }
            if (entry.checkOut !== undefined) {
                set.checkOut = entry.checkOut ? new Date(entry.checkOut) : null;
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
// Rollup — writes absent/weekend/holiday for past days
// -------------------------------------------------------------------
export async function rollupWorkspace(workspace, dates) {
    const { _id: workspaceId, attendance } = workspace;
    const weekendDays = attendance?.weekendDays ?? [0, 6];
    const holidays = attendance?.holidays ?? [];

    const holidayDates = new Set(holidays.map((h) => h.date));

    // All employees in the workspace
    const employees = await Employee.find({ workspace: workspaceId })
        .select("_id")
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

        const status = isHoliday ? "holiday" : weekend ? "weekend" : "absent";

        // Bulk write for everyone who doesn't have a record
        const ops = [];
        for (const emp of employees) {
            if (have.has(emp._id.toString())) continue;
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
                            note: "",
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
    if (!workspace.attendance?.autoMarkAbsent) {
        return { skipped: true, reason: "autoMarkAbsent disabled" };
    }

    const today = getDateInTimezone(new Date(), workspace.timezone);
    const dates = days ?? getRollupDates(today, ROLLUP_LOOKBACK_DAYS);

    const result = await rollupWorkspace(workspace, dates);

    workspace.attendance.lastRollupDate = dates[dates.length - 1];
    await workspace.save();

    return { skipped: false, ...result, dates };
}

/**
 * Walk all workspaces, run rollup for any whose local midnight just passed.
 * Called by the hourly cron.
 */
export async function runHourlyRollupSweep() {
    const workspaces = await Workspace.find({
        "attendance.autoMarkAbsent": true,
    }).lean();

    let workspacesProcessed = 0;

    for (const ws of workspaces) {
        const today = getDateInTimezone(new Date(), ws.timezone);
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

    return { workspacesProcessed, totalWorkspaces: workspaces.length };
}