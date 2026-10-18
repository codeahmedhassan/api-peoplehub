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