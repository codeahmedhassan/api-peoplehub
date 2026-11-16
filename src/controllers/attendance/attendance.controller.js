// src/controllers/attendance/attendance.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    listAttendance,
    getAttendanceSummary,
    getTodayAttendance,
    markAttendance,
    triggerRollupForWorkspace,
    clockInEmployee,
    clockOutEmployee,
    getClockStatus,
} from "../../services/attendance/attendance.service.js";
import {
    exportAttendanceCsv,
    exportAttendanceXlsx,
} from "../../services/attendance/attendance-export.service.js";
import { Workspace } from "../../model/workspace/workspace.model.js";

export const listAttendanceController = asyncHandler(async (req, res) => {
    const data = await listAttendance(req.userId, req.validatedQuery ?? req.query);
    return res.status(200).json(new ApiResponse(200, data, "Attendance list"));
});

export const summaryController = asyncHandler(async (req, res) => {
    const data = await getAttendanceSummary(req.userId, req.validatedQuery ?? req.query);
    return res.status(200).json(new ApiResponse(200, data, "Attendance summary"));
});

export const todayController = asyncHandler(async (req, res) => {
    const clientDate = typeof req.query?.date === "string" ? req.query.date.trim() : null;
    const data = await getTodayAttendance(req.userId, clientDate);
    return res.status(200).json(new ApiResponse(200, data, "Today attendance"));
});

export const markAttendanceController = asyncHandler(async (req, res) => {
    const { results, errors } = await markAttendance(req.userId, req.body);
    if (results.length === 0 && errors.length > 0) {
        throw ApiError.badRequest(errors[0].message || "Failed to mark attendance.");
    }
    return res.status(200).json(
        new ApiResponse(
            200,
            { results, errors },
            errors.length > 0
                ? `${results.length} marked, ${errors.length} failed`
                : `${results.length} marked`
        )
    );
});

export const exportController = asyncHandler(async (req, res) => {
    const q = req.validatedQuery ?? req.query;
    const format = q.format === "xlsx" ? "xlsx" : "csv";
    const filename = `attendance-${q.from}-to-${q.to}.${format}`;

    if (format === "xlsx") {
        const buf = await exportAttendanceXlsx(req.userId, q);
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        return res.send(buf);
    }

    const buf = await exportAttendanceCsv(req.userId, q);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buf);
});

export const rollupController = asyncHandler(async (req, res) => {
    const workspace = await Workspace.findOne({ owner: req.userId });
    if (!workspace) {
        return res.status(403).json(new ApiResponse(403, null, "No workspace found"));
    }
    const result = await triggerRollupForWorkspace(workspace);
    return res.status(200).json(new ApiResponse(200, result, "Rollup run"));
});

export const clockInController = asyncHandler(async (req, res) => {
    return res.status(400).json(
        new ApiResponse(
            400,
            null,
            "Web-based clock-in is disabled. Employees can only mark attendance from biometric devices, or HR can manually mark attendance."
        )
    );
});

export const clockOutController = asyncHandler(async (req, res) => {
    return res.status(400).json(
        new ApiResponse(
            400,
            null,
            "Web-based clock-out is disabled. Employees can only mark attendance from biometric devices, or HR can manually mark attendance."
        )
    );
});

export const clockStatusController = asyncHandler(async (req, res) => {
    const targetEmployeeId = req.query?.employeeId || null;
    const result = await getClockStatus(req.userId, targetEmployeeId);
    return res.status(200).json(new ApiResponse(200, result, "Clock status loaded"));
});