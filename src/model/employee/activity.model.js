import mongoose from "mongoose";

const { Schema, model } = mongoose;

const activitySchema = new Schema(
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
        // The User (Admin/HR) who performed the action
        actor: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        // The type of event
        type: {
            type: String,
            enum: [
                "created",
                "updated",
                "document_added",
                "document_removed",
                "login_created",
                "correction_requested",
                "correction_approved",
                "correction_rejected",
                "promotion_requested",
                "promotion_approved",
                "doc_deletion_requested",
                "deletion_requested",
                "attendance_update_requested",
                "attendance_update_approved",
                "attendance_update_rejected",
                "leave_cancellation_requested",
                "leave_cancellation_approved",
                "leave_cancellation_rejected",
            ],
            required: true,
        },
        // Human readable description (e.g. "Department changed to Engineering")
        label: {
            type: String,
            required: true,
            maxlength: 255,
        },
        // Optional: store details of what changed
        changes: {
            type: Schema.Types.Mixed,
            default: {},
        },
    },
    { timestamps: true }
);

// Ensure we can quickly get the latest activity for an employee
activitySchema.index({ employee: 1, createdAt: -1 });

export const EmployeeActivity = model("EmployeeActivity", activitySchema);