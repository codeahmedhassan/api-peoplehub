import mongoose from "mongoose";
import { USER_STATUS, SIGNUP_COMPANY_SIZES, SIGNUP_ROLES } from "../../constants/index.js";
import { SYSTEM_ROLES } from "../../constants/employee.js";

const { Schema, model } = mongoose;

const ALL_COMPANY_SIZES = Array.from(new Set([
    ...SIGNUP_COMPANY_SIZES,
    "solo",
    "small",
    "growing",
    "midsize",
    "large",
    "enterprise",
]));

const ALL_ROLES = Array.from(new Set([
    ...SIGNUP_ROLES,
    ...SYSTEM_ROLES,
    "Admin",
    "Manager",
    "HR",
    "Employee",
    "Viewer",
    "Administrator",
]));

const emergencyContactSchema = new Schema(
    {
        name: { type: String, default: "", trim: true },
        relationship: { type: String, default: "", trim: true },
        phone: { type: String, default: "", trim: true },
    },
    { _id: false }
);

const userSchema = new Schema(
    {
        fullName: {
            type: String,
            required: [true, "Full name is required"],
            trim: true,
            minlength: 2,
            maxlength: 100,
        },
        displayName: {
            type: String,
            trim: true,
            default: "",
        },
        phone: {
            type: String,
            trim: true,
            default: "",
        },
        emergencyContact: {
            type: emergencyContactSchema,
            default: () => ({ name: "", relationship: "", phone: "" }),
        },
        notificationPreferences: {
            type: Schema.Types.Mixed,
            default: () => ({}),
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
            required: false, // allow removing password when access is revoked
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
            enum: ALL_COMPANY_SIZES,
        },
        role: {
            type: String,
            required: true,
            enum: ALL_ROLES,
        },
        systemRole: {
            type: String,
            enum: [...SYSTEM_ROLES, "Admin", "Manager", "HR", "Employee", "Viewer", "Administrator"],
            default: "Admin",
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
        twoFactorEnabled: {
            type: Boolean,
            default: false,
        },
        twoFactorCode: {
            type: String,
            select: false,
            default: null,
        },
        twoFactorExpires: {
            type: Date,
            select: false,
            default: null,
        },
        twoFactorAttempts: {
            type: Number,
            select: false,
            default: 0,
        },
        activeSessions: {
            type: [
                {
                    sessionId: { type: String, required: true },
                    device: { type: String, default: "Desktop" },
                    browser: { type: String, default: "Web Browser" },
                    os: { type: String, default: "Unknown OS" },
                    ip: { type: String, default: "127.0.0.1" },
                    location: { type: String, default: "Local Network" },
                    lastActiveAt: { type: Date, default: Date.now },
                },
            ],
            default: [],
        },
        lastLoginAt: Date,
        // Set once the user finishes the /setup-workspace flow or accepts an invite.
        setupCompletedAt: {
            type: Date,
            default: null,
        },
        avatar: {
            type: String,
            default: "",
        },
        // The workspace this user belongs to (whether owner or employee)
        workspaceId: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            default: null,
            index: true,
        },
        permissions: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },
        legalAcceptance: {
            termsAccepted: { type: Boolean, default: false },
            termsVersion: { type: String, default: "1.0" },
            privacyAccepted: { type: Boolean, default: false },
            privacyVersion: { type: String, default: "1.0" },
            acceptedAt: { type: Date, default: null },
            ipAddress: { type: String, default: "" },
        },
    },
    { timestamps: true }
);

userSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        fullName: this.fullName,
        displayName: this.displayName || this.fullName,
        phone: this.phone || "",
        emergencyContact: this.emergencyContact || { name: "", relationship: "", phone: "" },
        notificationPreferences: this.notificationPreferences || {},
        email: this.email,
        company: this.company,
        companySize: this.companySize,
        role: this.systemRole || this.role,
        systemRole: this.systemRole || this.role,
        permissions: this.permissions || {},
        avatar: this.avatar || "",
        status: this.status,
        emailVerified: this.emailVerified,
        twoFactorEnabled: Boolean(this.twoFactorEnabled),
        setupCompletedAt: this.setupCompletedAt,
        workspaceId: this.workspaceId,
        createdAt: this.createdAt,
    };
};

export const User = model("User", userSchema);
