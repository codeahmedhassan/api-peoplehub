import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    setAuthCookies,
    setSignupPendingCookie,
    clearSignupPendingCookie,
    clearAuthCookies,
    set2FAPendingCookie,
    clear2FAPendingCookie,
} from "../../utils/cookies.js";
import {
    registerUser,
    verifyEmail,
    resendVerificationForUser,
    getSessionUser,
    loginUser,
    refreshSession,
    verifyInviteDetails,
    acceptInvite,
    updateUserProfile,
    changeUserPassword,
    logoutAllDevices,
    updateNotificationPreferences,
    toggleTwoFactor,
    verifyTwoFactor,
    resendTwoFactor,
    requestPasswordReset,
    resetPasswordWithToken,
} from "../../services/auth/auth.service.js";
import {
    verifyAccessToken,
    createAccessToken,
    createRefreshToken,
    verify2FAPendingToken,
} from "../../utils/tokens.js";
import { COOKIE_NAMES } from "../../constants/index.js";
import { parseUserAgent, parseClientIp, maskEmail } from "../../utils/userAgent.js";
import { User } from "../../model/auth/auth.model.js";
import { eventEngine } from "../../services/observability/eventEngine.service.js";

export const signup = asyncHandler(async (req, res) => {
    const clientIpInfo = parseClientIp(req);
    const ipAddress = typeof clientIpInfo === "string" ? clientIpInfo : clientIpInfo?.ip || "";
    const { user, pendingToken } = await registerUser({ ...req.body, ipAddress });

    eventEngine.trackEvent({
        eventName: "user_signed_up",
        module: "auth",
        feature: "signup",
        organizationId: user.activeWorkspace || user._id,
        userId: user._id,
        requestId: req.id,
    });

    setSignupPendingCookie(res, pendingToken);

    return res.status(201).json(
        new ApiResponse(
            201,
            { user: user.toSafeJSON() },
            "Account created. Please check your email to verify your account."
        )
    );
});

export const verifyEmailController = asyncHandler(async (req, res) => {
    const { token } = req.body;
    const { user, accessToken, refreshToken } = await verifyEmail(token);

    setAuthCookies(res, { accessToken, refreshToken });
    clearSignupPendingCookie(res);

    return res.status(200).json(
        new ApiResponse(200, { user: user.toSafeJSON() }, "Email verified")
    );
});

export const resendVerificationController = asyncHandler(async (req, res) => {
    await resendVerificationForUser(req.pendingUserId);

    return res
        .status(200)
        .json(new ApiResponse(200, null, "Verification email resent"));
});

export const pendingSignupInfoController = asyncHandler(async (req, res) => {
    const user = await getSessionUser(req.pendingUserId);
    if (!user) {
        clearSignupPendingCookie(res);
        return res
            .status(404)
            .json(new ApiResponse(404, null, "Pending signup expired"));
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            {
                email: user.email,
                fullName: user.fullName,
            },
            "Pending signup info"
        )
    );
});

async function enrichUserWithWorkspace(user) {
    if (!user) return null;
    const safe = user.toSafeJSON();
    try {
        const { getWorkspaceForUser } = await import("../../services/workspace/workspace.service.js");
        const { resolvePlanConfig } = await import("../../services/workspace/plan.service.js");
        const ws = await getWorkspaceForUser(user._id);
        if (ws) {
            const planCfg = resolvePlanConfig(ws.subscription);
            safe.workspace = {
                id: ws._id.toString(),
                companyName: ws.companyName,
                verificationStatus: ws.verificationStatus || "approved",
                rejectionReason: ws.rejectionReason || "",
                verifiedAt: ws.verifiedAt || null,
                accessRevoked: Boolean(ws.accessRevoked),
                accessRevokedAt: ws.accessRevokedAt || null,
                accessRevokedReason: ws.accessRevokedReason || "",
                subscription: {
                    plan: planCfg.plan,
                    planName: planCfg.planName,
                    isPaid: Boolean(planCfg.isPaid),
                    features: planCfg.features || {},
                },
            };

            const isOwner = Boolean(ws.owner && ws.owner.toString() === user._id.toString());
            const roleStr = String(user.role || "").toLowerCase().trim();
            const systemRoleStr = String(user.systemRole || "").toLowerCase().trim();
            const isCEO = Boolean(
                isOwner ||
                /ceo|founder|administrator|admin/.test(roleStr) ||
                systemRoleStr === "admin"
            );

            safe.isOwner = isOwner;
            safe.isCEO = isCEO;

            // Dynamically merge linked Employee permissions & systemRole
            const { Employee } = await import("../../model/employee/employee.model.js");
            const emp = await Employee.findOne({
                workspace: ws._id,
                $or: [
                    { linkedUser: user._id },
                    { loginEmail: user.email?.toLowerCase() },
                    { personalEmail: user.email?.toLowerCase() },
                ],
            }).select("permissions systemRole designation department employeeId").lean();

            if (emp) {
                if (emp.permissions && Object.keys(emp.permissions).length > 0) {
                    safe.permissions = emp.permissions;
                }
                if (emp.systemRole) {
                    safe.systemRole = emp.systemRole;
                    safe.role = emp.systemRole;
                }
                if (emp.employeeId) safe.employeeId = emp.employeeId;
                if (emp.designation) safe.designation = emp.designation;
                if (emp.department) safe.department = emp.department;
            }
        }
    } catch {
        // non-fatal enrichment error
    }
    return safe;
}

export const meController = asyncHandler(async (req, res) => {
    const user = await getSessionUser(req.userId);
    const enriched = await enrichUserWithWorkspace(user);
    return res
        .status(200)
        .json(new ApiResponse(200, { user: enriched }, "Current user"));
});

export const sessionController = asyncHandler(async (req, res) => {
    const accessToken = req.cookies[COOKIE_NAMES.ACCESS_TOKEN];
    const refreshToken = req.cookies[COOKIE_NAMES.REFRESH_TOKEN];

    // 1. Try validating the access token first
    if (accessToken) {
        try {
            const payload = verifyAccessToken(accessToken);
            const user = await getSessionUser(payload.sub);

            if (!user || (payload.ver ?? 0) !== (user.tokenVersion ?? 0)) {
                clearAuthCookies(res);
                return res.status(200).json(
                    new ApiResponse(
                        200,
                        { authenticated: false, user: null },
                        "Session revoked"
                    )
                );
            }

            const enriched = await enrichUserWithWorkspace(user);
            return res.status(200).json(
                new ApiResponse(
                    200,
                    { authenticated: true, user: enriched },
                    "Session active"
                )
            );
        } catch {
            // Access token expired or invalid; fall through to refresh token verification
        }
    }

    // 2. If access token is expired or missing, check the refresh token!
    if (refreshToken) {
        try {
            const { user, accessToken: newAccessToken, refreshToken: newRefreshToken, rememberMe } = await refreshSession(refreshToken);
            setAuthCookies(res, { accessToken: newAccessToken, refreshToken: newRefreshToken, rememberMe });

            const enriched = await enrichUserWithWorkspace(user);
            return res.status(200).json(
                new ApiResponse(
                    200,
                    { authenticated: true, user: enriched },
                    "Session active (refreshed)"
                )
            );
        } catch {
            clearAuthCookies(res);
            return res.status(200).json(
                new ApiResponse(
                    200,
                    { authenticated: false, user: null },
                    "Session expired"
                )
            );
        }
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            { authenticated: false, user: null },
            "No active session"
        )
    );
});

export const refreshController = asyncHandler(async (req, res) => {
    const rawToken = req.cookies[COOKIE_NAMES.REFRESH_TOKEN];

    if (!rawToken) {
        clearAuthCookies(res);
        return res
            .status(401)
            .json(new ApiResponse(401, null, "No refresh token"));
    }

    const { user, accessToken, refreshToken, rememberMe } = await refreshSession(rawToken);

    setAuthCookies(res, { accessToken, refreshToken, rememberMe });

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                { user: user.toSafeJSON() },
                "Session refreshed"
            )
        );
});

export const logoutController = asyncHandler(async (req, res) => {
    if (req.userId) {
        eventEngine.trackEvent({
            eventName: "user_logged_out",
            module: "auth",
            feature: "logout",
            organizationId: req.user?.activeWorkspace || req.userId,
            userId: req.userId,
            requestId: req.id,
        });
    }

    clearAuthCookies(res);
    clearSignupPendingCookie(res);
    clear2FAPendingCookie(res);

    return res
        .status(200)
        .json(new ApiResponse(200, null, "Signed out successfully"));
});

export const loginController = asyncHandler(async (req, res) => {
    const { email, password, rememberMe } = req.body;
    const result = await loginUser({ email, password, req, rememberMe: Boolean(rememberMe) });

    if (result.requiresVerification) {
        setSignupPendingCookie(res, result.pendingToken);
        return res.status(200).json(
            new ApiResponse(
                200,
                { user: result.user.toSafeJSON(), requiresVerification: true },
                "Please verify your email before signing in"
            )
        );
    }

    if (result.requires2FA) {
        set2FAPendingCookie(res, result.pendingToken);
        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    requires2FA: true,
                    destination: result.destination,
                    tempToken: result.pendingToken,
                },
                "Two-factor authentication code sent"
            )
        );
    }

    const { user, accessToken, refreshToken } = result;
    setAuthCookies(res, { accessToken, refreshToken, rememberMe: Boolean(rememberMe) });

    eventEngine.trackEvent({
        eventName: "user_logged_in",
        module: "auth",
        feature: "login",
        organizationId: user.activeWorkspace || user._id,
        userId: user._id,
        requestId: req.id,
    });

    const enriched = await enrichUserWithWorkspace(user);
    return res
        .status(200)
        .json(new ApiResponse(200, { user: enriched }, "Signed in"));
});

export const verify2FAController = asyncHandler(async (req, res) => {
    const token = req.body.tempToken || req.cookies[COOKIE_NAMES.TWO_FACTOR_PENDING];
    const { code, rememberMe } = req.body;

    const result = await verifyTwoFactor({
        token,
        code,
        req,
        rememberMe,
    });

    clear2FAPendingCookie(res);
    setAuthCookies(res, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        rememberMe: result.shouldRemember,
    });

    const enriched = await enrichUserWithWorkspace(result.user);
    return res.status(200).json(
        new ApiResponse(200, { user: enriched }, "Two-factor verification successful")
    );
});

export const resend2FAController = asyncHandler(async (req, res) => {
    const token = req.body.tempToken || req.cookies[COOKIE_NAMES.TWO_FACTOR_PENDING];
    const result = await resendTwoFactor({ token });
    return res.status(200).json(new ApiResponse(200, result, "Code resent"));
});

export const getPending2FAController = asyncHandler(async (req, res) => {
    const token = req.query.token || req.cookies[COOKIE_NAMES.TWO_FACTOR_PENDING];
    if (!token) {
        return res.status(200).json(new ApiResponse(200, { active: false }, "No pending 2FA challenge"));
    }

    try {
        const decoded = verify2FAPendingToken(token);
        const user = await User.findById(decoded.sub).select("email fullName");
        if (!user) {
            clear2FAPendingCookie(res);
            return res.status(200).json(new ApiResponse(200, { active: false }, "Pending user expired"));
        }

        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    active: true,
                    destination: maskEmail(user.email),
                    email: user.email,
                },
                "Pending 2FA info"
            )
        );
    } catch {
        clear2FAPendingCookie(res);
        return res.status(200).json(new ApiResponse(200, { active: false }, "2FA challenge expired"));
    }
});

export const toggleTwoFactorController = asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    const result = await toggleTwoFactor(req.userId, enabled);
    return res.status(200).json(
        new ApiResponse(
            200,
            result,
            result.twoFactorEnabled ? "Two-factor authentication enabled" : "Two-factor authentication disabled"
        )
    );
});

export const getSessionsController = asyncHandler(async (req, res) => {
    const user = await User.findById(req.userId).lean();
    if (!user) {
        return res.status(404).json(new ApiResponse(404, null, "User not found"));
    }

    const currentUa = parseUserAgent(req.headers["user-agent"]);
    const currentIp = parseClientIp(req);

    let sessions = (user.activeSessions || []).map((s) => ({
        sessionId: s.sessionId,
        device: s.device,
        browser: s.browser,
        os: s.os,
        ip: s.ip,
        location: s.location,
        lastActiveAt: s.lastActiveAt,
        isCurrent: Boolean(req.sessionId && s.sessionId === req.sessionId),
    }));

    const hasCurrent = sessions.some((s) => s.isCurrent);
    if (!hasCurrent) {
        if (sessions.length > 0) {
            sessions[0].isCurrent = true;
        } else {
            sessions = [
                {
                    sessionId: "curr",
                    device: currentUa.device,
                    browser: currentUa.browser,
                    os: currentUa.os,
                    ip: currentIp.ip,
                    location: currentIp.location,
                    lastActiveAt: user.lastLoginAt || new Date(),
                    isCurrent: true,
                },
            ];
        }
    }

    return res.status(200).json(
        new ApiResponse(200, { sessions }, "Active sessions retrieved")
    );
});

export const verifyInviteController = asyncHandler(async (req, res) => {
    const user = await verifyInviteDetails(req.body.token);
    return res.status(200).json(new ApiResponse(200, {
        user: {
            fullName: user.fullName,
            email: user.email,
        }
    }, "Invite valid"));
});

export const acceptInviteController = asyncHandler(async (req, res) => {
    const user = await acceptInvite(req.body.token, req.body.password);

    const sessionId = crypto.randomUUID();
    const accessToken = createAccessToken(user, sessionId);
    const refreshToken = createRefreshToken(user, sessionId);
    setAuthCookies(res, { accessToken, refreshToken, rememberMe: true });

    return res.status(200).json(new ApiResponse(200, {
        user: user.toSafeJSON(),
    }, "Invite accepted. Welcome!"));
});

export const updateProfileController = asyncHandler(async (req, res) => {
    const user = await updateUserProfile(req.userId, req.body);
    return res.status(200).json(new ApiResponse(200, {
        user: user.toSafeJSON(),
    }, "Profile updated successfully"));
});

export const changePasswordController = asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const { user, message } = await changeUserPassword(req.userId, currentPassword, newPassword, req.sessionId);

    // Re-issue auth cookies with the bumped tokenVersion so the current device stays signed in
    const accessToken = createAccessToken(user, req.sessionId);
    const refreshToken = createRefreshToken(user, req.sessionId);
    setAuthCookies(res, { accessToken, refreshToken, rememberMe: true });

    return res.status(200).json(new ApiResponse(200, { message }, "Password updated successfully"));
});

export const logoutAllDevicesController = asyncHandler(async (req, res) => {
    // Only invalidates this specific user's tokens
    const result = await logoutAllDevices(req.userId);
    clearAuthCookies(res);
    clear2FAPendingCookie(res);
    return res.status(200).json(new ApiResponse(200, result, "Logged out from all devices"));
});

export const updateNotificationPreferencesController = asyncHandler(async (req, res) => {
    const prefs = req.body.prefs || req.body;
    const user = await updateNotificationPreferences(req.userId, prefs);
    return res.status(200).json(new ApiResponse(200, {
        notificationPreferences: user.notificationPreferences,
    }, "Notification preferences saved"));
});

export const forgotPasswordController = asyncHandler(async (req, res) => {
    await requestPasswordReset(req.body.email);
    return res.status(200).json(
        new ApiResponse(
            200,
            { sent: true },
            "If an account exists for that email address, we have sent a password reset link."
        )
    );
});

export const resetPasswordController = asyncHandler(async (req, res) => {
    const { token, newPassword, signOutAll } = req.body;
    const result = await resetPasswordWithToken({ token, newPassword, signOutAll });
    clearAuthCookies(res);
    return res.status(200).json(new ApiResponse(200, result, "Password has been reset successfully."));
});
