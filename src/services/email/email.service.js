import mongoose from "mongoose";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { sendMail } from "../../config/mailer.js";
import { env } from "../../config/env.js";
import { resolvePlanConfig } from "../workspace/plan.service.js";
import { escapeRegex } from "../../utils/security.js";

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
                        Hi ${escapeHtml(user.fullName)}, thanks for signing up for CorpiLance.
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

    const text = `Verify your CorpiLance email: ${url}\n\nThis link expires in 24 hours.`;

    await sendMail({
        to: user.email,
        subject: "Verify your CorpiLance email",
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
                    <h1 style="margin:0 0 12px;font-size:22px;color:#0f172a;">Welcome to CorpiLance</h1>
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
        subject: "You've been invited to CorpiLance",
        html,
        text: `Welcome to CorpiLance. Set your password here: ${url}`,
    });
}

export async function sendPasswordResetEmail(user, token) {
    const url = `${env.cors.marketingUrl}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(user.email)}`;

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
                    <h1 style="margin:0 0 12px;font-size:22px;color:#0f172a;">Reset your password</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi ${escapeHtml(user.fullName || "there")}, we received a request to reset the password for your CorpiLance account.
                      Click the button below to choose a new password.
                    </p>
                    <p style="margin:0 0 28px;">
                      <a href="${url}"
                        style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;
                               padding:12px 24px;border-radius:9999px;font-weight:600;font-size:14px;">
                        Reset password
                      </a>
                    </p>
                    <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
                      This link expires in 1 hour and can only be used once. If the button doesn't work, paste this link into your browser:
                    </p>
                    <p style="margin:0 0 24px;font-size:12px;color:#2563eb;word-break:break-all;">
                      ${url}
                    </p>
                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:16px;">
                      If you did not request a password reset, you can safely ignore this email.
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

    const text = `Reset your CorpiLance password: ${url}\n\nThis link expires in 1 hour.`;

    await sendMail({
        to: user.email,
        subject: "Reset your CorpiLance password",
        html,
        text,
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


export async function sendNewEmployeeEmail({ to, employee, companyName }) {
    if (!(await checkWorkspacePaidPlan(employee?.workspace || companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const fullName = `${employee.firstName} ${employee.lastName}`.trim();
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#1e40af;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      New Team Member
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">New Employee Joined</h1>
                    <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
                      A new employee record has been added to <strong>${escapeHtml(companyName || "the workspace")}</strong>. Here are their details:
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:140px;"><strong>Full Name:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(fullName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Employee ID:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.employeeId || "—")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Department:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.department || "General")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Designation:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.designation || "Team Member")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Reporting Manager:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.reportingManager || "None")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Joining Date:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${employee.joiningDate ? new Date(employee.joiningDate).toLocaleDateString() : "Today"}</td>
                      </tr>
                    </table>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this notification because employee updates are enabled in your workspace email preferences.
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

    return sendMail({
        to,
        subject: `New Employee Joined: ${fullName} (${employee.department || "General"})`,
        html,
        text: `A new employee has been added to ${companyName}: ${fullName} - ${employee.designation} (${employee.department}).`,
    }).catch((err) => console.error("Failed to send new employee email:", err.message));
}

/**
 * Restricts advanced automated operational emails to Paid subscriptions.
 */
async function checkWorkspacePaidPlan(workspaceIdOrCompany) {
    if (!workspaceIdOrCompany) return false;
    try {
        let ws = null;
        if (typeof workspaceIdOrCompany === "string" && mongoose.isValidObjectId(workspaceIdOrCompany)) {
            ws = await Workspace.findById(workspaceIdOrCompany).select("subscription").lean();
        } else if (workspaceIdOrCompany instanceof mongoose.Types.ObjectId) {
            ws = await Workspace.findById(workspaceIdOrCompany).select("subscription").lean();
        } else if (typeof workspaceIdOrCompany === "string") {
            ws = await Workspace.findOne({ companyName: new RegExp(`^${escapeRegex(workspaceIdOrCompany.trim())}$`, "i") }).select("subscription").lean();
        }
        return resolvePlanConfig(ws?.subscription).features.advancedEmails;
    } catch {
        return false;
    }
}

export async function sendTeamAssignmentEmail({ to, managerName, employee, companyName }) {
    if (!(await checkWorkspacePaidPlan(employee?.workspace || companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const fullName = `${employee.firstName} ${employee.lastName}`.trim();
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#ecfdf5;color:#065f46;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Team Update
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">New Team Member Assigned</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(managerName || "Manager")}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      <strong>${escapeHtml(fullName)}</strong> has been assigned to your team as <strong>${escapeHtml(employee.designation || "Team Member")}</strong> in the <strong>${escapeHtml(employee.department || "General")}</strong> department at ${escapeHtml(companyName)}.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:140px;"><strong>Employee:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(fullName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Designation:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.designation || "—")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Department:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.department || "—")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Contact Phone:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(employee.phone || "—")}</td>
                      </tr>
                    </table>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are listed as the reporting manager for this employee.
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

    return sendMail({
        to,
        subject: `New Team Member Assigned: ${fullName} is now on your team`,
        html,
        text: `Hi ${managerName}, ${fullName} has been assigned to your team in ${employee.department} as ${employee.designation}.`,
    }).catch((err) => console.error("Failed to send team assignment email:", err.message));
}

export async function sendRoleUpdateEmail({ to, userName, newRole, department, companyName }) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#faf5ff;color:#6b21a8;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Role Appointment
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">You have been appointed as ${escapeHtml(newRole)}</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(userName)}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      HR has updated your workspace role. You have been appointed as <strong>${escapeHtml(newRole)}</strong> ${department ? `in the <strong>${escapeHtml(department)}</strong> department` : ""} at <strong>${escapeHtml(companyName)}</strong>.
                    </p>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      You now have access to manage your team, view attendance adjustments, and supervise operations corresponding to your new permissions.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      If you have questions about your new permissions, please reach out to your HR Administrator.
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

    return sendMail({
        to,
        subject: `Role Appointment: You are now a ${newRole} at ${companyName}`,
        html,
        text: `Hi ${userName}, you have been appointed as ${newRole} at ${companyName}.`,
    }).catch((err) => console.error("Failed to send role update email:", err.message));
}

export async function sendPayrollReminderEmail({ to, userName, companyName, period, disbursementDate }) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#1e40af;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Payroll Notification
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">Payroll Day Reminder</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(userName)}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      This is an automated reminder that payroll for <strong>${escapeHtml(period)}</strong> is scheduled for processing/disbursement on <strong>${escapeHtml(disbursementDate)}</strong> for <strong>${escapeHtml(companyName)}</strong>.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this reminder because payroll day notifications are enabled in your account.
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

    return sendMail({
        to,
        subject: `Payroll Reminder: ${period} Disbursement for ${companyName}`,
        html,
        text: `Payroll reminder for ${period}: scheduled disbursement on ${disbursementDate}.`,
    }).catch((err) => console.error("Failed to send payroll reminder email:", err.message));
}

export async function send2FACodeEmail({ to, userName, code }) {
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#2563eb;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Security Verification
                    </div>
                    <h1 style="margin:0 0 12px;font-size:22px;font-weight:800;color:#0f172a;">Your Two-Factor Verification Code</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi ${escapeHtml(userName || "there")},<br />
                      Use the 6-digit code below to finish signing in to your CorpiLance account:
                    </p>
                    <div style="background:#f1f5f9;border-radius:12px;padding:18px 24px;text-align:center;margin-bottom:24px;">
                      <span style="font-family:monospace,sans-serif;font-size:32px;font-weight:800;letter-spacing:8px;color:#1e293b;">
                        ${code}
                      </span>
                    </div>
                    <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.5;">
                      This code is valid for <strong>10 minutes</strong>. Never share this code with anyone.
                    </p>
                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      If you did not attempt to sign in, please secure your account immediately by changing your password.
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

    return sendMail({
        to,
        subject: `${code} is your CorpiLance verification code`,
        html,
        text: `Your CorpiLance 2FA verification code is: ${code}. It expires in 10 minutes.`,
    }).catch((err) => console.error("Failed to send 2FA verification email:", err.message));
}

export async function sendWeekendScheduleUpdateEmail({ to, managerName, weekendDays, companyName }) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const weekendList = Array.isArray(weekendDays) ? weekendDays.join(", ") : String(weekendDays);
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#eef2ff;color:#4338ca;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Attendance Policy Update
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">Weekend Days Have Been Changed</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(managerName || "Manager")}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      HR has updated the official workspace weekend schedule for <strong>${escapeHtml(companyName)}</strong>.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:150px;"><strong>New Weekend Days:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${escapeHtml(weekendList || "None")}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Status:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#059669;font-weight:600;">Active &amp; Applied</td>
                      </tr>
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      Please review your team's weekly work schedules, attendance rosters, and shift arrangements to align with these updated weekend days.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this notification because you are a Manager at ${escapeHtml(companyName)}.
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

    return sendMail({
        to,
        subject: `Weekend Schedule Update: New weekend days for ${companyName}`,
        html,
        text: `Hi ${managerName}, HR has updated the official weekend schedule for ${companyName} to: ${weekendList}. Please align your team's schedules.`,
    }).catch((err) => console.error("Failed to send weekend schedule email:", err.message));
}

export async function sendHolidayAnnouncementEmail({ to, managerName, holidays, companyName }) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const holidaysRows = (holidays || [])
        .map(
            (h) => `
        <tr>
          <td style="padding:8px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(h.name)}</td>
          <td style="padding:8px 0;font-size:13px;color:#475569;text-align:right;">${escapeHtml(h.date)}</td>
        </tr>`
        )
        .join("");

    const holidayNames = (holidays || []).map((h) => h.name).filter(Boolean).join(", ") || "Public Holiday";

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Holiday Announcement
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">New Holiday Arriving</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(managerName || "Manager")}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      New holiday arriving: <strong>${escapeHtml(holidayNames)}</strong> for <strong>${escapeHtml(companyName)}</strong>. Tell your employees about it and prepare your team schedule.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <thead>
                        <tr>
                          <th style="padding:0 0 8px 0;font-size:12px;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Holiday Name</th>
                          <th style="padding:0 0 8px 0;font-size:12px;color:#64748b;text-align:right;border-bottom:1px solid #e2e8f0;">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${holidaysRows || '<tr><td colspan="2" style="padding:8px 0;font-size:13px;color:#64748b;">No holidays scheduled.</td></tr>'}
                      </tbody>
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      Please plan your team's workload, delivery deadlines, and coverage around these holiday dates.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this notification because you are a Manager at ${escapeHtml(companyName)}.
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

    return sendMail({
        to,
        subject: `New holiday arriving tell your employees about it - ${companyName}`,
        html,
        text: `Hi ${managerName}, new holiday arriving: ${holidayNames} for ${companyName}. Tell your employees about it.`,
    }).catch((err) => console.error("Failed to send holiday announcement email:", err.message));
}

export async function sendHolidayCancellationEmail({ to, managerName, canceledHolidays, companyName }) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const holidaysRows = (canceledHolidays || [])
        .map(
            (h) => `
        <tr>
          <td style="padding:8px 0;font-size:13px;color:#0f172a;font-weight:600;">${escapeHtml(h.name)}</td>
          <td style="padding:8px 0;font-size:13px;color:#475569;text-align:right;">${escapeHtml(h.date)}</td>
        </tr>`
        )
        .join("");

    const holidayNames = (canceledHolidays || []).map((h) => h.name).filter(Boolean).join(", ") || "Public Holiday";

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Holiday Canceled
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">${escapeHtml(holidayNames)} Canceled</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(managerName || "Manager")}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      The <strong>${escapeHtml(holidayNames)}</strong> holidays are canceled. Tell your employees about it and update your team's schedule accordingly.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <thead>
                        <tr>
                          <th style="padding:0 0 8px 0;font-size:12px;color:#64748b;text-align:left;border-bottom:1px solid #e2e8f0;">Canceled Holiday</th>
                          <th style="padding:0 0 8px 0;font-size:12px;color:#64748b;text-align:right;border-bottom:1px solid #e2e8f0;">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${holidaysRows || '<tr><td colspan="2" style="padding:8px 0;font-size:13px;color:#64748b;">No details available.</td></tr>'}
                      </tbody>
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      Please inform your employees that this is a regular working schedule.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this notification because you are a Manager at ${escapeHtml(companyName)}.
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

    return sendMail({
        to,
        subject: `${holidayNames} holidays are canceled tell your employees about it - ${companyName}`,
        html,
        text: `Hi ${managerName}, ${holidayNames} holidays are canceled tell your employees about it.`,
    }).catch((err) => console.error("Failed to send holiday cancellation email:", err.message));
}

export async function sendTeamLeaveUpdateEmail({
    to,
    managerName,
    employeeName,
    status = "Approved",
    leaveType = "Time-Off",
    dates = "Upcoming dates",
    reviewerRole = "HR",
    companyName = "CorpiLance",
}) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const isApproved = String(status).toLowerCase().includes("approve");
    const statusColor = isApproved ? "#059669" : "#dc2626";
    const statusBg = isApproved ? "#ecfdf5" : "#fef2f2";
    const roleLabel = reviewerRole === "CEO" ? "CEO" : "HR";
    const teamSignOff = reviewerRole === "CEO" ? "Executive Office" : "HR Operations Team";

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Leave &amp; Time-Off Update
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">${roleLabel} ${status} Leave Request</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(managerName || "Manager")}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      ${roleLabel} has reviewed and <strong>${escapeHtml(status)}</strong> the ${escapeHtml(leaveType)} request submitted for <strong>${escapeHtml(employeeName)}</strong> who reports under your team management.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:140px;"><strong>Employee:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${escapeHtml(employeeName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Status:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:${statusColor};font-weight:700;">${escapeHtml(status)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Duration / Dates:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(dates)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Reviewed By:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${roleLabel}</td>
                      </tr>
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      Please adjust your team's weekly task allocations and operational coverage accordingly.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this notification because you are a Manager at ${escapeHtml(companyName)}.
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

    return sendMail({
        to,
        subject: `${roleLabel} ${status}: Leave Request for ${employeeName} - ${companyName}`,
        html,
        text: `Hi ${managerName}, ${roleLabel} has ${status} the leave request for ${employeeName} (${dates}). Please adjust your team coverage.`,
    }).catch((err) => console.error("Failed to send team leave update email:", err.message));
}

export async function sendEmployeeLeaveStatusEmail({
    to,
    employeeName,
    status = "Approved",
    leaveType = "Annual Leave",
    dates = "",
    reviewerComments = "",
    reviewerRole = "HR",
    companyName = "CorpiLance",
}) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const isApproved = String(status).toLowerCase().includes("approve");
    const statusColor = isApproved ? "#059669" : "#dc2626";
    const statusBg = isApproved ? "#ecfdf5" : "#fef2f2";
    const roleLabel = reviewerRole === "CEO" ? "CEO" : "HR";
    const teamSignOff = reviewerRole === "CEO" ? "Executive Office" : "HR Operations Team";

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:${statusBg};color:${statusColor};font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      ${roleLabel} Decision: Leave Application ${status}
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">Your Leave Request has been ${status} by ${roleLabel}</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(employeeName)}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      ${roleLabel} has reviewed your application for <strong>${escapeHtml(leaveType)}</strong>. Your request status has been updated to <strong>${escapeHtml(status)}</strong>.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:140px;"><strong>Leave Type:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${escapeHtml(leaveType)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Status:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:${statusColor};font-weight:700;">${escapeHtml(status)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Dates:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(dates)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Reviewed By:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${roleLabel}</td>
                      </tr>
                      ${
                          reviewerComments
                              ? `<tr>
                                  <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>${roleLabel} Remarks:</strong></td>
                                  <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(reviewerComments)}</td>
                                </tr>`
                              : ""
                      }
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      ${isApproved ? "Your approved leave has been scheduled on the company roster. Enjoy your time off!" : `If you have questions regarding this decision, please reach out to ${roleLabel}.`}
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      ${escapeHtml(companyName)} ${teamSignOff}
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

    return sendMail({
        to,
        subject: `Leave Request ${status} by ${roleLabel}: ${leaveType} - ${companyName}`,
        html,
        text: `Hi ${employeeName}, your ${leaveType} request (${dates}) has been ${status} by ${roleLabel}. ${reviewerComments ? `${roleLabel} comments: ${reviewerComments}` : ""}`,
    }).catch((err) => console.error("Failed to send employee leave status email:", err.message));
}

export async function sendNewLeaveRequestEmail({
    to,
    hrName = "HR Team",
    applicantName,
    applicantRole = "Team Member",
    department,
    leaveType,
    dates,
    totalDays,
    reason,
    companyName = "CorpiLance",
}) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <div style="display:inline-block;padding:6px 14px;background:#eff6ff;color:#1d4ed8;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:16px;">
                      Pending Leave Approval
                    </div>
                    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;">New Leave Request Submitted</h1>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(hrName)}</strong>,
                    </p>
                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      <strong>${escapeHtml(applicantName)}</strong> (${escapeHtml(applicantRole)} in ${escapeHtml(department || "General")}) has submitted a new leave application requiring HR review and verification.
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;width:140px;"><strong>Applicant:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:700;">${escapeHtml(applicantName)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Leave Type:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(leaveType)}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Duration:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(dates)} (${totalDays} day${totalDays > 1 ? "s" : ""})</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0;font-size:13px;color:#64748b;"><strong>Reason:</strong></td>
                        <td style="padding:6px 0;font-size:13px;color:#0f172a;">${escapeHtml(reason || "Personal reasons")}</td>
                      </tr>
                    </table>

                    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6;">
                      Please log into your CorpiLance portal to verify team rosters and approve or reject this request.
                    </p>

                    <p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;">
                      You are receiving this alert because you are in the HR/Executive group for ${escapeHtml(companyName)}.
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

    return sendMail({
        to,
        subject: `Pending Leave Approval: ${applicantName} (${leaveType}) - ${companyName}`,
        html,
        text: `Hi ${hrName}, ${applicantName} has applied for ${totalDays} day(s) of ${leaveType} (${dates}). Please log into CorpiLance to review.`,
    }).catch((err) => console.error("Failed to send new leave request email:", err.message));
}

export async function sendPayslipEmail({
    to,
    userName,
    employeeId,
    department,
    designation,
    companyName,
    period,
    currency = "PKR",
    workingDays = 30,
    presentDays = 30,
    unpaidDays = 0,
    basicSalary = 0,
    earnings = [],
    deductions = [],
    grossSalary = 0,
    totalDeductions = 0,
    netSalary = 0,
    paymentMethod = "Bank Transfer",
    bankName = "Not Configured",
    accountNumber = "Not Configured",
    payslipSettings = {},
}) {
    if (!(await checkWorkspacePaidPlan(companyName))) {
        return { skipped: true, reason: "PLAN_UPGRADE_REQUIRED" };
    }
    const showEarnings = payslipSettings.showEarnings !== false;
    const showDeductions = payslipSettings.showDeductions !== false;
    const showBankDetails = payslipSettings.showBankDetails !== false;
    const showFooter = payslipSettings.showFooter !== false;
    const showEmployeeId = payslipSettings.showEmployeeId !== false;
    const showDepartment = payslipSettings.showDepartment !== false;
    const showDesignation = payslipSettings.showDesignation !== false;
    const earningsRows = (earnings || [])
        .map(
            (e) => `
            <tr>
              <td style="padding:6px 0;font-size:13px;color:#475569;">${escapeHtml(e.name || e.code)}</td>
              <td style="padding:6px 0;font-size:13px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(currency)} ${(e.amount || 0).toLocaleString()}</td>
            </tr>`
        )
        .join("");

    const deductionsRows = (deductions || [])
        .map(
            (d) => `
            <tr>
              <td style="padding:6px 0;font-size:13px;color:#475569;">${escapeHtml(d.name || d.code)}</td>
              <td style="padding:6px 0;font-size:13px;color:#e11d48;font-weight:600;text-align:right;">-${escapeHtml(currency)} ${(d.amount || 0).toLocaleString()}</td>
            </tr>`
        )
        .join("");

    const html = `
    <!DOCTYPE html>
    <html>
      <body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
          <tr>
            <td align="center">
              <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:18px;padding:36px;box-shadow:0 10px 25px -5px rgba(15,23,42,0.06);border:1px solid #e2e8f0;">
                <tr>
                  <td>
                    <!-- Header -->
                    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border-bottom:2px solid #0f172a;padding-bottom:18px;">
                      <tr>
                        <td>
                          <div style="font-size:20px;font-weight:800;color:#0f172a;letter-spacing:-0.02em;">
                            ${escapeHtml(companyName)}
                          </div>
                          <div style="font-size:12px;color:#64748b;margin-top:2px;">
                            Corporate Payroll Service
                          </div>
                        </td>
                        <td align="right">
                          <div style="display:inline-block;padding:4px 12px;background:#ecfdf5;color:#047857;font-size:11px;font-weight:700;border-radius:9999px;text-transform:uppercase;letter-spacing:0.05em;border:1px solid #a7f3d0;">
                            Salary Payslip
                          </div>
                          <div style="font-size:13px;font-weight:700;color:#0f172a;margin-top:4px;">
                            Period: ${escapeHtml(period)}
                          </div>
                          <div style="font-size:11px;font-weight:600;color:#64748b;margin-top:2px;">
                            Salary Currency: ${escapeHtml(currency)}
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Greeting & Employee Info -->
                    <p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.6;">
                      Hi <strong>${escapeHtml(userName)}</strong>,
                    </p>
                    <p style="margin:0 0 20px;font-size:14px;color:#475569;line-height:1.6;">
                      Here is your official salary pay advisory for the period of <strong>${escapeHtml(period)}</strong> (${escapeHtml(currency)}).
                    </p>

                    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:12px;padding:16px;margin-bottom:24px;border:1px solid #e2e8f0;">
                      <tr>
                        <td width="50%" style="padding:4px 0;font-size:12px;color:#64748b;">
                          ${showEmployeeId ? `Employee ID: <strong style="color:#0f172a;">${escapeHtml(employeeId || "—")}</strong>` : ""}
                        </td>
                        <td width="50%" style="padding:4px 0;font-size:12px;color:#64748b;">
                          ${showDepartment ? `Department: <strong style="color:#0f172a;">${escapeHtml(department || "General")}</strong>` : ""}
                        </td>
                      </tr>
                      <tr>
                        <td width="50%" style="padding:4px 0;font-size:12px;color:#64748b;">
                          ${showDesignation ? `Designation: <strong style="color:#0f172a;">${escapeHtml(designation || "Staff Member")}</strong>` : ""}
                        </td>
                        <td width="50%" style="padding:4px 0;font-size:12px;color:#64748b;">
                          Attendance: <strong style="color:#0f172a;">${presentDays} / ${workingDays} Days</strong>
                        </td>
                      </tr>
                      ${
                          unpaidDays > 0
                              ? `<tr>
                        <td colspan="2" style="padding:4px 0;font-size:12px;color:#e11d48;">
                          Unpaid Absences: <strong>${unpaidDays} Days</strong>
                        </td>
                      </tr>`
                              : ""
                      }
                    </table>

                    <!-- Breakdown: Earnings & Deductions -->
                    ${(showEarnings || showDeductions) ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                      <tr>
                        ${showEarnings ? `<td width="${showDeductions ? "48%" : "100%"}" valign="top" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
                          <div style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:12px;">
                            Earnings
                          </div>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            ${earningsRows || `<tr><td style="font-size:13px;color:#475569;">Base Salary</td><td style="font-size:13px;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(currency)} ${basicSalary.toLocaleString()}</td></tr>`}
                            <tr style="border-top:1px solid #e2e8f0;">
                              <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#0f172a;">Total Gross</td>
                              <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#047857;text-align:right;">${escapeHtml(currency)} ${grossSalary.toLocaleString()}</td>
                            </tr>
                          </table>
                        </td>` : ""}
                        ${(showEarnings && showDeductions) ? `<td width="4%"></td>` : ""}
                        ${showDeductions ? `<td width="${showEarnings ? "48%" : "100%"}" valign="top" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
                          <div style="font-size:12px;font-weight:700;color:#0f172a;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid #e2e8f0;padding-bottom:8px;margin-bottom:12px;">
                            Deductions
                          </div>
                          <table width="100%" cellpadding="0" cellspacing="0">
                            ${deductionsRows || `<tr><td style="font-size:13px;color:#94a3b8;font-style:italic;">None</td><td style="font-size:13px;color:#94a3b8;text-align:right;">0</td></tr>`}
                            <tr style="border-top:1px solid #e2e8f0;">
                              <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#0f172a;">Total Deductions</td>
                              <td style="padding:10px 0 0;font-size:13px;font-weight:700;color:#e11d48;text-align:right;">-${escapeHtml(currency)} ${totalDeductions.toLocaleString()}</td>
                            </tr>
                          </table>
                        </td>` : ""}
                      </tr>
                    </table>` : ""}

                    <!-- Net Payable Banner -->
                    <div style="background:#eff6ff;border:2px solid #bfdbfe;border-radius:14px;padding:20px;margin-bottom:24px;">
                      <div style="font-size:11px;font-weight:700;color:#1e40af;text-transform:uppercase;letter-spacing:0.05em;">
                        Net Payable Take-Home Amount
                      </div>
                      <div style="font-size:26px;font-weight:800;color:#1e3a8a;margin-top:4px;">
                        ${escapeHtml(currency)} ${netSalary.toLocaleString()}
                      </div>
                      ${showBankDetails ? `<div style="font-size:12px;color:#475569;margin-top:8px;">
                        Disbursement Method: <strong>${escapeHtml(paymentMethod)}</strong>
                        ${bankName && bankName !== "Not Configured" ? ` &bull; ${escapeHtml(bankName)} (${escapeHtml(accountNumber)})` : ""}
                      </div>` : ""}
                    </div>

                    <!-- Footer -->
                    ${showFooter ? `<p style="margin:0;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:16px;text-align:center;">
                      ${escapeHtml(payslipSettings.footerText || payslipSettings.footerNote || `This is an electronically generated salary payslip issued by ${companyName}. No physical signature required.`)}
                    </p>` : ""}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
    `;

    return sendMail({
        to,
        subject: `Salary Payslip - ${period} (${userName}) - ${companyName}`,
        html,
        text: `Salary Payslip for ${userName} (${period}): Net Payable ${currency} ${netSalary.toLocaleString()}. Total Gross: ${currency} ${grossSalary.toLocaleString()}, Deductions: ${currency} ${totalDeductions.toLocaleString()}.`,
    });
}
