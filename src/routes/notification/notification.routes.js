// src/routes/notification/notification.routes.js
import { Router } from "express";
import {
    getMyNotificationsController,
    markAsReadController,
    markAllAsReadController,
} from "../../controllers/notification/notification.controller.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";

const router = Router();

router.get("/", requireAuth, getMyNotificationsController);
router.patch("/read-all", requireAuth, markAllAsReadController);
router.patch("/:id/read", requireAuth, markAsReadController);

export default router;
