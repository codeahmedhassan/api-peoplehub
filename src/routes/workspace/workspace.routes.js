// src/routes/workspace/workspace.routes.js
import { Router } from "express";
import {
    setupWorkspaceController,
    getMyWorkspaceController,
    updateAttendanceSettingsController,
} from "../../controllers/workspace/workspace.controller.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import {
    setupWorkspaceSchema,
    updateAttendanceSettingsSchema,
} from "../../validators/workspace/workspace.validator.js";

const router = Router();

router.post(
    "/setup",
    requireAuth,
    validate(setupWorkspaceSchema),
    setupWorkspaceController
);

router.get("/me", requireAuth, getMyWorkspaceController);

router.patch(
    "/attendance-settings",
    requireAuth,
    validate(updateAttendanceSettingsSchema),
    updateAttendanceSettingsController
);

export default router;