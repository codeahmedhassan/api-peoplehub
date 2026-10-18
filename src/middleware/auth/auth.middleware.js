// src/middleware/auth/auth.middleware.js
import { ApiError } from "../../utils/ApiError.js";
import { verifyAccessToken } from "../../utils/tokens.js";
import { verifySignupPendingToken } from "../../utils/signupToken.js";
import { COOKIE_NAMES } from "../../constants/index.js";
import { User } from "../../model/auth/auth.model.js";

export function requireAuth(req, _res, next) {
    const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
    if (!token) return next(ApiError.unauthorized("Not authenticated"));

    try {
        const decoded = verifyAccessToken(token);
        req.userId = decoded.sub;
        req.tokenVersion = decoded.ver ?? 0;
        return next();
    } catch {
        return next(ApiError.unauthorized("Session expired"));
    }
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
        req.user = user;
        return next();
    } catch (err) {
        return next(err);
    }
}