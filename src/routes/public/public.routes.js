import { Router } from "express";
import Joi from "joi";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { sendMail } from "../../config/mailer.js";
import { env } from "../../config/env.js";
import { escapeHtml } from "../../utils/security.js";

const router = Router();

const publicFormLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many submissions from this connection. Please wait a few minutes.",
    },
});

const contactSchema = Joi.object({
    name: Joi.string().trim().min(2).max(120).required(),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    company: Joi.string().trim().min(1).max(160).required(),
    companySize: Joi.string().trim().max(60).allow("").optional(),
    topic: Joi.string().trim().min(1).max(120).required(),
    message: Joi.string().trim().min(5).max(4000).required(),
});

const dpaRequestSchema = Joi.object({
    company: Joi.string().trim().min(2).max(200).required(),
    signatoryName: Joi.string().trim().min(2).max(120).required(),
    signatoryTitle: Joi.string().trim().min(2).max(120).required(),
    email: Joi.string().trim().lowercase().email().max(254).required(),
    plan: Joi.string().trim().min(1).max(60).required(),
    notes: Joi.string().trim().max(3000).allow("").optional(),
    consent: Joi.alternatives().try(Joi.boolean().valid(true), Joi.string().valid("on", "true")).optional(),
});

function getSupportInbox() {
    return process.env.SUPPORT_EMAIL || env.smtp.user || "corpilance.org@gmail.com";
}

router.post(
    "/contact",
    publicFormLimiter,
    validate(contactSchema),
    asyncHandler(async (req, res) => {
        const { name, email, company, companySize = "Not specified", topic, message } = req.body;
        const inbox = getSupportInbox();

        await sendMail({
            to: inbox,
            replyTo: email,
            subject: `[CorpiLance Contact] ${topic} — ${company}`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="margin: 0 0 16px; color: #1d4ed8;">New Contact Inquiry</h2>
                    <p><strong>Name:</strong> ${escapeHtml(name)}</p>
                    <p><strong>Email:</strong> ${escapeHtml(email)}</p>
                    <p><strong>Company:</strong> ${escapeHtml(company)}</p>
                    <p><strong>Company Size:</strong> ${escapeHtml(companySize || "Not specified")}</p>
                    <p><strong>Topic:</strong> ${escapeHtml(topic)}</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
                    <p style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(message)}</p>
                </div>
            `,
            text: `Contact Inquiry\nName: ${name}\nEmail: ${email}\nCompany: ${company}\nSize: ${companySize}\nTopic: ${topic}\n\n${message}`,
        });

        return res.status(200).json(new ApiResponse(200, { received: true }, "Message sent successfully."));
    })
);

router.post(
    "/dpa-request",
    publicFormLimiter,
    validate(dpaRequestSchema),
    asyncHandler(async (req, res) => {
        const { company, signatoryName, signatoryTitle, email, plan, notes = "" } = req.body;
        const inbox = getSupportInbox();

        await sendMail({
            to: inbox,
            replyTo: email,
            subject: `[CorpiLance DPA Request] ${company} (${plan})`,
            html: `
                <div style="font-family: Arial, sans-serif; color: #0f172a; max-width: 600px; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px;">
                    <h2 style="margin: 0 0 16px; color: #1d4ed8;">Data Processing Addendum (DPA) Request</h2>
                    <p><strong>Company Legal Name:</strong> ${escapeHtml(company)}</p>
                    <p><strong>Signatory Name:</strong> ${escapeHtml(signatoryName)}</p>
                    <p><strong>Signatory Title:</strong> ${escapeHtml(signatoryTitle)}</p>
                    <p><strong>Work Email:</strong> ${escapeHtml(email)}</p>
                    <p><strong>Plan:</strong> ${escapeHtml(plan)}</p>
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
                    <p><strong>Special Requirements:</strong></p>
                    <p style="white-space: pre-wrap; line-height: 1.6;">${escapeHtml(notes || "None specified")}</p>
                </div>
            `,
            text: `DPA Request\nCompany: ${company}\nSignatory: ${signatoryName} (${signatoryTitle})\nEmail: ${email}\nPlan: ${plan}\nNotes: ${notes || "None"}`,
        });

        return res.status(200).json(new ApiResponse(200, { received: true }, "DPA request submitted successfully."));
    })
);

export default router;
