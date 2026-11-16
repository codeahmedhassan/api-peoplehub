import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const { Schema, model } = mongoose;

const superAdminSchema = new Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        password: {
            type: String,
            required: true,
            select: false,
        },
        fullName: {
            type: String,
            required: true,
            trim: true,
        },
        role: {
            type: String,
            enum: ["superadmin", "security_admin", "auditor"],
            default: "superadmin",
        },
        status: {
            type: String,
            enum: ["active", "suspended", "locked"],
            default: "active",
        },
        twoFactorEnabled: {
            type: Boolean,
            default: true,
        },
        failedLoginAttempts: {
            type: Number,
            default: 0,
        },
        lockUntil: {
            type: Date,
            default: null,
        },
        lastLoginAt: {
            type: Date,
            default: null,
        },
        lastLoginIp: {
            type: String,
            default: "",
        },
        lastActiveAt: {
            type: Date,
            default: null,
        },
        tokenVersion: {
            type: Number,
            default: 0,
        },
    },
    { timestamps: true }
);

// Hash password before saving if modified
superAdminSchema.pre("save", async function (next) {
    if (!this.isModified("password")) return next();
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Compare password
superAdminSchema.methods.comparePassword = async function (candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Check if locked
superAdminSchema.methods.isLocked = function () {
    return Boolean(this.lockUntil && this.lockUntil.getTime() > Date.now());
};

// Increment failed attempts & lock if >= 5
superAdminSchema.methods.incFailedAttempts = async function () {
    const MAX_ATTEMPTS = 5;
    const LOCK_TIME_MS = 30 * 60 * 1000; // 30 minutes lockout

    this.failedLoginAttempts += 1;
    if (this.failedLoginAttempts >= MAX_ATTEMPTS) {
        this.status = "locked";
        this.lockUntil = new Date(Date.now() + LOCK_TIME_MS);
    }
    return this.save();
};

// Reset failed attempts & lock
superAdminSchema.methods.resetLock = async function () {
    this.failedLoginAttempts = 0;
    this.lockUntil = null;
    if (this.status === "locked") {
        this.status = "active";
    }
    return this.save();
};

superAdminSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        email: this.email,
        fullName: this.fullName,
        role: this.role,
        status: this.status,
        twoFactorEnabled: this.twoFactorEnabled,
        lastLoginAt: this.lastLoginAt,
        createdAt: this.createdAt,
    };
};

export const SuperAdmin = model("SuperAdmin", superAdminSchema);
