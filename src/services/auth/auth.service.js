import crypto from "crypto";
import bcrypt from "bcryptjs";
import { User } from "../../model/auth/auth.model.js";
import { verifyInviteToken } from "../../utils/inviteToken.js";
import { ApiError } from "../../utils/ApiError.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
    createEmailVerifyToken,
    verifyEmailVerifyToken,
    createPasswordResetToken,
    verifyPasswordResetToken,
} from "../../utils/emailToken.js";
import { createSignupPendingToken } from "../../utils/signupToken.js";
import {
    createAccessToken,
    createRefreshToken,
    verifyRefreshToken,
    create2FAPendingToken,
    verify2FAPendingToken,
} from "../../utils/tokens.js";
import { sendVerificationEmail, send2FACodeEmail, sendPasswordResetEmail } from "../email/email.service.js";
import { parseUserAgent, parseClientIp, maskEmail, upsertActiveSession } from "../../utils/userAgent.js";

// Dummy hash used to make failed logins constant-time.
// Generated from "not-a-real-password" with bcrypt cost 12.
const DUMMY_HASH = "$2a$12$w5cF.BK8CellV78J3lVxGu3ILPlhhzKWSmW4Z2lgNKUAWere3RGb6";

export async function registerUser(payload) {
    const { fullName, email, password, company, companySize, role, ipAddress = "" } = payload;

    const existing = await User.findOne({ email }).lean();
    if (existing) {
        throw ApiError.conflict("An account with this email already exists");
    }

    const hashed = await hashPassword(password);
    const clientIp = typeof ipAddress === "object" ? String(ipAddress?.ip || "") : String(ipAddress || "");

    const user = await User.create({
        fullName,
        email,
        password: hashed,
        company,
        companySize,
        role,
        legalAcceptance: {
            termsAccepted: true,
            termsVersion: "1.0",
            privacyAccepted: true,
            privacyVersion: "1.0",
            acceptedAt: new Date(),
            ipAddress: clientIp,
        },
    });

    const verifyToken = createEmailVerifyToken(user);
    sendVerificationEmail(user, verifyToken).catch((err) => {
        console.error("Failed to send verification email:", err.message);
    });

    const pendingToken = createSignupPendingToken(user);
    return { user, pendingToken };
}

export async function verifyEmail(token) {
    let decoded;
    try {
        decoded = verifyEmailVerifyToken(token);
    } catch {
        throw ApiError.badRequest("Verification link is invalid or has expired");
    }

    const user = await User.findById(decoded.sub);
    if (!user) {
        throw ApiError.badRequest("Verification link is invalid or has expired");
    }

    if (!user.emailVerified) {
        user.emailVerified = true;
        if (user.status === "pending") user.status = "active";
        user.lastLoginAt = new Date();
        await user.save();
    }

    const sessionId = crypto.randomUUID();
    const accessToken = createAccessToken(user, sessionId);
    const refreshToken = createRefreshToken(user, sessionId);

    return { user, accessToken, refreshToken };
}

export async function resendVerificationForUser(userId) {
    const user = await User.findById(userId);
    if (!user) return;
    if (user.emailVerified) return;

    const token = createEmailVerifyToken(user);
    await sendVerificationEmail(user, token);
}

export async function getSessionUser(userId) {
    const user = await User.findById(userId);
    return user || null;
}

export async function assertUserWorkspaceNotRevoked(userOrId) {
    const userId = typeof userOrId === "string" ? userOrId : userOrId?._id;
    if (!userId) return;
    const { getWorkspaceForUser } = await import("../workspace/workspace.service.js");
    const ws = await getWorkspaceForUser(userId);
    if (ws?.accessRevoked) {
        const reasonText = ws.accessRevokedReason ? ` (${ws.accessRevokedReason})` : "";
        const err = ApiError.forbidden(
            `Organization access for "${ws.companyName || "your workspace"}" has been temporarily suspended pending subscription payment resolution. All your records remain safely intact. Contact CorpiLance Billing (+92 344 5959967 / corpilance.org@gmail.com) to restore access.${reasonText}`
        );
        err.code = "WORKSPACE_ACCESS_REVOKED";
        throw err;
    }
}

/**
 * Refresh a user's session using a valid refresh token.
 * Generates a new access token and a NEW refresh token (rotation).
 */
export async function refreshSession(refreshToken) {
    let decoded;
    try {
        decoded = verifyRefreshToken(refreshToken);
    } catch {
        throw ApiError.unauthorized("Invalid or expired refresh token");
    }

    const user = await User.findById(decoded.sub);
    if (!user) throw ApiError.unauthorized("User no longer exists");

    // If the user's token version doesn't match the token, the session was revoked.
    if ((decoded.ver ?? 0) !== (user.tokenVersion ?? 0)) {
        throw ApiError.unauthorized("Session revoked");
    }

    if (user.status === "inactive" || user.status === "suspended") {
        throw ApiError.forbidden("Your account has been deactivated or suspended");
    }

    await assertUserWorkspaceNotRevoked(user);

    const rememberMe = Boolean(decoded.rem);
    const sessionId = decoded.sid || crypto.randomUUID();
    const accessToken = createAccessToken(user, sessionId);
    // Rotate the refresh token — issue a new one on every refresh, preserving rememberMe
    const newRefreshToken = createRefreshToken(user, sessionId, rememberMe);

    return { accessToken, refreshToken: newRefreshToken, newRefreshToken, user, rememberMe };
}

export async function loginUser({ email, password, req = null, rememberMe = false }) {
    // Load with password & 2FA fields
    const user = await User.findOne({ email }).select("+password +twoFactorCode +twoFactorExpires +twoFactorAttempts");

    // Timing-safe: if no user, still run bcrypt.compare against a dummy hash
    if (!user) {
        await bcrypt.compare(password, DUMMY_HASH).catch(() => { });
        throw ApiError.unauthorized("Invalid email or password");
    }

    // Revoked password check (password removed on termination/resignation/suspension)
    if (!user.password) {
        await bcrypt.compare(password, DUMMY_HASH).catch(() => { });
        throw ApiError.forbidden("Your account access has been revoked. No active password exists for this account.");
    }

    if (user.status === "suspended") {
        throw ApiError.forbidden("Your account has been suspended");
    }
    if (user.status === "inactive") {
        throw ApiError.forbidden("Your account has been deactivated. Please contact your organization's HR.");
    }

    // Check linked employee standing
    try {
        const { Employee } = await import("../../model/employee/employee.model.js");
        const linkedEmployee = await Employee.findOne({
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email },
                { workEmail: user.email },
            ],
        }).select("employmentStatus").lean();

        if (linkedEmployee && ["Terminated", "Resigned", "Suspended"].includes(linkedEmployee.employmentStatus)) {
            throw ApiError.forbidden(`Your access has been revoked because your employment status is ${linkedEmployee.employmentStatus}. Please contact HR.`);
        }
    } catch (empCheckErr) {
        if (empCheckErr instanceof ApiError) throw empCheckErr;
    }

    const ok = await verifyPassword(password, user.password);
    if (!ok) {
        throw ApiError.unauthorized("Invalid email or password");
    }

    if (!user.emailVerified) {
        const pendingToken = createSignupPendingToken(user);
        return { requiresVerification: true, user, pendingToken };
    }

    await assertUserWorkspaceNotRevoked(user);

    // Check if Two-Factor Authentication is enabled for this specific user
    if (user.twoFactorEnabled) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        user.twoFactorCode = code;
        user.twoFactorExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        user.twoFactorAttempts = 0;
        await user.save();

        const pendingToken = create2FAPendingToken(user, rememberMe);

        // Send OTP via email
        send2FACodeEmail({
            to: user.email,
            userName: user.fullName,
            code,
        }).catch((err) => {
            console.error("Failed to send 2FA code email:", err.message);
        });

        return {
            requires2FA: true,
            user,
            pendingToken,
            destination: maskEmail(user.email),
        };
    }

    // Standard login (2FA not enabled)
    const sessionId = crypto.randomUUID();
    const { browser, os, device } = parseUserAgent(req?.headers?.["user-agent"]);
    const { ip, location } = parseClientIp(req || {});

    user.lastLoginAt = new Date();
    user.activeSessions = upsertActiveSession(user.activeSessions, {
        sessionId,
        device,
        browser,
        os,
        ip,
        location,
    });

    await user.save();

    const accessToken = createAccessToken(user, sessionId);
    const refreshToken = createRefreshToken(user, sessionId, rememberMe);

    return { user, accessToken, refreshToken, sessionId, rememberMe: Boolean(rememberMe) };
}

export async function verifyTwoFactor({ token, code, req = null, rememberMe = false }) {
    if (!token) {
        throw ApiError.unauthorized("2FA session expired. Please sign in again.");
    }
    if (!code) {
        throw ApiError.badRequest("Verification code is required");
    }

    let decoded;
    try {
        decoded = verify2FAPendingToken(token);
    } catch {
        throw ApiError.unauthorized("2FA session expired. Please sign in again.");
    }

    const user = await User.findById(decoded.sub).select("+twoFactorCode +twoFactorExpires +twoFactorAttempts");
    if (!user) throw ApiError.unauthorized("User not found");

    if (!user.twoFactorExpires || new Date() > user.twoFactorExpires) {
        throw ApiError.badRequest("Verification code has expired. Please request a new one.");
    }

    if ((user.twoFactorAttempts || 0) >= 5) {
        user.twoFactorCode = null;
        user.twoFactorExpires = null;
        user.twoFactorAttempts = 0;
        await user.save();
        throw ApiError.badRequest("Too many incorrect attempts. Please sign in again.");
    }

    if (user.twoFactorCode !== String(code).trim()) {
        user.twoFactorAttempts = (user.twoFactorAttempts || 0) + 1;
        await user.save();
        const left = Math.max(0, 5 - user.twoFactorAttempts);
        throw ApiError.badRequest(`Incorrect verification code. ${left} attempt${left === 1 ? "" : "s"} remaining.`);
    }

    // Verification succeeded
    await assertUserWorkspaceNotRevoked(user);

    user.twoFactorCode = null;
    user.twoFactorExpires = null;
    user.twoFactorAttempts = 0;
    user.lastLoginAt = new Date();

    const sessionId = crypto.randomUUID();
    const { browser, os, device } = parseUserAgent(req?.headers?.["user-agent"]);
    const { ip, location } = parseClientIp(req || {});

    user.activeSessions = upsertActiveSession(user.activeSessions, {
        sessionId,
        device,
        browser,
        os,
        ip,
        location,
    });

    await user.save();

    const shouldRemember = rememberMe || Boolean(decoded.rememberMe);
    const accessToken = createAccessToken(user, sessionId);
    const refreshToken = createRefreshToken(user, sessionId, shouldRemember);

    return { user, accessToken, refreshToken, shouldRemember };
}

export async function resendTwoFactor({ token }) {
    if (!token) {
        throw ApiError.unauthorized("2FA session expired. Please sign in again.");
    }

    let decoded;
    try {
        decoded = verify2FAPendingToken(token);
    } catch {
        throw ApiError.unauthorized("2FA session expired. Please sign in again.");
    }

    const user = await User.findById(decoded.sub);
    if (!user) throw ApiError.unauthorized("User not found");

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.twoFactorCode = code;
    user.twoFactorExpires = new Date(Date.now() + 10 * 60 * 1000);
    user.twoFactorAttempts = 0;
    await user.save();

    await send2FACodeEmail({
        to: user.email,
        userName: user.fullName,
        code,
    });

    return { message: "A new verification code has been sent" };
}

export async function toggleTwoFactor(userId, enabled) {
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User not found");

    user.twoFactorEnabled = Boolean(enabled);
    user.twoFactorCode = null;
    user.twoFactorExpires = null;
    user.twoFactorAttempts = 0;
    await user.save();

    return { twoFactorEnabled: user.twoFactorEnabled };
}

export async function verifyInviteDetails(token) {
    let decoded;
    try {
        decoded = verifyInviteToken(token);
    } catch {
        throw ApiError.badRequest("Invite link is invalid or has expired");
    }

    const user = await User.findById(decoded.sub);
    if (!user) throw ApiError.badRequest("User not found");
    if (user.status !== "pending") {
        throw ApiError.badRequest("Invite has already been used");
    }

    return user;
}

export async function acceptInvite(token, password) {
    let decoded;
    try {
        decoded = verifyInviteToken(token);
    } catch {
        throw ApiError.badRequest("Invite link is invalid or has expired");
    }

    const user = await User.findById(decoded.sub);
    if (!user) throw ApiError.badRequest("User not found");
    if (user.status !== "pending") {
        throw ApiError.badRequest("Invite has already been used");
    }

    user.password = await hashPassword(password);
    user.status = "active";
    user.emailVerified = true;

    if (!user.setupCompletedAt) {
        user.setupCompletedAt = new Date();
    }

    try {
        const { Employee } = await import("../../model/employee/employee.model.js");
        const employee = await Employee.findOne({
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email },
                { workEmail: user.email },
            ],
        });
        if (employee) {
            if (!user.workspaceId) {
                user.workspaceId = employee.workspace;
            }
            if (!employee.linkedUser) {
                employee.linkedUser = user._id;
            }
            if (employee.employmentStatus !== "Active") {
                employee.employmentStatus = "Active";
                employee.isActive = true;
            }
            await employee.save();
        }
    } catch {}

    await assertUserWorkspaceNotRevoked(user);
    await user.save();

    return user;
}

export async function updateUserProfile(userId, patch) {
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User not found");

    if (patch.fullName) user.fullName = String(patch.fullName).trim();
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName).trim();
    if (patch.phone !== undefined) user.phone = String(patch.phone).trim();
    if (patch.avatar !== undefined) user.avatar = patch.avatar;
    if (patch.emergencyContact) {
        user.emergencyContact = {
            ...(user.emergencyContact || {}),
            ...patch.emergencyContact,
        };
    }

    await user.save();
    return user;
}

export async function changeUserPassword(userId, currentPassword, newPassword, sessionId = null) {
    const user = await User.findById(userId).select("+password");
    if (!user) throw ApiError.unauthorized("User not found");

    const match = await verifyPassword(currentPassword, user.password);
    if (!match) {
        throw ApiError.badRequest("Current password does not match");
    }

    if (!newPassword || newPassword.length < 8) {
        throw ApiError.badRequest("New password must be at least 8 characters");
    }

    user.password = await hashPassword(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    // Retain only current session if available, invalidating other devices
    if (sessionId) {
        user.activeSessions = (user.activeSessions || []).filter((s) => s.sessionId === sessionId);
    }
    await user.save();

    return { user, message: "Password updated successfully" };
}

export async function logoutAllDevices(userId) {
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User not found");

    // Incrementing tokenVersion only for THIS user invalidates only this user's active tokens across all devices
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.activeSessions = [];
    await user.save();

    return { message: "Logged out from all devices" };
}

export async function updateNotificationPreferences(userId, prefs) {
    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User not found");

    user.notificationPreferences = {
        ...(user.notificationPreferences || {}),
        ...prefs,
    };
    user.markModified("notificationPreferences");
    await user.save();

    return user;
}

export async function requestPasswordReset(email) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) return;

    const user = await User.findOne({ email: cleanEmail }).select("+password");
    if (!user || !user.password) return;
    if (user.status === "suspended" || user.status === "inactive") return;

    const token = createPasswordResetToken(user);
    try {
        await sendPasswordResetEmail(user, token);
    } catch (err) {
        console.error("Failed to send password reset email:", err.message);
    }
}

export async function resetPasswordWithToken({ token, newPassword, signOutAll = true }) {
    let decoded;
    try {
        decoded = verifyPasswordResetToken(token);
    } catch {
        throw ApiError.badRequest("This password reset link is invalid or has expired. Please request a new one.");
    }

    const user = await User.findById(decoded.sub).select("+password");
    if (!user) {
        throw ApiError.badRequest("This password reset link is invalid or has expired.");
    }
    if (user.status === "suspended" || user.status === "inactive") {
        throw ApiError.forbidden("This account is deactivated or suspended.");
    }
    if ((decoded.ver ?? 0) !== (user.tokenVersion ?? 0)) {
        throw ApiError.badRequest("This password reset link has already been used. Please request a new one.");
    }

    user.password = await hashPassword(newPassword);
    user.emailVerified = true;
    if (user.status === "pending") user.status = "active";
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.twoFactorCode = null;
    user.twoFactorExpires = null;
    user.twoFactorAttempts = 0;
    if (signOutAll !== false) {
        user.activeSessions = [];
    }
    await user.save();

    return { message: "Password updated successfully" };
}
