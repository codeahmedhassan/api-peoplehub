import { User } from "../../model/auth/auth.model.js";
// src/controllers/workspace/workspace.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    setupWorkspace,
    getWorkspaceForUser,
    updateAttendanceSettings,
    updateCompanyProfile,
    updateFinancialSettings,
    updateWorkspaceModules,
    updatePayslipSettings,
    updateWorkspaceIntegrations,
    getWorkspaceUsers,
    updateUserRole,
    getEmployeeIdSettings,
    updateEmployeeIdSettings,
    appointCeo,
    checkWorkspaceHasHR,
    updateCeoOverrideSetting,
    transferCeoAndExit,
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
    const user = await User.findById(req.userId).lean();
    const isOwner = Boolean(
        workspace && workspace.owner && workspace.owner.toString() === req.userId.toString()
    );
    const isCallerCeo = Boolean(
        isOwner || user?.role === "Founder / CEO" || user?.role === "Administrator"
    );

    let hasHR = false;
    let canManageAsCEO = false;
    let linkedEmployee = null;
    if (workspace) {
        hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        // Only the actual CEO / Owner has canManageAsCEO
        canManageAsCEO = isCallerCeo && (!hasHR || (workspace.ceoFullControlWithHr !== undefined ? Boolean(workspace.ceoFullControlWithHr) : true));
        if (user) {
            const { Employee } = await import("../../model/employee/employee.model.js");
            linkedEmployee = await Employee.findOne({
                workspace: workspace._id,
                $or: [
                    { linkedUser: user._id },
                    { loginEmail: user.email?.toLowerCase() },
                    { personalEmail: user.email?.toLowerCase() },
                ],
            }).select("designation department systemRole permissions").lean();
        }
    }

    const isHR = !isCallerCeo && Boolean(
        user?.role === "HR" ||
        user?.systemRole === "HR" ||
        linkedEmployee?.systemRole === "HR" ||
        /hr|human resource/i.test(linkedEmployee?.designation || "") ||
        /hr|human resource/i.test(linkedEmployee?.department || "")
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                workspace: workspace ? workspace.toSafeJSON() : null,
                isOwner,
                isFounder: isCallerCeo,
                isCEO: isCallerCeo,
                isHR,
                hasHR,
                canManageAsCEO,
                userRole: user?.role,
                userSystemRole: linkedEmployee?.systemRole || user?.systemRole,
                userDesignation: linkedEmployee?.designation || "",
                userDepartment: linkedEmployee?.department || "",
                userPermissions: linkedEmployee?.permissions || user?.permissions || {},
            },
            workspace ? "Workspace loaded" : "No workspace yet"
        )
    );
});

export const updateCeoOverrideController = asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    const workspace = await updateCeoOverrideSetting(req.userId, enabled);
    return res.status(200).json(
        new ApiResponse(
            200,
            { workspace: workspace.toSafeJSON() },
            "CEO full control override updated"
        )
    );
});

export const updateCompanyController = asyncHandler(async (req, res) => {
    const workspace = await updateCompanyProfile(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Company profile updated"
            )
        );
});

export const updateFinancialController = asyncHandler(async (req, res) => {
    const workspace = await updateFinancialSettings(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Financial settings updated"
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

export const updateModulesController = asyncHandler(async (req, res) => {
    const modules = req.body.modules || req.body;
    const workspace = await updateWorkspaceModules(req.userId, modules);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Workspace modules updated"
            )
        );
});

export const updatePayslipSettingsController = asyncHandler(async (req, res) => {
    const workspace = await updatePayslipSettings(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Payslip settings updated"
            )
        );
});

export const updateIntegrationsController = asyncHandler(async (req, res) => {
    const workspace = await updateWorkspaceIntegrations(req.userId, req.body);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { workspace: workspace.toSafeJSON() },
                "Integrations updated"
            )
        );
});

export const getWorkspaceUsersController = asyncHandler(async (req, res) => {
    const users = await getWorkspaceUsers(req.userId);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { users },
                "Workspace users loaded"
            )
        );
});

export const updateUserRoleController = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { role } = req.body;
    const result = await updateUserRole(req.userId, userId, role);
    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                result,
                "User role updated successfully"
            )
        );
});

export const getEmployeeIdSettingsController = asyncHandler(async (req, res) => {
    const data = await getEmployeeIdSettings(req.userId);
    return res.status(200).json(
        new ApiResponse(200, data, "Employee ID settings loaded")
    );
});

export const updateEmployeeIdSettingsController = asyncHandler(async (req, res) => {
    const data = await updateEmployeeIdSettings(req.userId, req.body);
    return res.status(200).json(
        new ApiResponse(200, data, "Employee ID settings updated successfully")
    );
});

export const appointCeoController = asyncHandler(async (req, res) => {
    const { targetUserId } = req.body;
    const result = await appointCeo(req.userId, targetUserId);
    return res.status(200).json(
        new ApiResponse(200, result, "CEO appointed successfully")
    );
});

export const replaceCeoController = asyncHandler(async (req, res) => {
    const { targetEmployeeId } = req.body;
    const result = await transferCeoAndExit(req.userId, targetEmployeeId);
    return res.status(200).json(
        new ApiResponse(200, result, result.message)
    );
});
