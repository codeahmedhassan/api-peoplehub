// src/controllers/chat/chat.controller.js
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import {
    getEligibleContacts,
    verifyEmployeeForHrChat,
    startOrGetConversation,
    getUserConversations,
    getConversationMessages,
    sendMessage,
    markConversationAsRead,
    getTotalUnreadCount,
    getVoicePresignedUploadUrl,
    completeVoiceMessage,
    uploadDirectVoiceMessage,
    getVoiceMessageStream,
    uploadChatAttachment,
    getAttachmentStream,
} from "../../services/chat/chat.service.js";

export const getContactsController = asyncHandler(async (req, res) => {
    const { search, category } = req.query;
    const result = await getEligibleContacts(req.userId, { search, category });
    return res.status(200).json(new ApiResponse(200, result, "Eligible contacts loaded"));
});

export const verifyEmployeeForHrController = asyncHandler(async (req, res) => {
    const { workEmail } = req.body;
    const result = await verifyEmployeeForHrChat(req.userId, workEmail);
    return res.status(200).json(new ApiResponse(200, result, "Employee verified for chat"));
});

export const getConversationsController = asyncHandler(async (req, res) => {
    const result = await getUserConversations(req.userId);
    return res.status(200).json(new ApiResponse(200, result, "Conversations loaded"));
});

export const startConversationController = asyncHandler(async (req, res) => {
    const { recipientId, employeeWorkEmail } = req.body;
    const result = await startOrGetConversation(req.userId, { recipientId, employeeWorkEmail });
    return res.status(200).json(new ApiResponse(200, result, "Conversation ready"));
});

export const getMessagesController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { limit, before } = req.query;
    const result = await getConversationMessages(req.userId, id, { limit, before });
    return res.status(200).json(new ApiResponse(200, result, "Messages loaded"));
});

export const sendMessageController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { text } = req.body;
    const result = await sendMessage(req.userId, id, { text });
    return res.status(201).json(new ApiResponse(201, result, "Message sent"));
});

export const markReadController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await markConversationAsRead(req.userId, id);
    return res.status(200).json(new ApiResponse(200, result, "Marked as read"));
});

export const getUnreadCountController = asyncHandler(async (req, res) => {
    const result = await getTotalUnreadCount(req.userId);
    return res.status(200).json(new ApiResponse(200, result, "Unread count loaded"));
});

export const getVoicePresignController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await getVoicePresignedUploadUrl(req.userId, id, req.body);
    return res.status(200).json(new ApiResponse(200, result, "Voice presigned upload URL generated"));
});

export const completeVoiceMessageController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await completeVoiceMessage(req.userId, id, req.body);
    return res.status(201).json(new ApiResponse(201, result, "Voice message sent"));
});

export const uploadDirectVoiceController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.file || !req.file.buffer) {
        throw ApiError.badRequest("Voice audio recording file is required.");
    }
    const duration = Number(req.body.duration) || 0;
    const mimeType = req.file.mimetype || "audio/webm";
    const result = await uploadDirectVoiceMessage(req.userId, id, {
        buffer: req.file.buffer,
        duration,
        mimeType,
    });
    return res.status(201).json(new ApiResponse(201, result, "Voice message uploaded"));
});

export const streamVoiceMessageController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { buffer, mimeType } = await getVoiceMessageStream(req.userId, id);

    const total = buffer.length;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
        const chunk = buffer.subarray(start, end + 1);

        res.status(206);
        res.set({
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": chunk.length,
            "Content-Type": mimeType || "audio/webm",
            "Cache-Control": "private, max-age=3600",
        });
        return res.send(chunk);
    }

    res.set({
        "Content-Type": mimeType || "audio/webm",
        "Content-Length": total,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
    });

    return res.status(200).send(buffer);
});

export const uploadAttachmentController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!req.file || !req.file.buffer) {
        throw ApiError.badRequest("Attachment file is required.");
    }
    const result = await uploadChatAttachment(req.userId, id, {
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype || "application/octet-stream",
        fileSize: req.file.size,
    });
    return res.status(201).json(new ApiResponse(201, result, "Attachment uploaded successfully"));
});

export const streamAttachmentController = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    const { buffer, mimeType, fileName } = await getAttachmentStream(req.userId, id, fileId);

    res.set({
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Length": buffer.length,
        "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
        "Cache-Control": "private, max-age=86400",
    });

    return res.status(200).send(buffer);
});

