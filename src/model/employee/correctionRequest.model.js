import mongoose from "mongoose";

const { Schema, model } = mongoose;

const employeeCorrectionRequestSchema = new Schema(
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
        },
        employeeName: {
            type: String,
            required: true,
            trim: true,
        },
        requestedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        requestedByName: {
            type: String,
            required: true,
            trim: true,
        },
        requestedByRole: {
            type: String,
            default: "Manager",
        },
        requestType: {
            type: String,
            enum: [
                "details_update",
                "promotion_increment",
                "document_deletion",
                "employee_deletion",
                "attendance_update",
                "leave_cancellation",
            ],
            default: "details_update",
            index: true,
        },
        // The proposed corrections
        patch: {
            type: Schema.Types.Mixed,
            required: true,
        },
        // Current values before correction
        originalValues: {
            type: Schema.Types.Mixed,
            default: {},
        },
        approvedFields: {
            type: [String],
            default: [],
        },
        reason: {
            type: String,
            trim: true,
            default: "",
        },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
            index: true,
        },
        reviewedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },
        reviewedByName: {
            type: String,
            default: "",
        },
        reviewedAt: {
            type: Date,
            default: null,
        },
        rejectionReason: {
            type: String,
            trim: true,
            default: "",
        },
    },
    { timestamps: true }
);

export const EmployeeCorrectionRequest =
    mongoose.models.EmployeeCorrectionRequest ||
    model("EmployeeCorrectionRequest", employeeCorrectionRequestSchema);
