import bcrypt from "bcryptjs";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
    createEmailVerifyToken,
    verifyEmailVerifyToken,
} from "../../utils/emailToken.js";
import { createSignupPendingToken } from "../../utils/signupToken.js";
import { createAccessToken, createRefreshToken } from "../../utils/tokens.js";
import { sendVerificationEmail } from "../email/email.service.js";

// Dummy hash used to make failed logins constant-time.
// Generated from "not-a-real-password" with bcrypt cost 12.
const DUMMY_HASH = "$2a$12$w5cF.BK8CellV78J3lVxGu3ILPlhhzKWSmW4Z2lgNKUAWere3RGb6";

export async function registerUser(payload) {
    const { fullName, email, password, company, companySize, role } = payload;

    const existing = await User.findOne({ email }).lean();
    if (existing) {
        // If they signed up but never verified, we still reject to prevent enumeration.
        // (You could optionally resend, but that leaks existence. Keep it simple and consistent.)
        throw ApiError.conflict("An account with this email already exists");
    }

    const hashed = await hashPassword(password);

    const user = await User.create({
        fullName,
        email,
        password: hashed,
        company,
        companySize,
        role,
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

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);

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
    return user || null; // hydrated doc, has toSafeJSON
}

export async function loginUser({ email, password }) {
    // Load with password (field has select:false by default).
    const user = await User.findOne({ email }).select("+password");

    // Timing-safe: if no user, still run bcrypt.compare against a dummy hash
    // so response time is the same as a wrong-password attempt.
    if (!user) {
        await bcrypt.compare(password, DUMMY_HASH).catch(() => { });
        throw ApiError.unauthorized("Invalid email or password");
    }

    const ok = await verifyPassword(password, user.password);
    if (!ok) {
        // Same message as "user doesn't exist" — prevents enumeration.
        throw ApiError.unauthorized("Invalid email or password");
    }

    if (!user.emailVerified) {
        const pendingToken = createSignupPendingToken(user);
        return { requiresVerification: true, user, pendingToken };
    }

    if (user.status === "suspended") {
        throw ApiError.forbidden("Your account has been suspended");
    }

    // Record the login for security auditing.
    user.lastLoginAt = new Date();
    await user.save();

    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);

    return { user, accessToken, refreshToken };
}