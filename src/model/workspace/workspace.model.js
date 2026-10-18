// src/model/workspace/workspace.model.js
import mongoose from "mongoose";
import { SETUP_INDUSTRIES, SETUP_TIMEZONES } from "../../constants/index.js";

const { Schema, model } = mongoose;

const workspaceSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },

        // Step 1: Company
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

        // Step 2: Team size
        teamSize: {
            type: String,
            required: true,
            // Matches SETUP_TEAM_SIZES ids in the frontend
            enum: ["solo", "small", "growing", "midsize", "large", "enterprise"],
        },

        // Step 3: Theme
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
        setupCompletedAt: this.setupCompletedAt,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const Workspace = model("Workspace", workspaceSchema);