import { Router } from "express";
import {
    signup,
    loginController,
    verifyEmailController,
    resendVerificationController,
    meController,
    pendingSignupInfoController,
    logoutController,
    sessionController,
    refreshController,
    verifyInviteController,
    acceptInviteController,
    updateProfileController,
    changePasswordController,
    logoutAllDevicesController,
    updateNotificationPreferencesController,
    toggleTwoFactorController,
    verify2FAController,
    resend2FAController,
    getPending2FAController,
    getSessionsController,
    forgotPasswordController,
    resetPasswordController,
} from "../../controllers/auth/auth.controller.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import {
    signupLimiter,
    verifyEmailLimiter,
    resendLimiter,
    loginIpLimiter,
    loginEmailLimiter,
    authChallengeLimiter,
    refreshLimiter,
} from "../../middleware/rateLimit/rateLimit.middleware.js";
import {
    signupSchema,
    verifyEmailSchema,
    loginSchema,
    forgotPasswordSchema,
    resetPasswordSchema,
} from "../../validators/auth/auth.validator.js";
import {
    requireAuth,
    requirePendingSignup,
} from "../../middleware/auth/auth.middleware.js";

const router = Router();

router.post("/signup", signupLimiter, validate(signupSchema), signup);

router.post(
    "/login",
    loginIpLimiter,
    loginEmailLimiter,
    validate(loginSchema),
    loginController
);

router.post(
    "/verify-email",
    verifyEmailLimiter,
    validate(verifyEmailSchema),
    verifyEmailController
);

router.post("/resend-verification", resendLimiter, requirePendingSignup, resendVerificationController);

router.get("/pending-signup", requirePendingSignup, pendingSignupInfoController);

// Two-Factor Authentication endpoints
router.post("/2fa/verify", authChallengeLimiter, verify2FAController);
router.post("/2fa/resend", resendLimiter, resend2FAController);
router.get("/2fa/pending", authChallengeLimiter, getPending2FAController);
router.patch("/2fa/toggle", requireAuth, toggleTwoFactorController);

// Session endpoints
router.get("/me", requireAuth, meController);
router.get("/session", sessionController);
router.get("/sessions", requireAuth, getSessionsController);

router.post("/logout", logoutController);
router.post("/refresh", refreshLimiter, refreshController);
router.post("/invite/verify", authChallengeLimiter, verifyInviteController);
router.post("/invite/accept", authChallengeLimiter, acceptInviteController);
router.post("/forgot-password", resendLimiter, validate(forgotPasswordSchema), forgotPasswordController);
router.post("/reset-password", authChallengeLimiter, validate(resetPasswordSchema), resetPasswordController);

router.patch("/profile", requireAuth, updateProfileController);
router.post("/change-password", requireAuth, changePasswordController);
router.post("/logout-all", requireAuth, logoutAllDevicesController);
router.patch("/notification-preferences", requireAuth, updateNotificationPreferencesController);

export default router;
