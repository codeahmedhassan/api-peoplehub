// src/controllers/performance/performance.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    getManagerDirectReports,
    getPerformanceDashboardData,
    getEmployeeAppraisalDetails,
    submitEmployeeAppraisal,
} from "../../services/performance/performance.service.js";

export const getMyTeamController = asyncHandler(async (req, res) => {
    const data = await getManagerDirectReports(req.userId);
    return res.status(200).json(new ApiResponse(200, data, "My team direct reports loaded"));
});

export const getPerformanceDashboardController = asyncHandler(async (req, res) => {
    const data = await getPerformanceDashboardData(req.userId);
    return res.status(200).json(new ApiResponse(200, data, "Performance dashboard loaded"));
});

export const getEmployeeAppraisalDetailsController = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const data = await getEmployeeAppraisalDetails(req.userId, employeeId);
    return res.status(200).json(new ApiResponse(200, data, "Employee appraisal details loaded"));
});

export const submitEmployeeAppraisalController = asyncHandler(async (req, res) => {
    const { employeeId } = req.params;
    const appraisal = await submitEmployeeAppraisal(req.userId, employeeId, req.body);
    return res.status(200).json(new ApiResponse(200, appraisal, "Appraisal evaluation submitted successfully"));
});
