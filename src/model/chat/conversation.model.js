// src/model/chat/conversation.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const conversationSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        participants: [
            {
                type: Schema.Types.ObjectId,
                ref: "User",
                required: true,
            },
        ],
        lastMessage: {
            text: { type: String, default: "" },
            sender: { type: Schema.Types.ObjectId, ref: "User", default: null },
            createdAt: { type: Date, default: Date.now },
        },
        unreadCounts: {
            type: Map,
            of: Number,
            default: () => new Map(),
        },
        initiatedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        metadata: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },
    },
    {
        timestamps: true,
    }
);

conversationSchema.index({ workspace: 1, participants: 1 });
conversationSchema.index({ workspace: 1, updatedAt: -1 });

export const Conversation = model("Conversation", conversationSchema);
