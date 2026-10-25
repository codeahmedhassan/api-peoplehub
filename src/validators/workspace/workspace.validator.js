// src/validators/workspace/workspace.validator.js
import Joi from "joi";
import {
    SETUP_INDUSTRIES,
    SETUP_TIMEZONES,
    SETUP_TEAM_SIZE_IDS,
    SETUP_ACCENT_IDS,
} from "../../constants/index.js";

export const setupWorkspaceSchema = Joi.object({
    company: Joi.object({
        name: Joi.string().trim().min(1).max(150).required(),
        industry: Joi.string().valid(...SETUP_INDUSTRIES).required(),
        timezone: Joi.string().valid(...SETUP_TIMEZONES).required(),
    }).required(),

    teamSize: Joi.string().valid(...SETUP_TEAM_SIZE_IDS).required(),

    theme: Joi.object({
        accent: Joi.string().valid(...SETUP_ACCENT_IDS).required(),
        modules: Joi.object({
            employees: Joi.boolean().required(),
            attendance: Joi.boolean().required(),
            payroll: Joi.boolean().required(),
            recruitment: Joi.boolean().required(),
        }).required(),
    }).required(),
});

/**
 * PATCH /workspace/attendance-settings
 * Partial — any subset of the three top-level fields can be sent.
 */
export const updateAttendanceSettingsSchema = Joi.object({
    autoMarkAbsent: Joi.boolean(),

    weekendDays: Joi.array()
        .items(Joi.number().integer().min(0).max(6))
        .unique()
        .max(7),

    holidays: Joi.array()
        .items(
            Joi.object({
                date: Joi.string()
                    .pattern(/^\d{4}-\d{2}-\d{2}$/)
                    .required(),
                name: Joi.string().trim().min(1).max(100).required(),
            })
        )
        .max(100),
})
    .min(1)
    .unknown(false);