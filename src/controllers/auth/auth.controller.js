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
} from "../../services/auth/auth.service.js";
import { verifyAccessToken } from "../../utils/tokens.js";
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