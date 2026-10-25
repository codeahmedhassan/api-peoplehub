import { Router } from "express";
import {
    getDevices,
    createDevice,
    revokeDevice,
    getDeviceLinks,
    saveDeviceLink,
} from "../../controllers/attendance/device.controller.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { createDeviceSchema, saveLinkSchema } from "../../validators/attendance/device.validator.js";

const router = Router();

router.get("/", requireAuth, getDevices);
router.post("/", requireAuth, validate(createDeviceSchema), createDevice);
router.delete("/:id", requireAuth, revokeDevice);

router.get("/:id/links", requireAuth, getDeviceLinks);
router.post("/:id/links", requireAuth, validate(saveLinkSchema), saveDeviceLink);

export default router;