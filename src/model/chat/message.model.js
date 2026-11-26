// src/model/chat/message.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const chatMessageSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        conversation: {
            type: Schema.Types.ObjectId,
            ref: "Conversation",
            required: true,
            index: true,
        },
        sender: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        messageType: {
            type: String,
            enum: ["text", "voice", "image", "video", "file"],
            default: "text",
        },
        text: {
            type: String,
            default: "",
            trim: true,
            maxlength: 4000,
        },
        voice: {
            s3Key: { type: String, trim: true },
            duration: { type: Number, default: 0 },
            size: { type: Number, default: 0 },
            mimeType: { type: String, default: "audio/webm" },
            iv: { type: String },
            authTag: { type: String },
            wrappedDek: { type: String },
            kekVersion: { type: Number, default: 1 },
        },
        attachments: [
            {
                fileId: { type: String },
                fileName: { type: String },
                fileSize: { type: Number, default: 0 },
                mimeType: { type: String, default: "application/octet-stream" },
                s3Key: { type: String, trim: true },
                iv: { type: String },
                authTag: { type: String },
                wrappedDek: { type: String },
                kekVersion: { type: Number, default: 1 },
            },
        ],
        deliveredTo: [
            {
                user: { type: Schema.Types.ObjectId, ref: "User" },
                deliveredAt: { type: Date, default: Date.now },
            },
        ],
        readBy: [
            {
                user: { type: Schema.Types.ObjectId, ref: "User" },
                readAt: { type: Date, default: Date.now },
            },
        ],
    },
    {
        timestamps: true,
    }
);

chatMessageSchema.index({ conversation: 1, createdAt: 1 });

export const ChatMessage = model("ChatMessage", chatMessageSchema);
