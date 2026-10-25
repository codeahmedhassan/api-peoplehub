// src/model/workspace/workspace.model.js
import mongoose from "mongoose";
import {
    SETUP_INDUSTRIES,
    SETUP_TIMEZONES,
    DEFAULT_WEEKEND_DAYS,
} from "../../constants/index.js";

const { Schema, model } = mongoose;

// -------------------------------------------------------------------
// Holiday sub-document: a specific calendar date that is a full-day holiday
// for the whole workspace. Marked via the attendance settings UI.
// -------------------------------------------------------------------
const holidaySchema = new Schema(
    {
        date: { type: String, required: true }, // "YYYY-MM-DD" in workspace TZ
        name: { type: String, required: true, trim: true, maxlength: 100 },
    },
    { _id: false }
);

// -------------------------------------------------------------------
// Attendance config sub-document.
// -------------------------------------------------------------------
const attendanceConfigSchema = new Schema(
    {
        autoMarkAbsent: {
            type: Boolean,
            default: true,
        },
        weekendDays: {
            type: [Number],
            default: () => [...DEFAULT_WEEKEND_DAYS],
            validate: {
                validator: (arr) =>
                    Array.isArray(arr) &&
                    arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 6),
                message: "weekendDays must be integers 0–6",
            },
        },
        holidays: {
            type: [holidaySchema],
            default: [],
        },
        // Tracks the last midnight (in workspace TZ) that rollup fully processed.
        // Used so we don't re-process days we've already handled.
        lastRollupDate: {
            type: String, // "YYYY-MM-DD"
            default: null,
        },
    },
    { _id: false }
);

const workspaceSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },

        companyName: {
            type: String,
            required: true,
            trim: true,
            maxlength: 150,
        },
        industry: {
            type: String,
            required: true,
            enum: SETUP_INDUSTRIES,
        },
        timezone: {
            type: String,
            required: true,
            enum: SETUP_TIMEZONES,
        },

        teamSize: {
            type: String,
            required: true,
            enum: ["solo", "small", "growing", "midsize", "large", "enterprise"],
        },

        theme: {
            accent: {
                type: String,
                required: true,
                enum: ["blue", "emerald", "purple", "rose", "amber", "slate"],
            },
            modules: {
                employees: { type: Boolean, default: true },
                attendance: { type: Boolean, default: true },
                payroll: { type: Boolean, default: false },
                recruitment: { type: Boolean, default: false },
            },
        },

        attendance: {
            type: attendanceConfigSchema,
            default: () => ({}),
        },

        setupCompletedAt: {
            type: Date,
            default: Date.now,
        },
    },
    { timestamps: true }
);

workspaceSchema.methods.toSafeJSON = function () {
    return {
        id: this._id,
        companyName: this.companyName,
        industry: this.industry,
        timezone: this.timezone,
        teamSize: this.teamSize,
        theme: this.theme,
        attendance: {
            autoMarkAbsent: this.attendance?.autoMarkAbsent ?? true,
            weekendDays: this.attendance?.weekendDays ?? [...DEFAULT_WEEKEND_DAYS],
            holidays: this.attendance?.holidays ?? [],
            lastRollupDate: this.attendance?.lastRollupDate ?? null,
        },
        setupCompletedAt: this.setupCompletedAt,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Workspace = model("Workspace", workspaceSchema);