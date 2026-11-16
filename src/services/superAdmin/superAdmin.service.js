import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { SuperAdmin } from "../../model/superAdmin/superAdmin.model.js";
import { SuperAdmin2FACode } from "../../model/superAdmin/superAdmin2FACode.model.js";
import { SuperAdminAuditLog } from "../../model/superAdmin/superAdminAuditLog.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { sendMail } from "../../config/mailer.js";
import { env } from "../../config/env.js";

const DUMMY_HASH = "$2a$12$e8Y5t1o3j2e5G9g0k2e4u.8X9y0Z1A2B3C4D5E6F7G8H9I0J1K2L3";

const SUPER_ADMIN_ACCESS_SECRET = process.env.SUPER_ADMIN_JWT_ACCESS_SECRET || `${env.jwt.accessSecret}_superadmin`;
const SUPER_ADMIN_REFRESH_SECRET = process.env.SUPER_ADMIN_JWT_REFRESH_SECRET || `${env.jwt.refreshSecret}_superadmin`;

export const SUPER_ADMIN_COOKIE_NAMES = {
    ACCESS_TOKEN: "ph_sa_at",
    REFRESH_TOKEN: "ph_sa_rt",
};

export function signSuperAdminAccessToken(admin) {
    return jwt.sign(
        {
            sub: admin._id.toString(),
            email: admin.email,
            role: admin.role,
            ver: admin.tokenVersion || 0,
            typ: "superadmin",
        },
        SUPER_ADMIN_ACCESS_SECRET,
        { expiresIn: "24h" }
    );
}

export function signSuperAdminRefreshToken(admin) {
    return jwt.sign(
        {
            sub: admin._id.toString(),
            ver: admin.tokenVersion || 0,
            typ: "superadmin_refresh",
        },
        SUPER_ADMIN_REFRESH_SECRET,
        { expiresIn: "7d" }
    );
}

export function verifySuperAdminAccessToken(token) {
    return jwt.verify(token, SUPER_ADMIN_ACCESS_SECRET);
}

export function verifySuperAdminRefreshToken(token) {
    return jwt.verify(token, SUPER_ADMIN_REFRESH_SECRET);
}

export function setSuperAdminCookies(res, { accessToken, refreshToken }) {
    const isProd = env.isProd;
    const cookieDomain = env.cookie.domain === "localhost" ? undefined : env.cookie.domain;

    // Session-based cookies: by omitting maxAge and expires, the browser treats them as session cookies
    // which are automatically destroyed when the browser is closed.
    const baseOptions = {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? "none" : "lax",
        domain: cookieDomain,
        path: "/",
    };

    if (accessToken) {
        res.cookie(SUPER_ADMIN_COOKIE_NAMES.ACCESS_TOKEN, accessToken, baseOptions);
    }

    if (refreshToken) {
        res.cookie(SUPER_ADMIN_COOKIE_NAMES.REFRESH_TOKEN, refreshToken, baseOptions);
    }
}

export function clearSuperAdminCookies(res) {
    const cookieDomain = env.cookie.domain === "localhost" ? undefined : env.cookie.domain;
    const baseOptions = {
        httpOnly: true,
        secure: env.isProd,
        sameSite: env.isProd ? "none" : "lax",
        domain: cookieDomain,
        path: "/",
    };

    res.clearCookie(SUPER_ADMIN_COOKIE_NAMES.ACCESS_TOKEN, baseOptions);
    res.clearCookie(SUPER_ADMIN_COOKIE_NAMES.REFRESH_TOKEN, baseOptions);
}

function maskEmail(email = "") {
    if (!email || !email.includes("@")) return email;
    const [name, domain] = email.split("@");
    if (name.length <= 2) return `${name[0]}*@${domain}`;
    return `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 4))}${name.slice(-2)}@${domain}`;
}

async function recordAuditLog({
    superAdmin = null,
    superAdminEmail = "",
    action,
    req = null,
    details = {},
    status = "success",
}) {
    try {
        const ipAddress = req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req?.ip || "";
        const userAgent = req?.headers?.["user-agent"] || "";
        await SuperAdminAuditLog.create({
            superAdmin: superAdmin?._id || superAdmin || null,
            superAdminEmail: superAdminEmail || superAdmin?.email || "",
            action,
            ipAddress,
            userAgent,
            details,
            status,
        });
    } catch (err) {
        console.error("Non-fatal SuperAdminAuditLog error:", err);
    }
}

// -------------------------------------------------------------------------
// Authentication
// -------------------------------------------------------------------------

export async function loginSuperAdmin({ email, password, req }) {
    const cleanEmail = String(email || "").trim().toLowerCase();

    const admin = await SuperAdmin.findOne({ email: cleanEmail }).select("+password");

    // Timing-attack mitigation
    if (!admin) {
        await bcrypt.compare(password, DUMMY_HASH);
        await recordAuditLog({
            superAdminEmail: cleanEmail,
            action: "LOGIN_FAILED",
            req,
            details: { reason: "Account not found" },
            status: "failure",
        });
        throw ApiError.unauthorized("Invalid super admin credentials");
    }

    if (admin.isLocked()) {
        const remainingMinutes = Math.ceil((admin.lockUntil.getTime() - Date.now()) / (60 * 1000));
        await recordAuditLog({
            superAdmin: admin,
            action: "LOGIN_BLOCKED_LOCKED",
            req,
            details: { lockUntil: admin.lockUntil, remainingMinutes },
            status: "warning",
        });
        throw ApiError.forbidden(
            `Account is locked due to multiple failed login attempts. Try again in ${remainingMinutes} minute(s).`
        );
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
        await admin.incFailedAttempts();
        await recordAuditLog({
            superAdmin: admin,
            action: "LOGIN_FAILED",
            req,
            details: { failedAttempts: admin.failedLoginAttempts },
            status: "failure",
        });
        throw ApiError.unauthorized("Invalid super admin credentials");
    }

    if (admin.status !== "active") {
        await recordAuditLog({
            superAdmin: admin,
            action: "LOGIN_BLOCKED_STATUS",
            req,
            details: { status: admin.status },
            status: "warning",
        });
        throw ApiError.forbidden(`Super admin account is ${admin.status}`);
    }

    // Reset failed counter
    await admin.resetLock();

    // Military-grade 2FA Challenge: generate cryptographic 6-digit OTP code
    const code = crypto.randomInt(100000, 999999).toString();
    const tempToken = crypto.randomBytes(32).toString("hex");
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    // Clean up any existing challenges
    await SuperAdmin2FACode.deleteMany({ superAdmin: admin._id });

    // Store challenge with 5-minute expiry
    await SuperAdmin2FACode.create({
        superAdmin: admin._id,
        codeHash,
        tempToken,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    // Send email with 2FA code
    try {
        const ip = req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req?.ip || "Unknown IP";
        await sendMail({
            to: admin.email,
            subject: `CorpiLance Super Admin 2FA Code: ${code}`,
            text: `Your CorpiLance Super Admin verification code is: ${code}\n\nThis code will expire in 5 minutes.\nRequested from IP: ${ip}`,
            html: `
                <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 28px; background: #0f172a; color: #f8fafc; border-radius: 12px; border: 1px solid #334155;">
                    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; color: #38bdf8; font-weight: 700; margin-bottom: 8px;">CorpiLance Security Operations Center</div>
                    <h2 style="margin: 0 0 16px 0; font-size: 20px; color: #ffffff;">Super Admin 2-Step Verification</h2>
                    <p style="color: #94a3b8; font-size: 14px; line-height: 1.5; margin: 0 0 24px 0;">A sign-in attempt was detected for your Super Admin account. Use the authorization code below to complete authentication.</p>
                    <div style="background: #1e293b; padding: 18px; border-radius: 8px; text-align: center; border: 1px solid #475569; margin-bottom: 24px;">
                        <span style="font-family: monospace; font-size: 32px; font-weight: 800; letter-spacing: 0.3em; color: #38bdf8;">${code}</span>
                    </div>
                    <p style="font-size: 12px; color: #64748b; margin: 0 0 8px 0;"><strong>Security Context:</strong></p>
                    <p style="font-size: 12px; color: #64748b; margin: 0;">IP Address: ${ip}<br>Timestamp: ${new Date().toUTCString()}<br>Expires: 5 minutes</p>
                </div>
            `,
        });
    } catch (mailErr) {
        console.error("Non-fatal mail sending error during super admin 2FA:", mailErr);
    }

    if (process.env.NODE_ENV !== "production") {
        console.log(`\n======================================================`);
        console.log(`🛡️  SUPER-ADMIN 2FA CODE FOR ${admin.email}: [ ${code} ]`);
        console.log(`======================================================\n`);
    }

    await recordAuditLog({
        superAdmin: admin,
        action: "MFA_CHALLENGE_ISSUED",
        req,
        details: { email: admin.email },
    });

    return {
        requires2FA: true,
        tempToken,
        destination: maskEmail(admin.email),
    };
}

export async function verifySuperAdmin2FA({ tempToken, code, req }) {
    if (!tempToken || !code) {
        throw ApiError.badRequest("Verification code and challenge token are required");
    }

    const codeRecord = await SuperAdmin2FACode.findOne({ tempToken });
    if (!codeRecord || codeRecord.expiresAt.getTime() < Date.now()) {
        if (codeRecord) await SuperAdmin2FACode.deleteOne({ _id: codeRecord._id });
        throw ApiError.badRequest("Verification session has expired or is invalid. Please sign in again.");
    }

    if (codeRecord.attempts >= 3) {
        await SuperAdmin2FACode.deleteOne({ _id: codeRecord._id });
        throw ApiError.badRequest("Too many incorrect attempts. Please sign in again.");
    }

    const submittedHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
    if (submittedHash !== codeRecord.codeHash) {
        codeRecord.attempts += 1;
        await codeRecord.save();
        await recordAuditLog({
            superAdmin: codeRecord.superAdmin,
            action: "MFA_FAILED",
            req,
            details: { attempts: codeRecord.attempts },
            status: "failure",
        });
        const remaining = 3 - codeRecord.attempts;
        throw ApiError.badRequest(`Invalid verification code. ${remaining} attempt(s) remaining.`);
    }

    // Success: consume challenge
    await SuperAdmin2FACode.deleteOne({ _id: codeRecord._id });

    const admin = await SuperAdmin.findById(codeRecord.superAdmin);
    if (!admin || admin.status !== "active") {
        throw ApiError.forbidden("Super admin account is no longer active");
    }

    admin.lastLoginAt = new Date();
    admin.lastLoginIp = req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req?.ip || "";
    admin.lastActiveAt = new Date();
    await admin.save();

    const accessToken = signSuperAdminAccessToken(admin);
    const refreshToken = signSuperAdminRefreshToken(admin);

    await recordAuditLog({
        superAdmin: admin,
        action: "LOGIN_SUCCESS",
        req,
        details: { ip: admin.lastLoginIp },
    });

    return {
        superAdmin: admin.toSafeJSON(),
        accessToken,
        refreshToken,
    };
}

export async function resendSuperAdmin2FA({ tempToken, req }) {
    if (!tempToken) throw ApiError.badRequest("Challenge token is required");

    const codeRecord = await SuperAdmin2FACode.findOne({ tempToken });
    if (!codeRecord) throw ApiError.badRequest("Verification session expired. Please sign in again.");

    const admin = await SuperAdmin.findById(codeRecord.superAdmin);
    if (!admin) throw ApiError.notFound("Super admin not found");

    const code = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");

    codeRecord.codeHash = codeHash;
    codeRecord.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    codeRecord.attempts = 0;
    await codeRecord.save();

    try {
        await sendMail({
            to: admin.email,
            subject: `CorpiLance Super Admin 2FA Code (Resent): ${code}`,
            text: `Your new CorpiLance Super Admin verification code is: ${code}\nExpires in 5 minutes.`,
        });
    } catch (e) {
        console.error("Non-fatal mail send error:", e);
    }

    if (process.env.NODE_ENV !== "production") {
        console.log(`\n[SUPER-ADMIN 2FA CODE RESENT]: ${code}\n`);
    }

    await recordAuditLog({
        superAdmin: admin,
        action: "MFA_CODE_RESENT",
        req,
    });

    return { success: true, message: "A new security code has been sent" };
}

export async function logoutSuperAdmin(adminId, req) {
    if (adminId) {
        const admin = await SuperAdmin.findById(adminId);
        if (admin) {
            admin.tokenVersion += 1; // Invalidate all active tokens
            await admin.save();
            await recordAuditLog({
                superAdmin: admin,
                action: "LOGOUT",
                req,
            });
        }
    }
    return { success: true };
}

// -------------------------------------------------------------------------
// Workspace Verification Management
// -------------------------------------------------------------------------

export async function getSuperAdminWorkspaces({ status, search, page = 1, limit = 50 }) {
    const filter = {};

    if (status && status !== "all") {
        filter.verificationStatus = status;
    }

    if (search && search.trim()) {
        const regex = new RegExp(search.trim(), "i");
        filter.$or = [
            { companyName: regex },
            { industry: regex },
            { timezone: regex },
        ];
    }

    const skip = (Math.max(1, page) - 1) * limit;

    const [workspaces, total, pendingCount, approvedCount, rejectedCount] = await Promise.all([
        Workspace.find(filter)
            .populate("owner", "fullName email phone createdAt")
            .populate("verifiedBy", "fullName email")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        Workspace.countDocuments(filter),
        Workspace.countDocuments({ verificationStatus: "pending" }),
        Workspace.countDocuments({ verificationStatus: { $in: ["approved", null, undefined] } }),
        Workspace.countDocuments({ verificationStatus: "rejected" }),
    ]);

    return {
        workspaces: workspaces.map((w) => ({
            id: w._id,
            companyName: w.companyName,
            industry: w.industry,
            timezone: w.timezone,
            teamSize: w.teamSize,
            currency: w.currency || "USD",
            verificationStatus: w.verificationStatus || "approved",
            rejectionReason: w.rejectionReason || "",
            verifiedAt: w.verifiedAt,
            verifiedBy: w.verifiedBy ? { fullName: w.verifiedBy.fullName, email: w.verifiedBy.email } : null,
            owner: w.owner ? { id: w.owner._id, fullName: w.owner.fullName, email: w.owner.email, createdAt: w.owner.createdAt } : null,
            createdAt: w.createdAt,
            setupCompletedAt: w.setupCompletedAt,
        })),
        total,
        stats: {
            total: pendingCount + approvedCount + rejectedCount,
            pending: pendingCount,
            approved: approvedCount,
            rejected: rejectedCount,
        },
    };
}

export async function approveWorkspace({ workspaceId, superAdminId, req }) {
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) throw ApiError.notFound("Workspace not found");

    workspace.verificationStatus = "approved";
    workspace.rejectionReason = "";
    workspace.verifiedAt = new Date();
    workspace.verifiedBy = superAdminId;
    await workspace.save();

    const owner = await User.findById(workspace.owner);
    const adminUrl = env.cors.adminUrl || "http://localhost:3002";

    if (owner && owner.email) {
        try {
            await sendMail({
                to: owner.email,
                subject: `Your CorpiLance Workspace "${workspace.companyName}" is Approved!`,
                text: `Hello ${owner.fullName || "Admin"},\n\nGreat news! Your workspace "${workspace.companyName}" has been verified and approved by the CorpiLance Super Admin team.\n\nYou now have full access to your HR Management Dashboard: ${adminUrl}/\n\nWelcome aboard!\nCorpiLance Team`,
                html: `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <div style="display: inline-block; width: 56px; height: 56px; border-radius: 50%; background: #ecfdf5; color: #059669; line-height: 56px; font-size: 28px; font-weight: 700;">✓</div>
                        </div>
                        <h2 style="margin: 0 0 12px 0; font-size: 22px; text-align: center; color: #0f172a;">Workspace Approved!</h2>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
                            Hello <strong>${owner.fullName || "Admin"}</strong>,
                        </p>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
                            We're excited to inform you that your workspace for <strong>${workspace.companyName}</strong> has been successfully reviewed and verified by the CorpiLance Super Admin compliance team.
                        </p>
                        <div style="text-align: center; margin: 28px 0;">
                            <a href="${adminUrl}/" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">Access Admin Dashboard</a>
                        </div>
                        <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin: 24px 0 0 0; border-top: 1px solid #e2e8f0; padding-top: 16px;">
                            If you have questions or need assistance setting up your teams, feel free to reply to this email.
                        </p>
                    </div>
                `,
            });
        } catch (mailErr) {
            console.error("Non-fatal mail sending error during workspace approval:", mailErr);
        }
    }

    await recordAuditLog({
        superAdmin: superAdminId,
        action: "WORKSPACE_APPROVED",
        req,
        details: {
            workspaceId: workspace._id,
            companyName: workspace.companyName,
            ownerEmail: owner?.email,
        },
    });

    return { success: true, workspace: workspace.toSafeJSON() };
}

export async function rejectWorkspace({ workspaceId, reason, superAdminId, req }) {
    if (!reason || !reason.trim()) {
        throw ApiError.badRequest("A rejection reason is required.");
    }

    const cleanReason = reason.trim();
    const workspace = await Workspace.findById(workspaceId);
    if (!workspace) throw ApiError.notFound("Workspace not found");

    workspace.verificationStatus = "rejected";
    workspace.rejectionReason = cleanReason;
    workspace.verifiedAt = new Date();
    workspace.verifiedBy = superAdminId;
    await workspace.save();

    const owner = await User.findById(workspace.owner);

    if (owner && owner.email) {
        try {
            await sendMail({
                to: owner.email,
                subject: `Regarding your CorpiLance Workspace: ${workspace.companyName}`,
                text: `Hello ${owner.fullName || "Admin"},\n\nThank you for your interest in CorpiLance.\n\nAfter reviewing your workspace registration for "${workspace.companyName}", our compliance team was unable to approve your workspace.\n\nReason: "${cleanReason}"\n\nIf you believe this decision was made in error or wish to submit additional verification, please contact support.\n\nCorpiLance Team`,
                html: `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px 24px; background: #ffffff; color: #1e293b; border-radius: 12px; border: 1px solid #e2e8f0;">
                        <div style="text-align: center; margin-bottom: 24px;">
                            <div style="display: inline-block; width: 56px; height: 56px; border-radius: 50%; background: #fef2f2; color: #dc2626; line-height: 56px; font-size: 26px; font-weight: 700;">✕</div>
                        </div>
                        <h2 style="margin: 0 0 12px 0; font-size: 22px; text-align: center; color: #0f172a;">Workspace Verification Status</h2>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0;">
                            Hello <strong>${owner.fullName || "Admin"}</strong>,
                        </p>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
                            Thank you for registering <strong>${workspace.companyName}</strong> on CorpiLance. Following our compliance and security verification review, your workspace was not approved.
                        </p>
                        <div style="background: #f8fafc; border-left: 4px solid #ef4444; padding: 16px; border-radius: 6px; margin: 20px 0;">
                            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #dc2626; letter-spacing: 0.05em; margin-bottom: 4px;">Reason Provided by Compliance Team:</div>
                            <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5; font-style: italic;">
                                "${cleanReason}"
                            </p>
                        </div>
                        <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 20px 0 0 0;">
                            If you believe this was an error or would like to provide updated documentation to appeal, please contact our support team at <a href="mailto:support@corpilance.com" style="color: #2563eb; text-decoration: underline;">support@corpilance.com</a>.
                        </p>
                    </div>
                `,
            });
        } catch (mailErr) {
            console.error("Non-fatal mail sending error during workspace rejection:", mailErr);
        }
    }

    await recordAuditLog({
        superAdmin: superAdminId,
        action: "WORKSPACE_REJECTED",
        req,
        details: {
            workspaceId: workspace._id,
            companyName: workspace.companyName,
            reason: cleanReason,
            ownerEmail: owner?.email,
        },
    });

    return { success: true, workspace: workspace.toSafeJSON() };
}

export async function getSuperAdminAuditLogs({ limit = 100 }) {
    const logs = await SuperAdminAuditLog.find()
        .populate("superAdmin", "fullName email role")
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

    return logs.map((log) => ({
        id: log._id,
        action: log.action,
        status: log.status,
        superAdmin: log.superAdmin ? { fullName: log.superAdmin.fullName, email: log.superAdmin.email } : null,
        superAdminEmail: log.superAdminEmail,
        ipAddress: log.ipAddress,
        userAgent: log.userAgent,
        details: log.details,
        timestamp: log.timestamp,
    }));
}
