// src/model/performance/performanceAppraisal.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const PERFORMANCE_BANDS = [
    "Exceptional",
    "Exceeds Expectations",
    "Meets Expectations",
    "Needs Improvement",
    "Unsatisfactory",
    "Not Evaluated",
];

export const APPRAISAL_CATEGORIES = [
    { key: "quality", name: "Quality of Work", description: "Accuracy, thoroughness, attention to detail, and work excellence" },
    { key: "productivity", name: "Productivity & Timeliness", description: "Output volume, meeting deadlines, time management, and efficiency" },
    { key: "communication", name: "Communication & Teamwork", description: "Collaboration, openness, active listening, and team contribution" },
    { key: "problemSolving", name: "Problem Solving & Initiative", description: "Critical thinking, proactiveness, and resolving challenges independently" },
    { key: "leadership", name: "Leadership & Values", description: "Ownership, integrity, company culture alignment, and mentoring others" },
];

export const RECOMMENDATIONS = [
    "Promotion Ready",
    "Salary Increment Recommended",
    "Retain at Current Level",
    "Training & Coaching Required",
    "Performance Improvement Plan (PIP)",
];

const categoryRatingSchema = new Schema(
    {
        key: { type: String, required: true },
        name: { type: String, required: true },
        score: { type: Number, required: true, min: 1, max: 5 },
        comments: { type: String, trim: true, default: "" },
    },
    { _id: false }
);

const performanceAppraisalSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
            index: true,
        },
        employeeId: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        manager: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        managerName: {
            type: String,
            required: true,
            trim: true,
        },

        // Review metadata
        reviewPeriod: {
            type: String,
            required: true,
            trim: true,
            default: "Annual Review",
        },
        reviewDate: {
            type: Date,
            default: Date.now,
        },
        nextReviewDate: {
            type: Date,
            default: null,
        },

        // Core ratings
        overallRating: {
            type: Number,
            required: true,
            min: 1,
            max: 5,
        },
        ratingBand: {
            type: String,
            required: true,
            enum: PERFORMANCE_BANDS,
        },
        categories: {
            type: [categoryRatingSchema],
            default: [],
        },

        // Qualitative assessments
        keyStrengths: {
            type: String,
            trim: true,
            default: "",
        },
        areasForImprovement: {
            type: String,
            trim: true,
            default: "",
        },
        goalsAndAchievements: {
            type: String,
            trim: true,
            default: "",
        },

        // Recommendations & Notes
        recommendation: {
            type: String,
            trim: true,
            default: "Retain at Current Level",
        },
        managerPrivateNotes: {
            type: String,
            trim: true,
            default: "",
        },

        status: {
            type: String,
            enum: ["draft", "submitted", "completed"],
            default: "completed",
        },
    },
    { timestamps: true }
);

performanceAppraisalSchema.index({ workspace: 1, employee: 1, createdAt: -1 });
performanceAppraisalSchema.index({ workspace: 1, manager: 1, createdAt: -1 });

performanceAppraisalSchema.methods.toSafeJSON = function () {
    return {
        id: this._id.toString(),
        workspace: this.workspace.toString(),
        employee: this.employee.toString(),
        employeeId: this.employeeId,
        manager: this.manager.toString(),
        managerName: this.managerName,
        reviewPeriod: this.reviewPeriod,
        reviewDate: this.reviewDate,
        nextReviewDate: this.nextReviewDate,
        overallRating: this.overallRating,
        ratingBand: this.ratingBand,
        categories: this.categories,
        keyStrengths: this.keyStrengths,
        areasForImprovement: this.areasForImprovement,
        goalsAndAchievements: this.goalsAndAchievements,
        recommendation: this.recommendation,
        managerPrivateNotes: this.managerPrivateNotes,
        status: this.status,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const PerformanceAppraisal = model("PerformanceAppraisal", performanceAppraisalSchema);
