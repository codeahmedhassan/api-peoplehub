import { Router } from "express";
import {
    getDevices,
    createDevice,
    revokeDevice,
    getDeviceLinks,
    saveDeviceLink,
} from "../../controllers/attendance/device.controller.js";
import { requireAuth, requirePermission, requireAnyPermission } from "../../middleware/auth/auth.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { createDeviceSchema, saveLinkSchema } from "../../validators/attendance/device.validator.js";

const router = Router();

router.use(requireAuth);

router.get(
    "/",
    requireAnyPermission([
        ["devices", "view"],
        ["employees", "create"],
        ["employees", "edit"],
        ["attendance", "view"],
    ]),
    getDevices
);
router.post(
    "/",
    requireAnyPermission([
        ["devices", "create"],
        ["devices", "manage"],
    ]),
    validate(createDeviceSchema),
    createDevice
);
router.delete(
    "/:id",
    requirePermission("devices", "manage"),
    revokeDevice
);

router.get(
    "/:id/links",
    requireAnyPermission([
        ["devices", "view"],
        ["devices", "manage"],
    ]),
    getDeviceLinks
);
router.post(
    "/:id/links",
    requirePermission("devices", "manage"),
    validate(saveLinkSchema),
    saveDeviceLink
);

export default router;