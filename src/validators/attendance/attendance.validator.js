// src/validators/attendance/attendance.validator.js
import Joi from "joi";
import { ATTENDANCE_STATUSES } from "../../constants/attendance.js";

const dateString = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

export const listAttendanceQuerySchema = Joi.object({
    from: dateString,
    to: dateString,
    employeeId: Joi.string().trim().max(40),
    department: Joi.string().trim().max(100),
    status: Joi.string().valid(...ATTENDANCE_STATUSES),
    q: Joi.string().trim().max(120).allow(""),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(1000).default(50),
}).with("to", "from");

export const summaryQuerySchema = Joi.object({
    from: dateString.required(),
    to: dateString.required(),
});

export const markAttendanceSchema = Joi.object({
    records: Joi.array()
        .items(
            Joi.object({
                employeeId: Joi.string().trim().max(40).required(),
                date: dateString.required(),
                status: Joi.string()
                    .valid("present", "absent", "late", "half-day", "on-leave")
                    .required(),
                checkIn: Joi.date().iso().allow(null),
                checkOut: Joi.date().iso().allow(null),
                note: Joi.string().trim().max(500).allow("").default(""),
            })
        )
        .min(1)
        .max(200)
        .required(),
});

export const exportQuerySchema = Joi.object({
    from: dateString.required(),
    to: dateString.required(),
    format: Joi.string().valid("csv", "xlsx").default("csv"),
    department: Joi.string().trim().max(100),
    status: Joi.string().valid(...ATTENDANCE_STATUSES),
    q: Joi.string().trim().max(120).allow(""),
});

export const rollupTriggerSchema = Joi.object({
    workspaceId: Joi.string().trim().optional(),
});