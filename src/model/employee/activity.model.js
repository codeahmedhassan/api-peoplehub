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
            enum: ["created", "updated", "document_added", "document_removed", "login_created"],
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