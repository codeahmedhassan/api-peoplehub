import { Router } from "express";
import {
    listAttendanceController,
    summaryController,
    todayController,
    markAttendanceController,
    exportController,
    rollupController,
} from "../../controllers/attendance/attendance.controller.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { noCache } from "../../middleware/cache/no-cache.middleware.js";
import { validateQuery } from "../../middleware/validate/validate.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { handleDevicePunch } from "../../controllers/attendance/device.controller.js";
import {
    listAttendanceQuerySchema,
    summaryQuerySchema,
    markAttendanceSchema,
    exportQuerySchema,
} from "../../validators/attendance/attendance.validator.js";

const router = Router();

// All attendance endpoints change constantly (device punches, manual marks,
// rollup jobs). None of them should ever be cached.
router.use(noCache);

router.post("/device/punch", handleDevicePunch);

router.get("/", requireAuth, validateQuery(listAttendanceQuerySchema), listAttendanceController);
router.get("/summary", requireAuth, validateQuery(summaryQuerySchema), summaryController);
router.get("/today", requireAuth, todayController);
router.get("/export", requireAuth, validateQuery(exportQuerySchema), exportController);

router.post("/mark", requireAuth, validate(markAttendanceSchema), markAttendanceController);
router.post("/rollup", requireAuth, rollupController);

export default router;