import rateLimit from "express-rate-limit";

export const signupLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many signup attempts. Please try again later." },
});

export const verifyEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many verification attempts. Please try again later." },
});

export const resendLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many resend requests. Please wait a bit." },
});

// -------------------------------------------------------------------
// Employee creation — 20 per 10 min per user
// -------------------------------------------------------------------
export const employeeCreateLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Prefer authenticated user id; fall back to IP
        return req.userId || req.ip;
    },
    message: {
        success: false,
        message: "Too many employee creations. Please wait a bit.",
    },
});

/**
 * Broad IP-level limiter: 20 login attempts per IP per 15 min.
 * Prevents one IP from spraying credentials across many accounts.
 */
export const loginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many login attempts. Please try again later.",
    },
});

/**
 * Narrow per-email limiter: 5 attempts per email per 15 min.
 * Uses email from the request body as the key. Prevents one account
 * being brute-forced from many IPs.
 */
export const loginEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Normalize the email so casing/spacing can't bypass the limit.
        const raw = (req.body?.email || "").toString().trim().toLowerCase();
        return raw || req.ip;
    },
    // Returning JSON in the same envelope as other errors.
    message: {
        success: false,
        message: "Too many login attempts for this account. Please try again later.",
    },
});

export const superAdminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many Super Admin authentication attempts. Access temporarily restricted.",
    },
});