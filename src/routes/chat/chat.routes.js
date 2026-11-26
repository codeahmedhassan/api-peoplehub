// src/routes/chat/chat.routes.js
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import {
    getContactsController,
    verifyEmployeeForHrController,
    getConversationsController,
    startConversationController,
    getMessagesController,
    sendMessageController,
    markReadController,
    getUnreadCountController,
    getVoicePresignController,
    completeVoiceMessageController,
    uploadDirectVoiceController,
    streamVoiceMessageController,
    uploadAttachmentController,
    streamAttachmentController,
} from "../../controllers/chat/chat.controller.js";

const router = Router();
const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB ceiling; plan tier enforces 5/10/15/25 MB

router.use(requireAuth);

router.get("/contacts", getContactsController);
router.post("/verify-employee", verifyEmployeeForHrController);
router.get("/conversations", getConversationsController);
router.post("/conversations", startConversationController);
router.get("/conversations/:id/messages", getMessagesController);
router.post("/conversations/:id/messages", sendMessageController);
router.post("/conversations/:id/read", markReadController);
router.get("/unread-count", getUnreadCountController);

// Voice recording presigned upload & streaming routes
router.post("/conversations/:id/voice/presign", getVoicePresignController);
router.post("/conversations/:id/voice/complete", completeVoiceMessageController);
router.post("/conversations/:id/voice/upload", upload.single("audio"), uploadDirectVoiceController);
router.get("/messages/:id/voice", streamVoiceMessageController);

// Encrypted chat attachment routes (Paid Pro Plan feature)
router.post("/conversations/:id/attachments", upload.single("file"), uploadAttachmentController);
router.get("/messages/:id/attachments/:fileId", streamAttachmentController);

export default router;
