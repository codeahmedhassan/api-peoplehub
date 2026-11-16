// src/model/leave/leave.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

export const LEAVE_TYPES = [
    "annual",
    "casual",
    "sick",
    "unpaid",
    "maternity",
    "paternity",
    "special",
];

export const LEAVE_STATUSES = [
    "pending",
    "pending_manager",
    "pending_hr",
    "pending_ceo",
    "approved",
    "rejected",
    "cancelled",
];

const leaveRequestSchema = new Schema(
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
        user: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        employeeName: {
            type: String,
            required: true,
            trim: true,
        },
        employeeCode: {
            type: String,
            default: "",
            trim: true,
        },
        department: {
            type: String,
            default: "General",
            trim: true,
        },
        designation: {
            type: String,
            default: "",
            trim: true,
        },
        reportingManager: {
            type: String,
            default: "",
            trim: true,
        },
        category: {
            type: String,
            enum: ["leave", "timeoff"],
            default: "leave",
            index: true,
        },
        leaveType: {
            type: String,
            default: "annual",
            required: true,
            trim: true,
        },
        startDate: {
            type: String,
            required: true, // "YYYY-MM-DD"
        },
        endDate: {
            type: String,
            required: true, // "YYYY-MM-DD"
        },
        totalDays: {
            type: Number,
            required: true,
            default: 1,
        },
        isHalfDay: {
            type: Boolean,
            default: false,
        },
        halfDayPeriod: {
            type: String,
            enum: ["first_half", "second_half", null],
            default: null,
        },
        isShortDay: {
            type: Boolean,
            default: false,
        },
        shortDayHours: {
            type: Number,
            default: 2,
        },
        reason: {
            type: String,
            required: true,
            trim: true,
        },
        emergencyContact: {
            type: String,
            default: "",
            trim: true,
        },
        appliedByRole: {
            type: String,
            default: "EMPLOYEE",
        },
        appliedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        appliedByName: {
            type: String,
            default: "",
        },
        appliedOnBehalf: {
            type: Boolean,
            default: false,
        },
        appliedByManager: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            default: null,
        },
        stage: {
            type: String,
            enum: ["manager_review", "hr_review", "ceo_review", "completed"],
            default: "hr_review",
            index: true,
        },
        managerReview: {
            reviewedBy: {
                type: Schema.Types.ObjectId,
                ref: "User",
                default: null,
            },
            reviewerName: {
                type: String,
                default: "",
            },
            action: {
                type: String,
                enum: ["forwarded_to_hr", "rejected", null],
                default: null,
            },
            comments: {
                type: String,
                default: "",
                trim: true,
            },
            reviewedAt: {
                type: Date,
                default: null,
            },
        },
        selfApproved: {
            type: Boolean,
            default: false,
        },
        attendanceMarked: {
            type: Boolean,
            default: false,
        },
        attendanceDates: {
            type: [String],
            default: [],
        },
        cancelledDates: {
            type: [String],
            default: [],
        },
        resubmittedFrom: {
            type: Schema.Types.ObjectId,
            ref: "LeaveRequest",
            default: null,
        },
        resubmissionCount: {
            type: Number,
            default: 0,
        },
        status: {
            type: String,
            enum: LEAVE_STATUSES,
            default: "pending",
            index: true,
        },
        appliedAt: {
            type: Date,
            default: Date.now,
        },
        reviewedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        reviewerName: {
            type: String,
            default: "",
        },
        reviewerRole: {
            type: String,
            default: "",
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        reviewerComments: {
            type: String,
            default: "",
            trim: true,
        },
    },
    { timestamps: true }
);

leaveRequestSchema.index({ workspace: 1, status: 1 });
leaveRequestSchema.index({ workspace: 1, employee: 1, startDate: 1 });

export const LeaveRequest = model("LeaveRequest", leaveRequestSchema);
