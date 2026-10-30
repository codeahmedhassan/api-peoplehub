import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import {
    setAuthCookies,
    setSignupPendingCookie,
    clearSignupPendingCookie,
    clearAuthCookies,
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
} from "../../services/auth/auth.service.js";
import { verifyAccessToken, createAccessToken, createRefreshToken } from "../../utils/tokens.js";
import { COOKIE_NAMES } from "../../constants/index.js";

export const signup = asyncHandler(async (req, res) => {
    const { user, pendingToken } = await registerUser(req.body);

    // Set the pending-signup cookie so the /verify-email page can know
    // "this browser just started a signup for <email>".
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
    clearSignupPendingCookie(res); // no longer pending

    return res.status(200).json(
        new ApiResponse(200, { user: user.toSafeJSON() }, "Email verified")
    );
});

/**
 * Requires requirePendingSignup middleware.
 * Reads email from the signed cookie, not from the URL or body.
 */
export const resendVerificationController = asyncHandler(async (req, res) => {
    await resendVerificationForUser(req.pendingUserId);

    return res
        .status(200)
        .json(new ApiResponse(200, null, "Verification email resent"));
});

/**
 * Requires requireAuth middleware.
 * Returns the current user (or null) so the frontend can gate pages.
 */
export const meController = asyncHandler(async (req, res) => {
    const user = await getSessionUser(req.userId);
    if (!user) {
        clearAuthCookies(res);
        res.set("Cache-Control", "no-store");
        return res.status(200).json(new ApiResponse(200, { user: null }, "No session"));
    }
    res.set("Cache-Control", "no-store");
    return res.status(200).json(new ApiResponse(200, { user: user.toSafeJSON() }, "Current user"));
});

// Public: returns { authenticated: boolean, user: {...} | null }
// Never 401s — always 200 with a boolean. Ideal for proxy.ts checks.
export const sessionController = asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");

    const token = req.cookies?.[COOKIE_NAMES.ACCESS_TOKEN];
    if (!token) {
        return res.status(200).json(
            new ApiResponse(200, { authenticated: false, user: null }, "No session")
        );
    }

    try {
        const decoded = verifyAccessToken(token);
        const user = await getSessionUser(decoded.sub);
        if (!user) {
            clearAuthCookies(res);
            return res.status(200).json(
                new ApiResponse(200, { authenticated: false, user: null }, "No session")
            );
        }
        return res.status(200).json(
            new ApiResponse(
                200,
                { authenticated: true, user: user.toSafeJSON() },
                "Session active"
            )
        );
    } catch {
        clearAuthCookies(res);
        return res.status(200).json(
            new ApiResponse(200, { authenticated: false, user: null }, "No session")
        );
    }
});

/**
 * Requires requireAuth middleware.
 * Returns the pending signup info for the /verify-email page.
 * This is what makes /verify-email gated on the backend.
 */
export const pendingSignupInfoController = asyncHandler(async (req, res) => {
    // requirePendingSignup middleware already populated these:
    return res.status(200).json(
        new ApiResponse(
            200,
            { email: req.pendingEmail },
            "Pending signup"
        )
    );
});

export const logoutController = asyncHandler(async (_req, res) => {
    clearAuthCookies(res);
    clearSignupPendingCookie(res);
    return res
        .status(200)
        .json(new ApiResponse(200, null, "Logged out"));
});

export const refreshController = asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[COOKIE_NAMES.REFRESH_TOKEN];

    if (!refreshToken) {
        throw ApiError.unauthorized("No refresh token provided");
    }

    const { accessToken, newRefreshToken } = await refreshSession(refreshToken);

    // Keep the "remember me" behavior if it was originally set.
    // If the refresh cookie had a Max-Age (30 days), `req.cookies` doesn't tell us that.
    // So we just re-set it based on whether the original login had rememberMe.
    // Since we don't store "rememberMe" in the token, we default to the refresh cookie's
    // remaining life. 
    // EASIER FIX: We'll check if the current refresh cookie is a session cookie or not.
    // Since we can't easily check that in Express, we just re-issue with rememberMe=true
    // if it was there, otherwise false. 
    // Actually, the best way: just always issue 30 days for refresh if it hits this route,
    // but let's keep it safe and mirror the config.

    // We'll use the existing `setAuthCookies` but we need to know if it was rememberMe.
    // To do this properly without breaking existing sessions, we'll just set the cookie
    // again with a 30-day maxAge if the request came from the rememberMe flow. But we don't know that here.
    // Solution: Pass rememberMe explicitly from the frontend on refresh, OR
    // just extend the refresh cookie's life on every refresh.
    // Let's extend it to 30 days on refresh, because if they hit refresh, they are active.

    setAuthCookies(res, {
        accessToken,
        refreshToken: newRefreshToken,
        rememberMe: true // Refresh route implies we want to keep them logged in
    });

    return res.status(200).json(new ApiResponse(200, null, "Session refreshed"));
});

/**
 * POST /auth/login
 * Body: { email, password, rememberMe }
 * Sets ph_at + ph_rt cookies and returns { user }.
 */
export const loginController = asyncHandler(async (req, res) => {
    const { email, password, rememberMe } = req.body;

    const result = await loginUser({ email, password });

    if (result.requiresVerification) {
        // Don't set auth cookies — the account isn't usable yet.
        // But do refresh the pending-signup cookie so /verify-email is reachable.
        setSignupPendingCookie(res, result.pendingToken);
        return res.status(200).json(
            new ApiResponse(
                200,
                { user: result.user.toSafeJSON(), requiresVerification: true },
                "Please verify your email before signing in"
            )
        );
    }

    const { user, accessToken, refreshToken } = result;
    setAuthCookies(res, { accessToken, refreshToken, rememberMe: Boolean(rememberMe) });
    return res
        .status(200)
        .json(new ApiResponse(200, { user: user.toSafeJSON() }, "Signed in"));
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

    // Log them in immediately after they set their password
    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user);
    setAuthCookies(res, { accessToken, refreshToken, rememberMe: true });

    return res.status(200).json(new ApiResponse(200, {
        user: user.toSafeJSON(),
    }, "Invite accepted. Welcome!"));
});