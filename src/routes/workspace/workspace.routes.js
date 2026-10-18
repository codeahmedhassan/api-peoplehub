// src/routes/workspace/workspace.routes.js
import { Router } from "express";
import {
    setupWorkspaceController,
    getMyWorkspaceController,
} from "../../controllers/workspace/workspace.controller.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { setupWorkspaceSchema } from "../../validators/workspace/workspace.validator.js";

const router = Router();

// Both require a logged-in user.
// The service additionally checks emailVerified.
router.post(
    "/setup",
    requireAuth,
    validate(setupWorkspaceSchema),
    setupWorkspaceController
);

router.get("/me", requireAuth, getMyWorkspaceController);

export default router;