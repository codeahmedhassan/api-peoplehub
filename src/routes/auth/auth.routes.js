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
} from "../../controllers/auth/auth.controller.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import {
    signupLimiter,
    verifyEmailLimiter,
    resendLimiter,
    loginIpLimiter,
    loginEmailLimiter,
} from "../../middleware/rateLimit/rateLimit.middleware.js";
import {
    signupSchema,
    verifyEmailSchema,
    loginSchema,
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

router.get("/me", requireAuth, meController);
router.get("/session", sessionController);

router.post("/logout", logoutController);
router.post("/refresh", refreshController);
router.post("/invite/verify", verifyInviteController);
router.post("/invite/accept", acceptInviteController);

export default router;