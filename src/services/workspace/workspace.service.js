// src/services/workspace/workspace.service.js
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";

export async function setupWorkspace(userId, payload) {
    const { company, teamSize, theme } = payload;

    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User no longer exists");
    if (!user.emailVerified) throw ApiError.forbidden("Email not verified");

    const workspace = await Workspace.findOneAndUpdate(
        { owner: userId },
        {
            $set: {
                owner: userId,
                companyName: company.name,
                industry: company.industry,
                timezone: company.timezone,
                teamSize,
                theme,
                setupCompletedAt: new Date(),
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (!user.setupCompletedAt) {
        user.setupCompletedAt = new Date();
        await user.save();
    }

    return workspace;
}

export async function getWorkspaceForUser(userId) {
    const user = await User.findById(userId);
    if (!user) return null;

    // 1. Check if they own a workspace
    const ownedWorkspace = await Workspace.findOne({ owner: userId });
    if (ownedWorkspace) return ownedWorkspace;

    // 2. Check if they are an employee linked to a workspace
    if (user.workspaceId) {
        return await Workspace.findById(user.workspaceId);
    }

    return null;
}

export async function updateAttendanceSettings(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);

    if (patch.autoMarkAbsent !== undefined) {
        workspace.attendance.autoMarkAbsent = patch.autoMarkAbsent;
    }
    if (patch.weekendDays !== undefined) {
        workspace.attendance.weekendDays = patch.weekendDays;
    }
    if (patch.holidays !== undefined) {
        workspace.attendance.holidays = patch.holidays;
    }

    await workspace.save();
    return workspace;
}

export async function getWorkspaceOrThrow(userId) {
    const workspace = await getWorkspaceForUser(userId);
    if (!workspace) {
        throw ApiError.forbidden("No workspace found");
    }
    return workspace;
}