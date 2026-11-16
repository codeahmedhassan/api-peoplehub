import mongoose from "mongoose";

const { Schema, model } = mongoose;

const notificationSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        recipient: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
        },
        message: {
            type: String,
            required: true,
            trim: true,
            maxlength: 1000,
        },
        type: {
            type: String,
            enum: [
                "role_appointment",
                "team_assignment",
                "employee_added",
                "employee_update",
                "correction_request",
                "payroll_reminder",
                "attendance_update",
                "holiday_announcement",
                "leave_request",
                "leave_status",
                "team_leave_update",
                "manager_resignation",
                "manager_transfer",
                "system",
            ],
            default: "system",
        },
        link: {
            type: String,
            default: "",
            trim: true,
        },
        isRead: {
            type: Boolean,
            default: false,
            index: true,
        },
        readAt: {
            type: Date,
            default: null,
        },
        metadata: {
            type: Schema.Types.Mixed,
            default: () => ({}),
        },
    },
    { timestamps: true }
);

notificationSchema.methods.toSafeJSON = function () {
    return {
        id: this._id.toString(),
        title: this.title,
        message: this.message,
        type: this.type,
        link: this.link,
        isRead: this.isRead,
        readAt: this.readAt,
        createdAt: this.createdAt,
    };
};

export const Notification = model("Notification", notificationSchema);
