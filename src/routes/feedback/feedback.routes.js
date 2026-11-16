import { Router } from "express";
import {
    createFeedbackController,
    getMyFeedbacksController,
} from "../../controllers/feedback/feedback.controller.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";

const router = Router();

router.post("/", requireAuth, createFeedbackController);
router.get("/my", requireAuth, getMyFeedbacksController);

export default router;
