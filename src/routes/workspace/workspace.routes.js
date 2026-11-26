// src/routes/workspace/workspace.routes.js
import { Router } from "express";
import {
    setupWorkspaceController,
    getMyWorkspaceController,
    updateCompanyController,
    updateFinancialController,
    updateAttendanceSettingsController,
    updateModulesController,
    updatePayslipSettingsController,
    updateIntegrationsController,
    getWorkspaceUsersController,
    updateUserRoleController,
    getEmployeeIdSettingsController,
    updateEmployeeIdSettingsController,
    appointCeoController,
    updateCeoOverrideController,
    replaceCeoController,
    getWorkspacePlanController,
} from "../../controllers/workspace/workspace.controller.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import {
    setupWorkspaceSchema,
    updateAttendanceSettingsSchema,
    updateFinancialSchema,
    updateEmployeeIdSettingsSchema,
} from "../../validators/workspace/workspace.validator.js";

const router = Router();

router.post(
    "/setup",
    requireAuth,
    validate(setupWorkspaceSchema),
    setupWorkspaceController
);

router.get("/me", requireAuth, getMyWorkspaceController);

router.patch("/company", requireAuth, updateCompanyController);

router.patch(
    "/financial",
    requireAuth,
    validate(updateFinancialSchema),
    updateFinancialController
);

router.patch(
    "/attendance-settings",
    requireAuth,
    validate(updateAttendanceSettingsSchema),
    updateAttendanceSettingsController
);

router.patch("/modules", requireAuth, updateModulesController);

router.patch("/payslip-settings", requireAuth, updatePayslipSettingsController);

router.patch("/integrations", requireAuth, updateIntegrationsController);

router.get("/users", requireAuth, getWorkspaceUsersController);

router.patch("/users/:userId/role", requireAuth, updateUserRoleController);

router.get("/employee-id-settings", requireAuth, getEmployeeIdSettingsController);
router.patch(
    "/employee-id-settings",
    requireAuth,
    validate(updateEmployeeIdSettingsSchema),
    updateEmployeeIdSettingsController
);

router.post("/appoint-ceo", requireAuth, appointCeoController);
router.patch("/ceo-override", requireAuth, updateCeoOverrideController);
router.post("/replace-ceo", requireAuth, replaceCeoController);

router.get("/plan", requireAuth, getWorkspacePlanController);

export default router;
