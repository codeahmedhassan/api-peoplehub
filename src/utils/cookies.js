import { env } from "../config/env.js";
import { COOKIE_NAMES } from "../constants/index.js";

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;
// "Keep me signed in" → 30 days
const REFRESH_REMEMBER_ME_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNUP_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

function baseCookieOptions(maxAge) {
    return {
        httpOnly: true,
        secure: env.cookie.secure,
        sameSite: env.cookie.sameSite,
        path: "/",
        maxAge, // when undefined → session cookie (dies on browser close)
        domain: env.isProd ? env.cookie.domain : undefined,
    };
}

/**
 * Sets the access + refresh cookies.
 * When `rememberMe` is false, the refresh cookie becomes a session cookie
 * (no Max-Age) so it's discarded when the browser closes. Access token is
 * always short-lived (15 min) regardless.
 */
export function setAuthCookies(res, { accessToken, refreshToken, rememberMe = false }) {
    // When the user did NOT tick "Keep me signed in":
    //   - both cookies become session cookies (no Max-Age)
    //   - closing the browser discards them → logged out immediately
    // When the user DID tick "Keep me signed in":
    //   - the access cookie stays a session cookie (short-lived JWT anyway)
    //   - the refresh cookie gets Max-Age = 30 days so it survives browser close
    const accessMaxAge = undefined; // session cookie either way
    const refreshMaxAge = rememberMe ? REFRESH_REMEMBER_ME_MAX_AGE_MS : undefined;

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