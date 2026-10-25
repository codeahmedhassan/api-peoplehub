// src/controllers/attendance/attendance.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    listAttendance,
    getAttendanceSummary,
    getTodayAttendance,
    markAttendance,
    triggerRollupForWorkspace,
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
    const data = await getTodayAttendance(req.userId);
    return res.status(200).json(new ApiResponse(200, data, "Today attendance"));
});

export const markAttendanceController = asyncHandler(async (req, res) => {
    const { results, errors } = await markAttendance(req.userId, req.body);
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