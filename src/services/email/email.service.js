import { sendMail } from "../../config/mailer.js";
import { env } from "../../config/env.js";

export async function sendVerificationEmail(user, token) {
    const url = `${env.cors.marketingUrl}/verify-email/confirm?token=${encodeURIComponent(
        token
    )}`;

    const html = `
    <!DOCTYPE html>
    <html>
        <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
            <tr>
            <td align="center">
                <table role="presentation" width="560" cellpadding="0" cellspacing="0"
                style="background:#ffffff;border-radius:16px;padding:40px;box-shadow:0 1px 3px rgba(15,23,42,0.08);">
                <tr>
                    <td>
                    <h1 style="margin:0 0 12px;font-size:22px;color:#0f172a;">Verify your email</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                        Hi ${escapeHtml(user.fullName)}, thanks for signing up for PeopleHub.
                        Click the button below to verify your email and finish setting up your account.
                    </p>
                    <p style="margin:0 0 28px;">
                        <a href="${url}"
                        style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;
                                padding:12px 24px;border-radius:9999px;font-weight:600;font-size:14px;">
                        Verify email
                        </a>
                    </p>
                    <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
                        This link expires in 24 hours. If the button doesn't work, paste this into your browser:
                    </p>
                    <p style="margin:0 0 24px;font-size:12px;color:#2563eb;word-break:break-all;">
                        ${url}
                    </p>
                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px;">
                        If you didn't create an account, you can safely ignore this email.
                    </p>
                    </td>
                </tr>
                </table>
            </td>
            </tr>
        </table>
        </body>
    </html>
    `;

    const text = `Verify your PeopleHub email: ${url}\n\nThis link expires in 24 hours.`;

    await sendMail({
        to: user.email,
        subject: "Verify your PeopleHub email",
        html,
        text,
    });
}

export async function sendEmployeeInviteEmail(user, token) {
    const url = `${env.cors.marketingUrl}/accept-invite?token=${encodeURIComponent(token)}`;

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f1f5f9;font-family:sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:40px;">
                <tr>
                  <td>
                    <h1 style="margin:0 0 12px;font-size:22px;color:#0f172a;">Welcome to PeopleHub</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi ${escapeHtml(user.fullName)}, your HR team has created an account for you.
                      Click the button below to set your password and get started.
                    </p>
                    <p style="margin:0 0 28px;">
                      <a href="${url}"
                        style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:9999px;font-weight:600;font-size:14px;">
                        Set up your account
                      </a>
                    </p>
                    <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
                      This link expires in 7 days.
                    </p>
                    <p style="margin:0;font-size:12px;color:#2563eb;word-break:break-all;">
                      ${url}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
    `;

    await sendMail({
        to: user.email,
        subject: "You've been invited to PeopleHub",
        html,
        text: `Welcome to PeopleHub. Set your password here: ${url}`,
    });
}

function escapeHtml(str = "") {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}