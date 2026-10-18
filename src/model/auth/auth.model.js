import mongoose from "mongoose";
import { USER_STATUS, SIGNUP_COMPANY_SIZES, SIGNUP_ROLES } from "../../constants/index.js";

const { Schema, model } = mongoose;

const userSchema = new Schema(
    {
        fullName: {
            type: String,
            required: [true, "Full name is required"],
            trim: true,
            minlength: 2,
            maxlength: 100,
        },
        email: {
            type: String,
            required: [true, "Email is required"],
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        password: {
            type: String,
            required: [true, "Password is required"],
            select: false, // never returned by default
        },
        company: {
            type: String,
            required: [true, "Company is required"],
            trim: true,
            maxlength: 150,
        },
        companySize: {
            type: String,
            required: true,
            enum: SIGNUP_COMPANY_SIZES,
        },
        role: {
            type: String,
            required: true,
            enum: SIGNUP_ROLES,
        },
        status: {
            type: String,
            enum: Object.values(USER_STATUS),
            default: USER_STATUS.PENDING,
        },
        emailVerified: {
            type: Boolean,
            default: false,
        },
        // used for "sign out from all devices" later
        tokenVersion: {
            type: Number,
            default: 0,
        },
        lastLoginAt: Date,
        // Set once the user finishes the /setup-workspace flow.
        // We don't put workspaceId here — the Workspace model references the user.
        setupCompletedAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        fullName: this.fullName,
        email: this.email,
        company: this.company,
        companySize: this.companySize,
        role: this.role,
        status: this.status,
        emailVerified: this.emailVerified,
        setupCompletedAt: this.setupCompletedAt || null,
        createdAt: this.createdAt,
    };
};

export const User = model("User", userSchema);