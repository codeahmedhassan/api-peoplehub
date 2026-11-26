import { Router } from "express";
import {
    getDevices,
    createDevice,
    revokeDevice,
    getDeviceLinks,
    saveDeviceLink,
} from "../../controllers/attendance/device.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth/auth.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { createDeviceSchema, saveLinkSchema } from "../../validators/attendance/device.validator.js";

const router = Router();

router.use(requireAuth, requirePermission("attendance", "edit"));

router.get("/", getDevices);
router.post("/", validate(createDeviceSchema), createDevice);
router.delete("/:id", revokeDevice);

router.get("/:id/links", getDeviceLinks);
router.post("/:id/links", validate(saveLinkSchema), saveDeviceLink);

export default router;