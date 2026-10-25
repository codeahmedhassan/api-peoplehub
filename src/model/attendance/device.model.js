import mongoose from "mongoose";
import crypto from "node:crypto";

const { Schema, model } = mongoose;

const deviceSchema = new Schema({
    workspace: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true }, // e.g. "Main Entrance"
    location: { type: String, trim: true, default: "" },

    // The API key the device uses to authenticate
    apiKeyHash: { type: String, required: true },
    apiKeyPrefix: { type: String, required: true }, // For UI display e.g. "dev_abc1..."

    lastSeenAt: { type: Date, default: null },
    status: { type: String, enum: ["active", "revoked"], default: "active" }
}, { timestamps: true });

// Helper to generate a secure API key
deviceSchema.statics.generateApiKey = function () {
    const rawKey = `dev_${crypto.randomBytes(24).toString("hex")}`;
    const hash = crypto.createHash("sha256").update(rawKey).digest("hex");
    const prefix = rawKey.substring(0, 12);
    return { rawKey, hash, prefix };
};

export const Device = model("Device", deviceSchema);