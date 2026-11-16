import mongoose from "mongoose";

const { Schema, model } = mongoose;

const superAdmin2FACodeSchema = new Schema(
    {
        superAdmin: {
            type: Schema.Types.ObjectId,
            ref: "SuperAdmin",
            required: true,
            index: true,
        },
        codeHash: {
            type: String,
            required: true,
        },
        tempToken: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        attempts: {
            type: Number,
            default: 0,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: { expires: 0 }, // MongoDB TTL index auto-deletes expired codes
        },
    },
    { timestamps: true }
);

export const SuperAdmin2FACode = model("SuperAdmin2FACode", superAdmin2FACodeSchema);
