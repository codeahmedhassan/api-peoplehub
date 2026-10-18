import Joi from "joi";
import { SIGNUP_COMPANY_SIZES, SIGNUP_ROLES } from "../../constants/index.js";

export const signupSchema = Joi.object({
    fullName: Joi.string().trim().min(2).max(100).required().messages({
        "string.empty": "Full name is required",
    }),

    email: Joi.string().trim().lowercase().email().max(254).required().messages({
        "string.email": "Please provide a valid email",
    }),

    password: Joi.string()
        .min(8)
        .max(128)
        .pattern(/[A-Z]/, "uppercase")
        .pattern(/[a-z]/, "lowercase")
        .pattern(/[0-9]/, "number")
        .required()
        .messages({
            "string.min": "Password must be at least 8 characters",
            "string.pattern.name": "Password must include at least one {#name}",
        }),

    company: Joi.string().trim().min(1).max(150).required(),

    companySize: Joi.string()
        .valid(...SIGNUP_COMPANY_SIZES)
        .required(),

    role: Joi.string()
        .valid(...SIGNUP_ROLES)
        .required(),

    terms: Joi.boolean().valid(true).required().messages({
        "any.only": "You must accept the Terms of Service",
    }),

    privacy: Joi.boolean().valid(true).required().messages({
        "any.only": "You must accept the Privacy Policy",
    }),
});

export const verifyEmailSchema = Joi.object({
    token: Joi.string().trim().required().messages({
        "string.empty": "Verification token is required",
    }),
});

export const loginSchema = Joi.object({
    email: Joi.string()
        .trim()
        .lowercase()
        .email()
        .max(254)
        .required()
        .messages({
            "string.email": "Please provide a valid email",
            "string.empty": "Email is required",
        }),

    password: Joi.string()
        .min(1) // don't enforce complexity on login — just non-empty
        .max(128)
        .required()
        .messages({
            "string.empty": "Password is required",
        }),

    rememberMe: Joi.boolean().default(false),
});
