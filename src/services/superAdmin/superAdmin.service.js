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
import {
    updateWorkspaceSubscriptionPlan,
    resolvePlanConfig,
    VALID_PLAN_KEYS,
} from "../workspace/plan.service.js";
import { escapeRegex, escapeHtml } from "../../utils/security.js";

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
    return jwt.verify(token, SUPER_ADMIN_ACCESS_SECRET, { algorithms: ["HS256"] });
}

export function verifySuperAdminRefreshToken(token) {
    return jwt.verify(token, SUPER_ADMIN_REFRESH_SECRET, { algorithms: ["HS256"] });
}

export function setSuperAdminCookies(res, { accessToken, refreshToken }) {
    const isProd = env.isProd;
    const cookieDomain =
        isProd && env.cookie.domain && env.cookie.domain !== "localhost"
            ? env.cookie.domain
            : undefined;

    // Session-based cookies: by omitting maxAge and expires, the browser treats them as session cookies
    // which are automatically destroyed when the browser is closed.
    const baseOptions = {
        httpOnly: true,
        secure: isProd ? env.cookie.secure : false,
        sameSite: env.cookie.sameSite,
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
    const isProd = env.isProd;
    const cookieDomain =
        isProd && env.cookie.domain && env.cookie.domain !== "localhost"
            ? env.cookie.domain
            : undefined;
    const baseOptions = {
        httpOnly: true,
        secure: isProd ? env.cookie.secure : false,
        sameSite: env.cookie.sameSite,
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

const FOLLOW_UP_INTERVAL_DAYS = 3;
const FOLLOW_UP_INTERVAL_MS = FOLLOW_UP_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

function buildBillingSummary(workspace, planCfg) {
    const rawBilling = workspace?.billing || {};
    const isPaidPlan = Boolean(planCfg?.isPaid);
    const paymentStatus = !isPaidPlan
        ? "none"
        : workspace?.accessRevoked
        ? "revoked"
        : rawBilling.paymentStatus === "paid"
        ? "paid"
        : "unpaid";

    const firstSentAt = rawBilling.firstFollowUpSentAt ? new Date(rawBilling.firstFollowUpSentAt) : null;
    const secondSentAt = rawBilling.secondFollowUpSentAt ? new Date(rawBilling.secondFollowUpSentAt) : null;
    const secondFollowUpEligibleAt = firstSentAt ? new Date(firstSentAt.getTime() + FOLLOW_UP_INTERVAL_MS) : null;
    const now = Date.now();
    const msUntilSecondFollowUp =
        firstSentAt && !secondSentAt && secondFollowUpEligibleAt
            ? Math.max(0, secondFollowUpEligibleAt.getTime() - now)
            : 0;

    return {
        paymentStatus,
        monthlyPriceUsd: planCfg?.monthlyPriceUsd || 0,
        firstFollowUpSentAt: firstSentAt,
        secondFollowUpSentAt: secondSentAt,
        secondFollowUpEligibleAt,
        canSendFirstFollowUp: Boolean(
            isPaidPlan && paymentStatus === "unpaid" && !workspace?.accessRevoked && !firstSentAt
        ),
        canSendSecondFollowUp: Boolean(
            isPaidPlan &&
                paymentStatus === "unpaid" &&
                !workspace?.accessRevoked &&
                firstSentAt &&
                !secondSentAt &&
                msUntilSecondFollowUp === 0
        ),
        msUntilSecondFollowUp,
        canRevokeAccess: Boolean(
            isPaidPlan && !workspace?.accessRevoked && paymentStatus !== "paid" && secondSentAt
        ),
        canRestoreAccess: Boolean(workspace?.accessRevoked),
        paidAt: rawBilling.paidAt || null,
        restoredAt: rawBilling.restoredAt || null,
        notes: rawBilling.notes || "",
    };
}

export async function getSuperAdminWorkspaces({ status, search, page = 1, limit = 50 }) {
    const filter = {};

    if (status && status !== "all") {
        filter.verificationStatus = status;
    }

    if (search && search.trim()) {
        const regex = new RegExp(escapeRegex(search.trim()), "i");
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
        Workspace.countDocuments({ verificationStatus: { $in: ["approved", null] } }),
        Workspace.countDocuments({ verificationStatus: "rejected" }),
    ]);

    return {
        workspaces: workspaces.map((w) => {
            const planCfg = resolvePlanConfig(w.subscription);
            return {
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
                subscription: {
                    plan: planCfg.plan,
                    planName: planCfg.planName,
                    isPaid: planCfg.isPaid,
                    monthlyPriceUsd: planCfg.monthlyPriceUsd,
                    storageLimitBytes: planCfg.storageLimitBytes,
                    maxEmployees: planCfg.maxEmployees,
                    maxDevices: planCfg.maxDevices,
                },
                accessRevoked: Boolean(w.accessRevoked),
                accessRevokedAt: w.accessRevokedAt || null,
                accessRevokedReason: w.accessRevokedReason || "",
                billing: buildBillingSummary(w, planCfg),
                storageUsage: {
                    totalBytesUsed: w.storageUsage?.totalBytesUsed || 0,
                    databaseBytesUsed: w.storageUsage?.databaseBytesUsed || 0,
                    s3BytesUsed: w.storageUsage?.s3BytesUsed || 0,
                    storageLimitBytes: planCfg.storageLimitBytes,
                    lastCalculatedAt: w.storageUsage?.lastCalculatedAt || null,
                    breakdown: w.storageUsage?.breakdown || {},
                },
            };
        }),
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
                            Hello <strong>${escapeHtml(owner.fullName || "Admin")}</strong>,
                        </p>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 24px 0;">
                            We're excited to inform you that your workspace for <strong>${escapeHtml(workspace.companyName)}</strong> has been successfully reviewed and verified by the CorpiLance Super Admin compliance team.
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
                            Hello <strong>${escapeHtml(owner.fullName || "Admin")}</strong>,
                        </p>
                        <p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 0 0 20px 0;">
                            Thank you for registering <strong>${escapeHtml(workspace.companyName)}</strong> on CorpiLance. Following our compliance and security verification review, your workspace was not approved.
                        </p>
                        <div style="background: #f8fafc; border-left: 4px solid #ef4444; padding: 16px; border-radius: 6px; margin: 20px 0;">
                            <div style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: #dc2626; letter-spacing: 0.05em; margin-bottom: 4px;">Reason Provided by Compliance Team:</div>
                            <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5; font-style: italic;">
                                "${escapeHtml(cleanReason)}"
                            </p>
                        </div>
                        <p style="color: #64748b; font-size: 14px; line-height: 1.6; margin: 20px 0 0 0;">
                            If you believe this was an error or would like to provide updated documentation to appeal, please contact our support team at <a href="mailto:corpilance.org@gmail.com" style="color: #2563eb; text-decoration: underline;">corpilance.org@gmail.com</a>.
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

export async function updateWorkspacePlanBySuperAdmin({ workspaceId, plan, notes = "", superAdminId, req }) {
    if (!VALID_PLAN_KEYS.includes(plan)) {
        throw ApiError.badRequest("Invalid subscription plan. Expected 'free', 'growth', 'pro', or 'enterprise'.");
    }

    const existing = await Workspace.findById(workspaceId).lean();
    if (!existing) throw ApiError.notFound("Workspace not found");

    const previousPlan = existing.subscription?.plan || "free";
    const usage = await updateWorkspaceSubscriptionPlan(workspaceId, plan);
    const updated = await Workspace.findById(workspaceId);

    await recordAuditLog({
        superAdmin: superAdminId,
        action: "WORKSPACE_PLAN_UPDATED",
        req,
        details: {
            workspaceId: existing._id,
            companyName: existing.companyName,
            previousPlan,
            newPlan: usage.plan,
            planName: usage.planName,
            notes: typeof notes === "string" ? notes.trim() : "",
        },
    });

    const planCfg = resolvePlanConfig(updated?.subscription);

    return {
        success: true,
        usage,
        workspace: updated ? updated.toSafeJSON() : null,
        billing: updated ? buildBillingSummary(updated, planCfg) : null,
    };
}

/**
 * Sends a manual 1st or 2nd payment follow-up email for an unpaid paid-plan workspace.
 * Enforces the 3-day waiting window between the 1st and 2nd follow-up emails.
 */
export async function sendWorkspacePaymentFollowUp({ workspaceId, step, superAdminId, req }) {
    const parsedStep = Number(step);
    if (parsedStep !== 1 && parsedStep !== 2) {
        throw ApiError.badRequest("Follow-up step must be 1 or 2.");
    }

    const workspace = await Workspace.findById(workspaceId).populate("owner", "fullName email");
    if (!workspace) {
        throw ApiError.notFound("Workspace not found");
    }

    const planCfg = resolvePlanConfig(workspace.subscription);
    if (!planCfg.isPaid) {
        throw ApiError.badRequest("Payment follow-up emails only apply to paid subscription plans.");
    }
    if (workspace.accessRevoked) {
        throw ApiError.badRequest("Workspace access is already revoked. Restore access once payment is received.");
    }
    if (workspace.billing?.paymentStatus === "paid") {
        throw ApiError.badRequest("This organization has already been marked as paid.");
    }

    const ownerEmail = workspace.owner?.email;
    if (!ownerEmail) {
        throw ApiError.badRequest("Workspace owner email could not be resolved.");
    }

    const now = new Date();
    const firstSentAt = workspace.billing?.firstFollowUpSentAt ? new Date(workspace.billing.firstFollowUpSentAt) : null;
    const secondSentAt = workspace.billing?.secondFollowUpSentAt ? new Date(workspace.billing.secondFollowUpSentAt) : null;

    if (parsedStep === 1) {
        if (firstSentAt) {
            throw ApiError.badRequest("The 1st payment follow-up email has already been sent for this billing cycle.");
        }
    } else {
        if (!firstSentAt) {
            throw ApiError.badRequest("You must send the 1st payment follow-up email before sending the 2nd follow-up.");
        }
        if (secondSentAt) {
            throw ApiError.badRequest("The 2nd payment follow-up email has already been sent.");
        }
        const eligibleAt = new Date(firstSentAt.getTime() + FOLLOW_UP_INTERVAL_MS);
        if (now.getTime() < eligibleAt.getTime()) {
            const remainingMs = eligibleAt.getTime() - now.getTime();
            const remainingHours = Math.ceil(remainingMs / (60 * 60 * 1000));
            throw ApiError.badRequest(
                `The 2nd follow-up email can only be sent on the 3rd day after the 1st follow-up email (eligible on ${eligibleAt.toUTCString()}, ~${remainingHours}h remaining).`
            );
        }
    }

    const safeCompany = escapeHtml(workspace.companyName || "your organization");
    const safeOwner = escapeHtml(workspace.owner?.fullName || "Administrator");
    const safePlan = escapeHtml(planCfg.planName);
    const priceLabel = `$${planCfg.monthlyPriceUsd}/month`;
    const isSecond = parsedStep === 2;

    const subject = isSecond
        ? `[Final Payment Notice] 2nd Follow-Up: Settle ${workspace.companyName} ${planCfg.planName} Invoice to Prevent Access Suspension`
        : `[Payment Reminder] 1st Follow-Up: Outstanding Balance for ${workspace.companyName} (${planCfg.planName})`;

    const html = isSecond
        ? `
            <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #fecaca; border-radius: 12px; background: #fff;">
                <p style="margin: 0 0 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #dc2626;">Final Payment Notice (2nd Follow-Up)</p>
                <h2 style="margin: 0 0 16px; color: #0f172a;">Immediate Payment Required for ${safeCompany}</h2>
                <p>Dear ${safeOwner},</p>
                <p>This is our <strong>2nd and final follow-up</strong> (sent on day 3 following our initial reminder) regarding the unsettled payment for your active <strong>${safePlan}</strong> subscription (${priceLabel}).</p>
                <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 14px; margin: 18px 0;">
                    <p style="margin: 0; color: #991b1b; font-size: 14px;"><strong>Notice of Pending Access Suspension:</strong> If payment confirmation is not received shortly, Super Admin will temporarily revoke organization login access across your team until the balance is settled. All workspace records and employee data will remain safely preserved.</p>
                </div>
                <p>To settle your balance immediately and keep uninterrupted access:</p>
                <ul style="color: #334155; font-size: 14px; line-height: 1.7;">
                    <li><strong>WhatsApp Billing Desk:</strong> +92 344 5959967</li>
                    <li><strong>Email:</strong> corpilance.org@gmail.com</li>
                </ul>
                <p style="margin-top: 24px; color: #64748b; font-size: 12px;">Regards,<br/>CorpiLance Billing & Platform Operations</p>
            </div>
        `
        : `
            <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;">
                <p style="margin: 0 0 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #2563eb;">Billing Reminder (1st Follow-Up)</p>
                <h2 style="margin: 0 0 16px; color: #0f172a;">Payment Follow-Up for ${safeCompany}</h2>
                <p>Dear ${safeOwner},</p>
                <p>Your workspace <strong>${safeCompany}</strong> is currently active on the <strong>${safePlan}</strong> (${priceLabel}), and payment for this billing period has not yet been confirmed in our records.</p>
                <p>Please complete payment settlement at your earliest convenience via either official channel below:</p>
                <ul style="color: #334155; font-size: 14px; line-height: 1.7;">
                    <li><strong>WhatsApp Billing Desk:</strong> +92 344 5959967</li>
                    <li><strong>Email:</strong> corpilance.org@gmail.com</li>
                </ul>
                <p style="font-size: 13px; color: #475569;">Please share your company name and transfer confirmation reference so we can mark your account as paid immediately.</p>
                <p style="margin-top: 24px; color: #64748b; font-size: 12px;">Regards,<br/>CorpiLance Billing & Platform Operations</p>
            </div>
        `;

    await sendMail({
        to: ownerEmail,
        subject,
        html,
    });

    workspace.billing = workspace.billing || {};
    workspace.billing.paymentStatus = "unpaid";
    if (isSecond) {
        workspace.billing.secondFollowUpSentAt = now;
        workspace.billing.secondFollowUpSentBy = superAdminId;
    } else {
        workspace.billing.firstFollowUpSentAt = now;
        workspace.billing.firstFollowUpSentBy = superAdminId;
    }
    await workspace.save();

    await recordAuditLog({
        superAdmin: superAdminId,
        action: isSecond ? "WORKSPACE_FOLLOWUP_2_SENT" : "WORKSPACE_FOLLOWUP_1_SENT",
        status: "warning",
        req,
        details: {
            workspaceId: workspace._id.toString(),
            companyName: workspace.companyName,
            ownerEmail,
            plan: planCfg.plan,
            step: parsedStep,
            sentAt: now,
        },
    });

    return {
        workspaceId: workspace._id.toString(),
        step: parsedStep,
        billing: buildBillingSummary(workspace, planCfg),
    };
}

/**
 * Revokes login & system access for an entire organization after both follow-ups.
 * Strictly non-destructive: zero workspace, user, employee, document, or payroll records are deleted.
 */
export async function revokeWorkspaceAccess({ workspaceId, reason = "", superAdminId, req }) {
    const workspace = await Workspace.findById(workspaceId).populate("owner", "fullName email");
    if (!workspace) {
        throw ApiError.notFound("Workspace not found");
    }

    const planCfg = resolvePlanConfig(workspace.subscription);
    if (!planCfg.isPaid) {
        throw ApiError.badRequest("Only paid-plan workspaces with unsettled balances can be suspended via billing revoke.");
    }
    if (workspace.billing?.paymentStatus === "paid") {
        throw ApiError.badRequest("Cannot revoke access for a workspace whose payment is already marked as paid.");
    }
    if (workspace.accessRevoked) {
        throw ApiError.badRequest("Organization access is already revoked.");
    }
    if (!workspace.billing?.firstFollowUpSentAt || !workspace.billing?.secondFollowUpSentAt) {
        throw ApiError.badRequest("Both the 1st and 2nd payment follow-up emails must be sent before revoking organization access.");
    }

    const cleanReason =
        String(reason || "").trim() ||
        "Paid subscription balance remained unsettled after 1st and 2nd payment follow-up notices.";

    const now = new Date();
    workspace.accessRevoked = true;
    workspace.accessRevokedAt = now;
    workspace.accessRevokedReason = cleanReason;
    workspace.accessRevokedBy = superAdminId;
    workspace.billing = workspace.billing || {};
    workspace.billing.paymentStatus = "revoked";
    await workspace.save();

    if (workspace.owner?.email) {
        try {
            await sendMail({
                to: workspace.owner.email,
                subject: `[Access Suspended] ${workspace.companyName} Workspace Access Temporarily Revoked`,
                html: `
                    <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #fecaca; border-radius: 12px; background: #fff;">
                        <h2 style="margin: 0 0 16px; color: #b91c1c;">Organization Access Temporarily Suspended</h2>
                        <p>Dear ${escapeHtml(workspace.owner.fullName || "Administrator")},</p>
                        <p>Login and system access for <strong>${escapeHtml(workspace.companyName)}</strong> (<strong>${escapeHtml(planCfg.planName)}</strong>) has been temporarily suspended due to an unresolved subscription payment following our 1st and 2nd follow-up reminders.</p>
                        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin: 18px 0;">
                            <p style="margin: 0; color: #334155; font-size: 14px;"><strong>Your Data Is Safe:</strong> No employee profiles, payroll records, attendance logs, or encrypted documents have been deleted. Once payment is confirmed, your entire organization's access will be restored immediately.</p>
                        </div>
                        <p><strong>Settle Payment & Restore Access:</strong><br/>WhatsApp: +92 344 5959967<br/>Email: corpilance.org@gmail.com</p>
                    </div>
                `,
            });
        } catch (err) {
            console.error("Failed to send workspace revocation notice:", err?.message);
        }
    }

    await recordAuditLog({
        superAdmin: superAdminId,
        action: "WORKSPACE_ACCESS_REVOKED",
        status: "warning",
        req,
        details: {
            workspaceId: workspace._id.toString(),
            companyName: workspace.companyName,
            plan: planCfg.plan,
            reason: cleanReason,
            nonDestructive: true,
        },
    });

    return {
        workspaceId: workspace._id.toString(),
        accessRevoked: true,
        accessRevokedAt: now,
        accessRevokedReason: cleanReason,
        billing: buildBillingSummary(workspace, planCfg),
    };
}

/**
 * Restores access for a previously revoked organization (and optionally marks invoice paid).
 */
export async function restoreWorkspaceAccess({ workspaceId, markPaid = true, notes = "", superAdminId, req }) {
    const workspace = await Workspace.findById(workspaceId).populate("owner", "fullName email");
    if (!workspace) {
        throw ApiError.notFound("Workspace not found");
    }

    const planCfg = resolvePlanConfig(workspace.subscription);
    const now = new Date();
    const wasRevoked = Boolean(workspace.accessRevoked);

    workspace.accessRevoked = false;
    workspace.accessRevokedAt = null;
    workspace.accessRevokedReason = "";
    workspace.billing = workspace.billing || {};
    workspace.billing.restoredAt = now;

    if (markPaid) {
        workspace.billing.paymentStatus = planCfg.isPaid ? "paid" : "none";
        workspace.billing.paidAt = now;
        workspace.billing.markedPaidBy = superAdminId;
    } else if (planCfg.isPaid && workspace.billing.paymentStatus === "revoked") {
        workspace.billing.paymentStatus = "unpaid";
    }

    if (notes && String(notes).trim()) {
        workspace.billing.notes = String(notes).trim();
    }

    await workspace.save();

    if (wasRevoked && workspace.owner?.email) {
        try {
            await sendMail({
                to: workspace.owner.email,
                subject: `[Access Restored] ${workspace.companyName} Workspace Is Active Again`,
                html: `
                    <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; margin: auto; padding: 28px; border: 1px solid #bbf7d0; border-radius: 12px; background: #fff;">
                        <h2 style="margin: 0 0 16px; color: #059669;">Organization Access Restored</h2>
                        <p>Dear ${escapeHtml(workspace.owner.fullName || "Administrator")},</p>
                        <p>Thank you for settling your subscription payment. Full system access for <strong>${escapeHtml(workspace.companyName)}</strong> (${escapeHtml(planCfg.planName)}) has been restored.</p>
                        <p>All team members (CEO, HR, Managers, and Employees) can sign in immediately with all data intact.</p>
                    </div>
                `,
            });
        } catch (err) {
            console.error("Failed to send workspace restoration notice:", err?.message);
        }
    }

    await recordAuditLog({
        superAdmin: superAdminId,
        action: wasRevoked ? "WORKSPACE_ACCESS_RESTORED" : "WORKSPACE_PAYMENT_MARKED_PAID",
        status: "success",
        req,
        details: {
            workspaceId: workspace._id.toString(),
            companyName: workspace.companyName,
            plan: planCfg.plan,
            markPaid: Boolean(markPaid),
            wasRevoked,
        },
    });

    return {
        workspaceId: workspace._id.toString(),
        accessRevoked: false,
        billing: buildBillingSummary(workspace, planCfg),
    };
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
