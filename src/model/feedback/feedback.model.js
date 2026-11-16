import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema(
    {
        workspace: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Workspace",
            index: true,
            default: null,
        },
        workspaceName: {
            type: String,
            trim: true,
            default: "Personal Workspace",
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        userName: {
            type: String,
            trim: true,
            default: "User",
        },
        userEmail: {
            type: String,
            trim: true,
            lowercase: true,
            required: true,
            index: true,
        },
        userRole: {
            type: String,
            trim: true,
            default: "Member",
        },
        type: {
            type: String,
            enum: ["bug", "suggestion", "feedback"],
            default: "feedback",
            index: true,
        },
        category: {
            type: String,
            trim: true,
            default: "General",
            index: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 300,
        },
        description: {
            type: String,
            required: true,
            trim: true,
            maxlength: 5000,
        },
        priority: {
            type: String,
            enum: ["low", "medium", "high", "critical"],
            default: "medium",
            index: true,
        },
        images: {
            type: [String],
            default: [],
        },
        pageUrl: {
            type: String,
            trim: true,
            default: "",
        },
        browserInfo: {
            type: String,
            trim: true,
            default: "",
        },
        status: {
            type: String,
            enum: ["pending", "in_review", "resolved", "dismissed"],
            default: "pending",
            index: true,
        },
        adminNotes: {
            type: String,
            trim: true,
            default: "",
        },
        resolvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "SuperAdmin",
            default: null,
        },
        resolvedAt: {
            type: Date,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

export const Feedback = mongoose.models.Feedback || mongoose.model("Feedback", feedbackSchema);
