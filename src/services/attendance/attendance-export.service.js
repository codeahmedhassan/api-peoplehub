// src/services/attendance/attendance-export.service.js
import XLSX from "xlsx";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { getCallerRoleContext, buildManagerDirectReportsMongoFilter } from "../employee/employee.service.js";

/**
 * Build the list of rows for export. Does not paginate.
 */
async function buildRows(workspace, query, userId = null) {
    const filter = { workspace: workspace._id };
    if (query.from && query.to) {
        filter.date = { $gte: query.from, $lte: query.to };
    }
    if (query.status) filter.status = query.status;

    if (userId) {
        const { caller, callerEmployee, isManager } = await getCallerRoleContext(userId, workspace);
        if (isManager) {
            const teamFilter = buildManagerDirectReportsMongoFilter(workspace._id, caller, callerEmployee, { includeSelf: true });
            const teamEmployees = await Employee.find(teamFilter).select("_id").lean();
            filter.employee = { $in: teamEmployees.map((e) => e._id) };
        }
    }

    let records = await AttendanceRecord.find(filter)
        .populate("employee", "firstName lastName employeeId department designation")
        .populate("markedBy", "fullName")
        .sort({ date: -1, createdAt: -1 })
        .lean();

    if (query.department) {
        records = records.filter(
            (r) => r.employee && r.employee.department === query.department
        );
    }
    if (query.q) {
        const q = query.q.toLowerCase();
        records = records.filter((r) => {
            const emp = r.employee || {};
            const hay = `${emp.firstName ?? ""} ${emp.lastName ?? ""} ${emp.employeeId ?? ""}`.toLowerCase();
            return hay.includes(q);
        });
    }

    return records.map((r) => {
        const emp = r.employee || {};
        const markedBy = r.markedBy ? r.markedBy.fullName : "";
        return {
            Date: r.date,
            EmployeeID: emp.employeeId ?? "",
            Name: `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim(),
            Department: emp.department ?? "",
            Designation: emp.designation ?? "",
            Status: r.status,
            Source: r.source,
            CheckIn: r.checkIn ? new Date(r.checkIn).toISOString() : "",
            CheckOut: r.checkOut ? new Date(r.checkOut).toISOString() : "",
            DeviceMarkedPresent: r.deviceMarkedPresent ? "yes" : "",
            MarkedBy: markedBy,
            Note: r.note ?? "",
        };
    });
}

/**
 * CSV export (returns a Buffer of UTF-8 CSV with BOM for Excel compatibility).
 */
export async function exportAttendanceCsv(userId, query) {
    const workspace = await getWorkspaceOrThrow(userId);
    const rows = await buildRows(workspace, query, userId);

    const headers = Object.keys(
        rows[0] ?? {
            Date: "", EmployeeID: "", Name: "", Department: "", Designation: "",
            Status: "", Source: "", CheckIn: "", CheckOut: "",
            DeviceMarkedPresent: "", MarkedBy: "", Note: "",
        }
    );

    const escape = (v) => {
        const s = String(v ?? "");
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };

    const lines = [headers.join(",")];
    for (const row of rows) {
        lines.push(headers.map((h) => escape(row[h])).join(","));
    }

    // UTF-8 BOM so Excel opens it correctly.
    return Buffer.from("\uFEFF" + lines.join("\n"), "utf8");
}

/**
 * XLSX export (returns a Buffer).
 */
export async function exportAttendanceXlsx(userId, query) {
    const workspace = await getWorkspaceOrThrow(userId);
    const rows = await buildRows(workspace, query, userId);

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendance");

    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}