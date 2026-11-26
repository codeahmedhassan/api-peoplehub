import { Router } from "express";
import { requireAuth, requireVerifiedUser } from "../../middleware/auth/auth.middleware.js";
import { ingestEventController } from "../../controllers/analytics/analytics.controller.js";

const router = Router();

// Event ingestion requires valid user session so server can authenticate and attach organization identity
router.post("/events", requireAuth, requireVerifiedUser, ingestEventController);

export default router;
