// src/model/attendance/attendance.model.js
import mongoose from "mongoose";
import {
    ATTENDANCE_STATUSES,
    ATTENDANCE_SOURCES,
} from "../../constants/attendance.js";

const { Schema, model } = mongoose;

const attendanceRecordSchema = new Schema(
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

        // Date in the workspace timezone, stored as "YYYY-MM-DD".
        // This is the primary key component for "one record per employee per day".
        date: {
            type: String,
            required: true,
            match: /^\d{4}-\d{2}-\d{2}$/,
        },

        status: {
            type: String,
            required: true,
            enum: ATTENDANCE_STATUSES,
            default: "unmarked",
        },
        source: {
            type: String,
            required: true,
            enum: ATTENDANCE_SOURCES,
            default: "manual",
        },

        // Timestamps of the actual clock events, if applicable.
        // Stored as UTC — display layer converts to workspace TZ.
        checkIn: { type: Date, default: null },
        checkOut: { type: Date, default: null },

        // If a manual mark overrode a device-sourced row, this preserves
        // the fact that the device originally marked them present.
        deviceMarkedPresent: { type: Boolean, default: false },
        deviceMarkedAt: { type: Date, default: null },
        deviceId: { type: String, default: null },

        // Who made the last manual mark (only for source: "manual").
        markedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
        },

        note: { type: String, trim: true, maxlength: 500, default: "" },
    },
    { timestamps: true }
);

// One record per (workspace, employee, date). This is enforced at the DB
// level so concurrent device punches / manual marks can't create duplicates.
attendanceRecordSchema.index(
    { workspace: 1, employee: 1, date: 1 },
    { unique: true }
);

// Fast lookup by date range for the list + summary endpoints.
attendanceRecordSchema.index({ workspace: 1, date: 1 });

// Fast lookup for a single employee's history.
attendanceRecordSchema.index({ workspace: 1, employee: 1, date: -1 });

attendanceRecordSchema.methods.toSafeJSON = function (populatedEmployee = null) {
    const emp = populatedEmployee || this.employee;
    return {
        id: this._id,
        employeeId:
            emp && typeof emp === "object" && emp.employeeId
                ? emp.employeeId
                : undefined,
        employeeName:
            emp && typeof emp === "object"
                ? `${emp.firstName ?? ""} ${emp.lastName ?? ""}`.trim()
                : undefined,
        employeeAvatar:
            emp && typeof emp === "object" ? emp.avatar ?? "" : undefined,
        department:
            emp && typeof emp === "object" ? emp.department ?? "" : undefined,
        designation:
            emp && typeof emp === "object" ? emp.designation ?? "" : undefined,
        branch:
            emp && typeof emp === "object" ? emp.workLocation ?? "" : undefined,

        date: this.date,
        status: this.status,
        source: this.source,
        checkIn: this.checkIn,
        checkOut: this.checkOut,

        deviceMarkedPresent: this.deviceMarkedPresent,
        deviceMarkedAt: this.deviceMarkedAt,

        markedBy: this.markedBy,
        note: this.note,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
    };
};

export const AttendanceRecord = model("AttendanceRecord", attendanceRecordSchema);