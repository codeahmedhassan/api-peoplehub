// src/controllers/leave/leave.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    getLeaveSummary,
    listLeaveRequests,
    createLeaveRequest,
    forwardLeaveRequestByManager,
    rejectLeaveRequestByManager,
    reviewLeaveRequest,
    resubmitLeaveRequest,
    getEmployeeLeaveHistoryAndBalance,
    getLeaveCalendar,
    getAttendanceCheckForLeave,
    cancelLeaveRequest,
    getTeamMembersForManager,
    getLeaveTypesCatalog,
    addCustomLeaveType,
    deleteCustomLeaveType,
} from "../../services/leave/leave.service.js";

export const getLeaveSummaryController = asyncHandler(async (req, res) => {
    const data = await getLeaveSummary(req.userId);
    return res.status(200).json(new ApiResponse(200, data, "Leave summary"));
});

export const listLeaveRequestsController = asyncHandler(async (req, res) => {
    const data = await listLeaveRequests(req.userId, req.query);
    return res.status(200).json(new ApiResponse(200, data, "Leave requests list"));
});

export const createLeaveRequestController = asyncHandler(async (req, res) => {
    const data = await createLeaveRequest(req.userId, req.body);
    return res
        .status(201)
        .json(new ApiResponse(201, { request: data }, "Leave request submitted successfully"));
});

export const forwardLeaveRequestController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await forwardLeaveRequestByManager(req.userId, id, req.body);
    return res
        .status(200)
        .json(new ApiResponse(200, { request: data }, "Leave request verified and forwarded to HR"));
});

export const managerRejectLeaveRequestController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await rejectLeaveRequestByManager(req.userId, id, req.body);
    return res
        .status(200)
        .json(new ApiResponse(200, { request: data }, "Leave request declined by manager"));
});

export const reviewLeaveRequestController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, reviewerComments } = req.body;
    const data = await reviewLeaveRequest(req.userId, id, { status, reviewerComments });
    return res
        .status(200)
        .json(new ApiResponse(200, { request: data }, `Leave request ${status} successfully`));
});

export const resubmitLeaveRequestController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await resubmitLeaveRequest(req.userId, id, req.body);
    return res
        .status(201)
        .json(new ApiResponse(201, { request: data }, "Leave request re-submitted successfully"));
});

export const getEmployeeLeaveHistoryController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await getEmployeeLeaveHistoryAndBalance(req.userId, id);
    return res.status(200).json(new ApiResponse(200, data, "Employee leave history and balance"));
});

export const getLeaveCalendarController = asyncHandler(async (req, res) => {
    const { month } = req.query;
    const data = await getLeaveCalendar(req.userId, month);
    return res.status(200).json(new ApiResponse(200, data, "Leave calendar data"));
});

export const getAttendanceCheckController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await getAttendanceCheckForLeave(req.userId, id);
    return res.status(200).json(new ApiResponse(200, data, "Attendance marking verification"));
});

export const cancelLeaveRequestController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const data = await cancelLeaveRequest(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, { request: data }, "Leave request cancelled"));
});

export const cancelApprovedLeaveController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason, selectedDates, cancelAll } = req.body || {};
    const { cancelApprovedLeave } = await import("../../services/leave/leave.service.js");
    const data = await cancelApprovedLeave(req.userId, id, { reason, selectedDates, cancelAll });
    return res
        .status(200)
        .json(new ApiResponse(200, { request: data }, "Approved leave cancelled successfully and days refunded"));
});

export const requestLeaveCancellationController = asyncHandler(async (req, res) => {
    const { leaveId, reason, selectedDates, cancelAll } = req.body || {};
    const { requestLeaveCancellation } = await import("../../services/leave/leave.service.js");
    const result = await requestLeaveCancellation(req.userId, { leaveId, reason, selectedDates, cancelAll });
    return res
        .status(201)
        .json(new ApiResponse(201, result, "Leave cancellation request submitted to HR"));
});

export const getTeamMembersController = asyncHandler(async (req, res) => {
    const data = await getTeamMembersForManager(req.userId);
    return res.status(200).json(new ApiResponse(200, { team: data }, "Team members list"));
});

export const getLeaveTypesCatalogController = asyncHandler(async (req, res) => {
    const data = await getLeaveTypesCatalog(req.userId);
    return res.status(200).json(new ApiResponse(200, data, "Leave types catalog"));
});

export const addCustomLeaveTypeController = asyncHandler(async (req, res) => {
    const data = await addCustomLeaveType(req.userId, req.body);
    return res.status(201).json(new ApiResponse(201, data, "Custom leave type created successfully"));
});

export const deleteCustomLeaveTypeController = asyncHandler(async (req, res) => {
    const { key } = req.params;
    const data = await deleteCustomLeaveType(req.userId, key);
    return res.status(200).json(new ApiResponse(200, data, "Custom leave type deleted successfully"));
});
