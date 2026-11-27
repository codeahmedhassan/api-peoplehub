// src/middleware/auth/auth.middleware.js
import { ApiError } from "../../utils/ApiError.js";
import { verifyAccessToken } from "../../utils/tokens.js";
import { verifySignupPendingToken } from "../../utils/signupToken.js";
import { COOKIE_NAMES } from "../../constants/index.js";
import { User } from "../../model/auth/auth.model.js";
import { refreshSession, assertUserWorkspaceNotRevoked } from "../../services/auth/auth.service.js";
import { setAuthCookies, clearAuthCookies } from "../../utils/cookies.js";

export async function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
    const refreshToken = req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN];

    if (token) {
        try {
            const decoded = verifyAccessToken(token);
            await assertUserWorkspaceNotRevoked(decoded.sub);
            req.userId = decoded.sub;
            req.tokenVersion = decoded.ver ?? 0;
            req.sessionId = decoded.sid ?? null;
            return next();
        } catch (err) {
            if (err?.code === "WORKSPACE_ACCESS_REVOKED") {
                clearAuthCookies(res);
                return next(err);
            }
            // Access token expired; fall through to silent refresh via refresh token
        }
    }

    if (refreshToken) {
        try {
            const { accessToken: newAccessToken, refreshToken: newRefreshToken, user, rememberMe } = await refreshSession(refreshToken);
            setAuthCookies(res, { accessToken: newAccessToken, refreshToken: newRefreshToken, rememberMe });
            req.userId = user._id.toString();
            req.tokenVersion = user.tokenVersion ?? 0;
            req.sessionId = null;
            return next();
        } catch (err) {
            clearAuthCookies(res);
            if (err?.code === "WORKSPACE_ACCESS_REVOKED") {
                return next(err);
            }
            return next(ApiError.unauthorized("Session expired"));
        }
    }

    return next(ApiError.unauthorized("Not authenticated"));
}

export function requirePendingSignup(req, _res, next) {
    const token = req.cookies?.[COOKIE_NAMES.SIGNUP_PENDING];
    if (!token) return next(ApiError.unauthorized("No pending signup"));

    try {
        const decoded = verifySignupPendingToken(token);
        req.pendingUserId = decoded.sub;
        req.pendingEmail = decoded.email;
        return next();
    } catch {
        return next(ApiError.unauthorized("Signup session expired"));
    }
}

export async function requireVerifiedUser(req, res, next) {
    // Must be used after requireAuth
    try {
        const user = await User.findById(req.userId);
        if (!user) return next(ApiError.unauthorized("User no longer exists"));
        if (!user.emailVerified) {
            return next(ApiError.forbidden("Email not verified"));
        }
        if (user.status === "inactive" || user.status === "suspended") {
            return next(ApiError.forbidden("Your account has been deactivated or suspended"));
        }
        if (req.tokenVersion !== undefined && (req.tokenVersion ?? 0) !== (user.tokenVersion ?? 0)) {
            return next(ApiError.unauthorized("Session revoked"));
        }
        req.user = user;
        return next();
    } catch (err) {
        return next(err);
    }
}

/**
 * Evaluates whether a user satisfies a single module/action permission check.
 */
async function evaluateModulePermission({ module, action, isCEO, permissions, effectiveRole, emp, workspace }) {
    if (module === "auditLogs") {
        const { resolvePlanConfig } = await import("../../services/workspace/plan.service.js");
        if (!resolvePlanConfig(workspace?.subscription).features?.auditLogs) {
            return false;
        }
    }

    if (isCEO) return true;

    // If user has explicit permissions object for this module
    if (permissions && typeof permissions === "object" && permissions[module] && typeof permissions[module] === "object") {
        if (permissions[module][action] !== undefined) {
            return Boolean(permissions[module][action]);
        }
        if (action === "view" && permissions[module].view !== undefined) {
            return Boolean(permissions[module].view);
        }
        return false;
    }

    // Fallback to role presets:
    // HR preset
    const isHRPreset = /hr/.test(effectiveRole) || /hr|human resource/i.test(emp?.designation || "") || /hr|human resource/i.test(emp?.department || "");
    if (isHRPreset) {
        return true;
    }

    // Manager preset
    if (/manager/.test(effectiveRole)) {
        if (module === "dashboard" && action === "view") return true;
        if (module === "employees" && action === "view") return true;
        if (module === "attendance" && (action === "view" || action === "export")) return true;
        if (module === "leave" && (action === "view" || action === "create" || action === "approve")) return true;
        if (module === "performance") return true;
        if (module === "documents" && (action === "view" || action === "upload")) return true;
    }

    // Viewer preset
    if (/viewer/.test(effectiveRole)) {
        if (action === "view" && module !== "auditLogs" && module !== "devices") return true;
    }

    // Employee self-service
    if (module === "dashboard" && action === "view") return true;
    if (module === "attendance" && action === "view") return true;
    if (module === "leave" && (action === "view" || action === "create")) return true;

    return false;
}

/**
 * Enforces dynamic role- and permission-based authorization on API endpoints.
 * Allows access if the authenticated user satisfies ANY of the [module, action] checks.
 * - CEO / Workspace Owner: Unrestricted full system access.
 * - Custom / Explicit permissions: Follows permissions matrix for module & action.
 * - Standard role presets: Fallback based on effective role.
 */
export function requireAnyPermission(checks = []) {
    return async function (req, res, next) {
        try {
            if (!req.userId) {
                return next(ApiError.unauthorized("Not authenticated"));
            }

            const user = await User.findById(req.userId).lean();
            if (!user) {
                return next(ApiError.unauthorized("User no longer exists"));
            }

            const { getWorkspaceForUser } = await import("../../services/workspace/workspace.service.js");
            const workspace = await getWorkspaceForUser(user._id);

            const isOwner = Boolean(workspace && workspace.owner && workspace.owner.toString() === user._id.toString());
            const roleStr = String(user.role || "").toLowerCase().trim();
            const systemRoleStr = String(user.systemRole || "").toLowerCase().trim();
            const isCEO = Boolean(
                isOwner ||
                /ceo|founder|administrator|admin/.test(roleStr) ||
                systemRoleStr === "admin"
            );

            // Fast-path CEO unless auditLogs plan gating applies
            const hasAuditCheck = checks.some(([m]) => m === "auditLogs");
            if (isCEO && !hasAuditCheck) {
                req.user = user;
                req.isCEO = true;
                return next();
            }

            const { Employee } = await import("../../model/employee/employee.model.js");
            let emp = null;
            if (workspace) {
                emp = await Employee.findOne({
                    workspace: workspace._id,
                    $or: [
                        { linkedUser: user._id },
                        { loginEmail: user.email?.toLowerCase() },
                        { personalEmail: user.email?.toLowerCase() },
                    ],
                }).select("permissions systemRole designation department").lean();
            }

            const permissions = (emp?.permissions && Object.keys(emp.permissions).length > 0) ? emp.permissions : (user.permissions || {});
            const effectiveRole = String(emp?.systemRole || user.systemRole || user.role || "Employee").toLowerCase().trim();

            for (const [module, action = "view"] of checks) {
                const allowed = await evaluateModulePermission({
                    module,
                    action,
                    isCEO,
                    permissions,
                    effectiveRole,
                    emp,
                    workspace,
                });
                if (allowed) {
                    req.user = user;
                    if (isCEO) req.isCEO = true;
                    return next();
                }
            }

            return next(ApiError.forbidden("You don't have permission to access that resource"));
        } catch (err) {
            return next(err);
        }
    };
}

/**
 * Single module/action permission guard.
 */
export function requirePermission(module, action = "view") {
    return requireAnyPermission([[module, action]]);
}