import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

function getSessionOrIpKey(req) {
    if (req.userId) return `u:${req.userId}`;
    const token = req.cookies?.ph_at || req.cookies?.ph_rt || req.cookies?.ph_sa_at;
    if (token) {
        const digest = crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 16);
        return `s:${digest}`;
    }
    return `ip:${req.ip}`;
}

export const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many signup attempts. Please try again later." },
});

export const verifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many verification attempts. Please try again later." },
});

export const resendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many resend requests. Please wait a bit." },
});

// -------------------------------------------------------------------
// Employee creation — 100 per 10 min per authenticated user
// -------------------------------------------------------------------
export const employeeCreateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.userId || req.ip,
    message: {
        success: false,
        message: "Too many employee creations. Please wait a bit.",
    },
});

/**
 * Broad IP-level limiter: 120 login attempts per IP per 15 min
 * so shared company WiFi / office teams are not blocked.
 */
export const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many login attempts. Please try again later.",
    },
});

/**
 * Per-email limiter: 15 attempts per email per 15 min.
 */
export const loginEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const raw = (req.body?.email || "").toString().trim().toLowerCase();
        return raw || req.ip;
    },
    message: {
        success: false,
        message: "Too many login attempts for this account. Please try again later.",
    },
});

export const superAdminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many Super Admin authentication attempts. Access temporarily restricted.",
    },
});

export const authChallengeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many verification or password reset requests. Please wait before trying again.",
    },
});

export const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: getSessionOrIpKey,
    message: {
        success: false,
        message: "Too many session refresh requests. Please sign in again shortly.",
    },
});

export const devicePunchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.headers["x-device-key"] || req.ip),
    message: {
        success: false,
        message: "Too many attendance punch requests from this device.",
    },
});

export const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/health",
    keyGenerator: getSessionOrIpKey,
    message: {
        success: false,
        message: "Rate limit exceeded. Please slow down requests and try again shortly.",
    },
});
