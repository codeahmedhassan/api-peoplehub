// src/controllers/workspace/workspace.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    setupWorkspace,
    getWorkspaceForUser,
    updateAttendanceSettings,
    getWorkspaceOrThrow
} from "../../services/workspace/workspace.service.js";

export const setupWorkspaceController = asyncHandler(async (req, res) => {
    const workspace = await setupWorkspace(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Workspace setup complete"
            )
        );
});

export const getMyWorkspaceController = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceForUser(req.userId);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace ? workspace.toSafeJSON() : null },
                workspace ? "Workspace loaded" : "No workspace yet"
            )
        );
});

export const updateAttendanceSettingsController = asyncHandler(async (req, res) => {
    const workspace = await updateAttendanceSettings(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Attendance settings updated"
            )
        );
});