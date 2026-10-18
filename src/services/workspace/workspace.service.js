// src/services/workspace/workspace.service.js
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";

/**
 * Upsert the workspace for the given user.
 * Also stamps user.setupCompletedAt on first completion.
 */
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
    const workspace = await Workspace.findOne({ owner: userId });
    return workspace || null;
}