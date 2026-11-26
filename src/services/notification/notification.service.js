// src/services/notification/notification.service.js
import { Notification } from "../../model/notification/notification.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { User } from "../../model/auth/auth.model.js";
import { getWorkspaceForUser } from "../workspace/workspace.service.js";
import { resolvePlanConfig } from "../workspace/plan.service.js";
import { getDateInTimezone } from "../../utils/timezone.js";
import { ApiError } from "../../utils/ApiError.js";

export async function createNotification({
    workspaceId,
    recipientId = null,
    title,
    message,
    type = "system",
    link = "",
    metadata = {},
    preferenceKey = null,
}) {
    if (!workspaceId) return null;

    try {
        const ws = await Workspace.findById(workspaceId).select("subscription").lean();
        const isPaid = resolvePlanConfig(ws?.subscription).isPaid;
        if (!isPaid) {
            // Free / Basic plan: important notifications reserved for Paid Plan are suppressed
            const paidNotificationTypes = new Set([
                "employee_added",
                "team_assignment",
                "manager_transfer",
            ]);
            if (paidNotificationTypes.has(type)) {
                return null;
            }
        }

        if (recipientId) {
            const user = await User.findById(recipientId).select("notificationPreferences").lean();
            if (user && user.notificationPreferences) {
                const prefs = user.notificationPreferences;
                const targetKey = preferenceKey || metadata?.preferenceKey;
                if (targetKey && prefs[targetKey] === false) {
                    return null;
                }
                if (type === "holiday_announcement" && (prefs["emp-company-announcement"] === false || prefs["holiday-announcement"] === false)) {
                    return null;
                }
                if (type === "attendance_update" && (prefs["emp-company-policy-update"] === false || prefs["weekend-update"] === false || prefs["hr-attendance-correction-request"] === false)) {
                    return null;
                }
                if (type === "leave_request" && (prefs["hr-leave-request-received"] === false || prefs["mgr-leave-request-received"] === false || prefs["personal-leave-status"] === false)) {
                    return null;
                }
                if (type === "payroll_update" && (prefs["emp-payslip-generated"] === false || prefs["hr-payroll-day"] === false || prefs["ceo-payroll-completed"] === false)) {
                    return null;
                }
            }
        }

        const notif = await Notification.create({
            workspace: workspaceId,
            recipient: recipientId,
            title,
            message,
            type,
            link,
            metadata,
        });
        return notif;
    } catch (err) {
        console.error("Failed to create notification:", err.message);
        return null;
    }
}

/**
 * Sweeps the workspace for employees whose probation period is ending
 * (today or within 3 days, or recent unconfirmed) and dispatches in-app notifications
 * to HR team members and workspace leadership.
 */
export async function checkExpiringProbations(workspaceId) {
    if (!workspaceId) return { checked: 0, notified: 0 };

    try {
        const workspace = await Workspace.findById(workspaceId).lean();
        if (!workspace) return { checked: 0, notified: 0 };

        const todayStr = getDateInTimezone(new Date(), workspace.timezone);
        const todayDate = new Date(todayStr + "T00:00:00Z");

        // Consider probations expiring within the next 3 days, today, or in the last 7 days
        const minDate = new Date(todayDate);
        minDate.setDate(minDate.getDate() - 7);
        const maxDate = new Date(todayDate);
        maxDate.setDate(maxDate.getDate() + 3);

        const employees = await Employee.find({
            workspace: workspaceId,
            isActive: { $ne: false },
            employmentStatus: { $in: ["Active", "Probation"] },
            probationEndDate: { $ne: null, $gte: minDate, $lte: maxDate },
            probationStatus: { $ne: "Passed" },
        }).lean();

        if (employees.length === 0) return { checked: 0, notified: 0 };

        // Find HR users in workspace
        const hrUsers = await User.find({
            $or: [
                { workspaceId: workspace._id },
                { _id: workspace.owner },
            ],
            $or: [
                { role: "HR" },
                { systemRole: "HR" },
                { role: { $regex: /hr|human resource/i } },
                { systemRole: { $regex: /hr|human resource/i } },
            ],
            status: { $ne: "deactivated" },
        }).lean();

        // Also include workspace owner/CEO so operational visibility is maintained
        const ownerUser = await User.findById(workspace.owner).lean();
        const recipientMap = new Map();
        for (const u of hrUsers) {
            recipientMap.set(u._id.toString(), u);
        }
        if (ownerUser && ownerUser.status !== "deactivated") {
            recipientMap.set(ownerUser._id.toString(), ownerUser);
        }
        const recipients = Array.from(recipientMap.values());
        if (recipients.length === 0) return { checked: employees.length, notified: 0 };

        let notifiedCount = 0;

        for (const emp of employees) {
            const endDate = new Date(emp.probationEndDate);
            const endDateStr = endDate.toISOString().slice(0, 10);
            const isToday = endDateStr === todayStr;
            const isPast = endDateStr < todayStr;
            const diffDays = Math.ceil((endDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

            const timingText = isToday
                ? "ends today"
                : isPast
                ? `ended on ${endDateStr}`
                : `is ending in ${diffDays} day${diffDays === 1 ? "" : "s"} (${endDateStr})`;

            for (const recipient of recipients) {
                const existing = await Notification.findOne({
                    workspace: workspaceId,
                    recipient: recipient._id,
                    type: "employee_update",
                    "metadata.employeeId": emp._id,
                    "metadata.action": "probation_ending",
                    "metadata.probationEndDate": endDateStr,
                });

                if (existing) continue;

                await Notification.create({
                    workspace: workspaceId,
                    recipient: recipient._id,
                    title: `Probation Ending: ${emp.firstName} ${emp.lastName}`,
                    message: `Employee ${emp.firstName} ${emp.lastName} (${emp.employeeId || "—"})'s probation period ${timingText}. Review their performance and confirm permanent status.`,
                    type: "employee_update",
                    link: `/employees/${emp.employeeId || emp._id}`,
                    metadata: {
                        employeeId: emp._id,
                        employeeCode: emp.employeeId,
                        action: "probation_ending",
                        probationEndDate: endDateStr,
                    },
                });
                notifiedCount++;
            }
        }

        return { checked: employees.length, notified: notifiedCount };
    } catch (err) {
        console.error("[checkExpiringProbations] error:", err.message);
        return { checked: 0, notified: 0, error: err.message };
    }
}

export async function getUserNotifications(userId) {
    const workspace = await getWorkspaceForUser(userId);
    if (!workspace) {
        return { notifications: [], unreadCount: 0 };
    }

    // Proactively check and generate any upcoming/due probation notifications
    await checkExpiringProbations(workspace._id).catch(() => {});

    const filter = {
        workspace: workspace._id,
        $or: [{ recipient: userId }, { recipient: null }],
    };

    const [notifications, unreadCount] = await Promise.all([
        Notification.find(filter)
            .sort({ createdAt: -1 })
            .limit(40)
            .lean(),
        Notification.countDocuments({
            ...filter,
            isRead: false,
        }),
    ]);

    const mapped = notifications.map((n) => ({
        id: n._id.toString(),
        title: n.title,
        message: n.message,
        type: n.type,
        link: n.link || "",
        isRead: Boolean(n.isRead),
        readAt: n.readAt,
        createdAt: n.createdAt,
    }));

    return { notifications: mapped, unreadCount };
}

export async function markNotificationAsRead(userId, notificationId) {
    const notif = await Notification.findById(notificationId);
    if (!notif) throw ApiError.notFound("Notification not found");

    notif.isRead = true;
    notif.readAt = new Date();
    await notif.save();

    return { success: true };
}

export async function markAllNotificationsAsRead(userId) {
    const workspace = await getWorkspaceForUser(userId);
    if (!workspace) return { success: true };

    await Notification.updateMany(
        {
            workspace: workspace._id,
            $or: [{ recipient: userId }, { recipient: null }],
            isRead: false,
        },
        {
            $set: { isRead: true, readAt: new Date() },
        }
    );

    return { success: true };
}
