import { env } from "../config/env.js";
import { COOKIE_NAMES } from "../constants/index.js";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
// "Keep me signed in" → 30 days
const REFRESH_REMEMBER_ME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNUP_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

function baseCookieOptions(maxAge) {
    const cookieDomain =
        env.isProd && env.cookie.domain && env.cookie.domain !== "localhost"
            ? env.cookie.domain
            : undefined;
    return {
        httpOnly: true,
        secure: env.isProd ? env.cookie.secure : false,
        sameSite: env.cookie.sameSite,
        path: "/",
        maxAge, // when undefined → session cookie (dies on browser close)
        domain: cookieDomain,
    };
}

/**
 * Sets the access + refresh cookies.
 * When `rememberMe` is false:
 *   - Both cookies become RFC 6265 session cookies (no Max-Age or Expires)
 *   - Closing / quitting Chrome immediately erases them from memory → user must sign in again
 * When `rememberMe` is true:
 *   - Both cookies receive Max-Age = 30 days and are persisted on disk across browser closures
 */
export function setAuthCookies(res, { accessToken, refreshToken, rememberMe = false }) {
    const isRemembered = Boolean(rememberMe);
    const accessMaxAge = isRemembered ? REFRESH_REMEMBER_ME_MAX_AGE_MS : undefined;
    const refreshMaxAge = isRemembered ? REFRESH_REMEMBER_ME_MAX_AGE_MS : undefined;

    res.cookie(
        COOKIE_NAMES.ACCESS_TOKEN,
        accessToken,
        baseCookieOptions(accessMaxAge)
    );

    res.cookie(
        COOKIE_NAMES.REFRESH_TOKEN,
        refreshToken,
        baseCookieOptions(refreshMaxAge)
    );
}

export function clearAuthCookies(res) {
    const opts = baseCookieOptions(0);
    res.clearCookie(COOKIE_NAMES.ACCESS_TOKEN, opts);
    res.clearCookie(COOKIE_NAMES.REFRESH_TOKEN, opts);
}

export function setSignupPendingCookie(res, token) {
    res.cookie(
        COOKIE_NAMES.SIGNUP_PENDING,
        token,
        baseCookieOptions(SIGNUP_PENDING_MAX_AGE_MS)
    );
}

export function clearSignupPendingCookie(res) {
    res.clearCookie(COOKIE_NAMES.SIGNUP_PENDING, baseCookieOptions(0));
}

const TWO_FACTOR_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export function set2FAPendingCookie(res, token) {
    res.cookie(
        COOKIE_NAMES.TWO_FACTOR_PENDING,
        token,
        baseCookieOptions(TWO_FACTOR_PENDING_MAX_AGE_MS)
    );
}

export function clear2FAPendingCookie(res) {
    res.clearCookie(COOKIE_NAMES.TWO_FACTOR_PENDING, baseCookieOptions(0));
}
