import mongoose from "mongoose";
const { Schema, model } = mongoose;

const deviceLinkSchema = new Schema({
    workspace: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    device: { type: Schema.Types.ObjectId, ref: "Device", required: true, index: true },
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },

    // The ID the employee uses on the physical machine (e.g. fingerprint ID "42")
    deviceUserId: { type: String, required: true, trim: true }
}, { timestamps: true });

// One device user ID per device
deviceLinkSchema.index({ device: 1, deviceUserId: 1 }, { unique: true });
// One employee per device
deviceLinkSchema.index({ device: 1, employee: 1 }, { unique: true });

export const DeviceLink = model("DeviceLink", deviceLinkSchema);