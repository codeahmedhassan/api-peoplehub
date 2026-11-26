import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    loginSuperAdmin,
    verifySuperAdmin2FA,
    resendSuperAdmin2FA,
    logoutSuperAdmin,
    setSuperAdminCookies,
    clearSuperAdminCookies,
    getSuperAdminWorkspaces,
    approveWorkspace,
    rejectWorkspace,
    updateWorkspacePlanBySuperAdmin,
    sendWorkspacePaymentFollowUp,
    revokeWorkspaceAccess,
    restoreWorkspaceAccess,
    getSuperAdminAuditLogs,
} from "../../services/superAdmin/superAdmin.service.js";

export const loginSuperAdminController = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const result = await loginSuperAdmin({ email, password, req });
    return res.status(200).json(
        new ApiResponse(200, result, "Two-factor authorization code sent to your registered email")
    );
});

export const verifySuperAdmin2FAController = asyncHandler(async (req, res) => {
    const { tempToken, code } = req.body;
    const { superAdmin, accessToken, refreshToken } = await verifySuperAdmin2FA({
        tempToken,
        code,
        req,
    });

    setSuperAdminCookies(res, { accessToken, refreshToken });

    return res.status(200).json(
        new ApiResponse(
            200,
            { superAdmin },
            "Super Admin authentication verified successfully"
        )
    );
});

export const resendSuperAdmin2FAController = asyncHandler(async (req, res) => {
    const { tempToken } = req.body;
    const result = await resendSuperAdmin2FA({ tempToken, req });
    return res.status(200).json(new ApiResponse(200, result, result.message));
});

export const superAdminMeController = asyncHandler(async (req, res) => {
    return res.status(200).json(
        new ApiResponse(200, { superAdmin: req.superAdmin.toSafeJSON() }, "Session active")
    );
});

export const logoutSuperAdminController = asyncHandler(async (req, res) => {
    await logoutSuperAdmin(req.superAdminId, req);
    clearSuperAdminCookies(res);
    return res.status(200).json(new ApiResponse(200, null, "Super Admin logged out"));
});

export const getWorkspacesController = asyncHandler(async (req, res) => {
    const { status, search, page, limit } = req.query;
    const result = await getSuperAdminWorkspaces({
        status,
        search,
        page: Number(page) || 1,
        limit: Number(limit) || 50,
    });
    return res.status(200).json(new ApiResponse(200, result, "Workspaces retrieved"));
});

export const approveWorkspaceController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await approveWorkspace({
        workspaceId: id,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(new ApiResponse(200, result, "Workspace approved successfully"));
});

export const rejectWorkspaceController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await rejectWorkspace({
        workspaceId: id,
        reason,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(new ApiResponse(200, result, "Workspace rejected and email sent to owner"));
});

export const updateWorkspacePlanController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { plan, notes } = req.body;
    const result = await updateWorkspacePlanBySuperAdmin({
        workspaceId: id,
        plan,
        notes,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            `Workspace plan updated to ${result?.usage?.planName || plan}`
        )
    );
});

export const getAuditLogsController = asyncHandler(async (req, res) => {
    const { limit } = req.query;
    const logs = await getSuperAdminAuditLogs({ limit: Number(limit) || 100 });
    return res.status(200).json(new ApiResponse(200, { logs }, "Audit logs retrieved"));
});

export const sendPaymentFollowUpController = asyncHandler(async (req, res) => {
    const { step } = req.body;
    const data = await sendWorkspacePaymentFollowUp({
        workspaceId: req.params.id,
        step,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(new ApiResponse(200, data, `Payment follow-up #${Number(step)} sent`));
});

export const revokeWorkspaceAccessController = asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const data = await revokeWorkspaceAccess({
        workspaceId: req.params.id,
        reason,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(new ApiResponse(200, data, "Organization access revoked (data preserved)"));
});

export const restoreWorkspaceAccessController = asyncHandler(async (req, res) => {
    const { markPaid = true, notes = "" } = req.body || {};
    const data = await restoreWorkspaceAccess({
        workspaceId: req.params.id,
        markPaid,
        notes,
        superAdminId: req.superAdminId,
        req,
    });
    return res.status(200).json(new ApiResponse(200, data, "Organization billing settled and access active"));
});
