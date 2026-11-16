// src/controllers/notification/notification.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    getUserNotifications,
    markNotificationAsRead,
    markAllNotificationsAsRead,
} from "../../services/notification/notification.service.js";

export const getMyNotificationsController = asyncHandler(async (req, res) => {
    const result = await getUserNotifications(req.userId);
    return res
        .status(200)
        .json(new ApiResponse(200, result, "Notifications loaded"));
});

export const markAsReadController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await markNotificationAsRead(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, result, "Notification marked as read"));
});

export const markAllAsReadController = asyncHandler(async (req, res) => {
    const result = await markAllNotificationsAsRead(req.userId);
    return res
        .status(200)
        .json(new ApiResponse(200, result, "All notifications marked as read"));
});
