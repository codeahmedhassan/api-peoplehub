import nodemailer from "nodemailer";
import { env } from "./env.js";

let transporter;

export function getMailer() {
    if (!transporter) {
        if (!env.smtp.host || !env.smtp.user || !env.smtp.pass) {
            console.warn(
                "⚠️  SMTP is not fully configured. Emails will not be sent. " +
                "Set SMTP_HOST, SMTP_USER and SMTP_PASS in .env."
            );
        }

        transporter = nodemailer.createTransport({
            host: env.smtp.host,
            port: env.smtp.port,
            secure: env.smtp.secure, // true for 465, false for 587
            auth:
                env.smtp.user && env.smtp.pass
                    ? { user: env.smtp.user, pass: env.smtp.pass }
                    : undefined,
            // Gmail sometimes needs a longer timeout on cold connections
            connectionTimeout: 10_000,
            greetingTimeout: 10_000,
            socketTimeout: 15_000,
        });
    }
    return transporter;
}

export async function verifyMailer() {
    const mailer = getMailer();
    try {
        await mailer.verify();
        console.log("✅ Mailer ready");
    } catch (err) {
        console.error("❌ Mailer verification failed:", err.message);
        console.error(
            "   → If this says '535 Authentication failed', check that SMTP_PASS is a Gmail App Password (16 chars, no spaces) and that 2FA is enabled on the account."
        );
    }
}

export async function sendMail({ to, subject, html, text }) {
    const mailer = getMailer();
    const info = await mailer.sendMail({
        from: env.smtp.from,
        to,
        subject,
        html,
        text,
    });

    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("📬 Email preview:", preview);

    return info;
}