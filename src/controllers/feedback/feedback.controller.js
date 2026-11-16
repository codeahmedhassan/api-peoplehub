import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    createFeedback,
    getMyFeedbacks,
    listFeedbacksForSuperAdmin,
    updateFeedbackStatus,
} from "../../services/feedback/feedback.service.js";

export const createFeedbackController = asyncHandler(async (req, res) => {
    const feedback = await createFeedback(req.userId, req.body, req);
    return res.status(201).json(
        new ApiResponse(201, { feedback }, "Your feedback/report has been submitted successfully")
    );
});

export const getMyFeedbacksController = asyncHandler(async (req, res) => {
    const feedbacks = await getMyFeedbacks(req.userId);
    return res.status(200).json(
        new ApiResponse(200, { feedbacks }, "User feedback list retrieved successfully")
    );
});

export const superAdminListFeedbacksController = asyncHandler(async (req, res) => {
    const { type, status, search, page, limit } = req.query;
    const result = await listFeedbacksForSuperAdmin({
        type,
        status,
        search,
        page: Number(page) || 1,
        limit: Number(limit) || 50,
    });
    return res.status(200).json(
        new ApiResponse(200, result, "Feedback items retrieved for Super Admin")
    );
});

export const superAdminUpdateFeedbackController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { status, adminNotes } = req.body;
    const feedback = await updateFeedbackStatus({
        feedbackId: id,
        status,
        adminNotes,
        superAdminId: req.superAdminId,
    });
    return res.status(200).json(
        new ApiResponse(200, { feedback }, "Feedback status updated successfully")
    );
});
