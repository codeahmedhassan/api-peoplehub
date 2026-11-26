// src/services/chat/chat.service.js
import mongoose from "mongoose";
import { Conversation } from "../../model/chat/conversation.model.js";
import { ChatMessage } from "../../model/chat/message.model.js";
import { User } from "../../model/auth/auth.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { createNotification } from "../notification/notification.service.js";
import { isEmployeeDirectReport } from "../employee/employee.service.js";
import {
    uploadEncryptedBlob,
    getEncryptedBlob,
    getPresignedUploadUrl,
    getMessageVoicePath,
    getMessageAttachmentPath,
} from "../storage/s3.service.js";
import {
    encryptVoiceBuffer,
    decryptVoiceBuffer,
    createVoiceEncryptionParams,
    encryptAttachmentBuffer,
    decryptAttachmentBuffer,
} from "../storage/document-crypto.service.js";
import { ApiError } from "../../utils/ApiError.js";
import { assertStorageQuota, assertChatQuota, resolvePlanConfig } from "../workspace/plan.service.js";
import { escapeRegex } from "../../utils/security.js";

/**
 * Determine the user's chat category: "CEO" | "HR" | "Manager" | "Employee"
 */
export async function determineUserCategory(user, workspace, employee = null) {
    if (!user) return "Employee";

    const isOwner = Boolean(workspace?.owner && user._id.toString() === workspace.owner.toString());
    const roleStr = String(user.role || "").toLowerCase().trim();
    const systemRoleStr = String(user.systemRole || "").toLowerCase().trim();
    const empRoleStr = String(employee?.systemRole || "").toLowerCase().trim();

    // 1. CEO
    if (isOwner || /ceo|founder|administrator|admin/i.test(roleStr) || systemRoleStr === "admin" || empRoleStr === "admin") {
        return "CEO";
    }

    // 2. HR
    if (/hr/i.test(roleStr) || systemRoleStr === "hr" || empRoleStr === "hr" || /hr/i.test(employee?.department || "")) {
        return "HR";
    }

    // 3. Manager (either by role or by having direct reports)
    if (/manager/i.test(roleStr) || systemRoleStr === "manager" || empRoleStr === "manager") {
        return "Manager";
    }

    // Check if any employees in the workspace report to this user
    if (workspace?._id) {
        const hasReports = await checkIfUserHasReports(user, workspace._id, employee);
        if (hasReports) {
            return "Manager";
        }
    }

    return "Employee";
}

async function checkIfUserHasReports(user, workspaceId, employee) {
    const names = [user.fullName, employee ? `${employee.firstName} ${employee.lastName}`.trim() : null].filter(Boolean);
    const regexes = names.map((n) => new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));

    const query = {
        workspace: workspaceId,
        $or: [
            { reportingManager: { $in: regexes } },
            ...(employee?.employeeId ? [{ reportingManager: new RegExp(escapeRegex(employee.employeeId), "i") }] : []),
        ],
    };

    return Boolean(await Employee.exists(query));
}

/**
 * Find linked employee record for a user
 */
export async function findEmployeeForUser(userId, workspaceId) {
    const user = await User.findById(userId).lean();
    if (!user) return null;

    let employee = await Employee.findOne({ workspace: workspaceId, linkedUser: userId }).lean();
    if (!employee && user.email) {
        employee = await Employee.findOne({
            workspace: workspaceId,
            $or: [
                { loginEmail: user.email.toLowerCase() },
                { workEmail: user.email.toLowerCase() },
                { personalEmail: user.email.toLowerCase() },
            ],
        }).lean();
    }
    return employee;
}

/**
 * Get contacts that the current user is eligible to chat with.
 */
export async function getEligibleContacts(userId, { search = "", category = "" } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const currentUser = await User.findById(userId).lean();
    if (!currentUser) throw ApiError.unauthorized("User not found");

    const currentEmployee = await findEmployeeForUser(userId, workspace._id);
    const currentCategory = await determineUserCategory(currentUser, workspace, currentEmployee);

    // Load all other users in this workspace
    const allUsers = await User.find({
        $or: [
            { _id: workspace.owner },
            { workspaceId: workspace._id },
            { workspace: workspace._id },
        ],
        _id: { $ne: currentUser._id },
        status: { $ne: "suspended" },
    }).lean();

    // Load all employees in this workspace to enrich profile info
    const allEmployees = await Employee.find({ workspace: workspace._id }).lean();
    const employeeMapByUser = new Map();
    const employeeMapByEmail = new Map();

    for (const emp of allEmployees) {
        if (emp.linkedUser) employeeMapByUser.set(emp.linkedUser.toString(), emp);
        if (emp.workEmail) employeeMapByEmail.set(emp.workEmail.toLowerCase(), emp);
        if (emp.loginEmail) employeeMapByEmail.set(emp.loginEmail.toLowerCase(), emp);
        if (emp.personalEmail) employeeMapByEmail.set(emp.personalEmail.toLowerCase(), emp);
    }

    // Load active conversations for current user to detect established chat contacts
    const userConversations = await Conversation.find({
        workspace: workspace._id,
        participants: currentUser._id,
    }).select("_id participants").lean();

    const existingPartnerMap = new Map();
    for (const c of userConversations) {
        const partnerId = c.participants?.find((p) => p.toString() !== currentUser._id.toString())?.toString();
        if (partnerId) {
            existingPartnerMap.set(partnerId, c._id.toString());
        }
    }

    const contacts = [];

    for (const u of allUsers) {
        const emp = employeeMapByUser.get(u._id.toString()) || employeeMapByEmail.get((u.email || "").toLowerCase());
        const uCategory = await determineUserCategory(u, workspace, emp);

        let allowed = false;
        let relationship = ""; // "Manager", "Employee", "Colleague", "HR", "CEO"

        if (currentCategory === "CEO") {
            // CEO can chat with anyone
            allowed = true;
            relationship = uCategory;
        } else if (currentCategory === "Employee") {
            // Employee can chat with:
            // 1. His managers
            // 2. His colleagues (other regular Employees)
            const isMyManager = currentEmployee && isEmployeeDirectReport(currentEmployee, u, emp);
            if (isMyManager || uCategory === "Manager" && isReportingManagerMatch(currentEmployee, u, emp)) {
                allowed = true;
                relationship = "Manager";
            } else if (uCategory === "Employee") {
                allowed = true;
                relationship = "Colleague";
            }
        } else if (currentCategory === "Manager") {
            // Manager can chat with:
            // 1. His employees (direct reports)
            // 2. His colleagues (other Managers)
            // 3. HR
            // 4. CEO
            const isMyReport = emp && isEmployeeDirectReport(emp, currentUser, currentEmployee);
            if (isMyReport) {
                allowed = true;
                relationship = "Employee";
            } else if (uCategory === "Manager") {
                allowed = true;
                relationship = "Colleague";
            } else if (uCategory === "HR") {
                allowed = true;
                relationship = "HR";
            } else if (uCategory === "CEO") {
                allowed = true;
                relationship = "CEO";
            }
        } else if (currentCategory === "HR") {
            // HR can chat with:
            // 1. All managers
            // 2. Colleagues (other HR)
            // 3. CEO
            // 4. Employees ONLY IF they add employee's work email while starting the chat
            if (uCategory === "Manager") {
                allowed = true;
                relationship = "Manager";
            } else if (uCategory === "HR") {
                allowed = true;
                relationship = "Colleague";
            } else if (uCategory === "CEO") {
                allowed = true;
                relationship = "CEO";
            } else if (uCategory === "Employee") {
                // Not shown in default direct list unless searched by work email, OR allowed with requiresWorkEmail flag
                allowed = false; // special workflow
            }
        }

        if (allowed) {
            const convId = existingPartnerMap.get(u._id.toString());
            contacts.push({
                id: u._id.toString(),
                name: u.fullName || u.name,
                email: u.email,
                workEmail: emp?.workEmail || u.email,
                avatar: u.avatar || emp?.avatar || "",
                category: uCategory,
                relationship,
                designation: emp?.designation || uCategory,
                department: emp?.department || "",
                phone: u.phone || emp?.phone || "",
                requiresWorkEmail: false,
                alreadyChatting: Boolean(convId),
                conversationId: convId || null,
            });
        }
    }

    // Special HR employee contacts lookup
    const hrCanAccessEmployees = currentCategory === "HR";

    // Filter contacts based on search and category tab
    let filtered = contacts;
    if (search.trim()) {
        const s = search.trim().toLowerCase();
        filtered = filtered.filter(
            (c) =>
                c.name.toLowerCase().includes(s) ||
                c.email.toLowerCase().includes(s) ||
                (c.workEmail && c.workEmail.toLowerCase().includes(s)) ||
                (c.designation && c.designation.toLowerCase().includes(s)) ||
                (c.department && c.department.toLowerCase().includes(s))
        );
    }

    if (category && category !== "All") {
        const raw = String(category).toLowerCase().trim();
        const singular = raw.endsWith("s") ? raw.slice(0, -1) : raw;
        filtered = filtered.filter((c) => {
            const cat = String(c.category || "").toLowerCase();
            const rel = String(c.relationship || "").toLowerCase();
            return (
                cat === raw ||
                cat === singular ||
                rel === raw ||
                rel === singular ||
                (singular === "colleague" && rel === "colleague") ||
                (singular === "manager" && (cat === "manager" || rel === "manager")) ||
                (singular === "employee" && (cat === "employee" || rel === "employee"))
            );
        });
    }

    const planConfig = resolvePlanConfig(workspace.subscription);
    const isPaid = planConfig.isPaid;
    const chatMembersCount = existingPartnerMap.size;
    const maxChatMembers = planConfig.maxChatMembersPerUser;
    const canStartNewChat = chatMembersCount < maxChatMembers;

    return {
        currentUser: {
            id: currentUser._id.toString(),
            name: currentUser.fullName,
            category: currentCategory,
            designation: currentEmployee?.designation || currentCategory,
            department: currentEmployee?.department || "",
            avatar: currentUser.avatar || currentEmployee?.avatar || "",
        },
        contacts: filtered,
        hrCanAccessEmployees,
        quota: {
            isPaid,
            chatMembersCount,
            maxChatMembers,
            canStartNewChat,
        },
    };
}

function isReportingManagerMatch(employee, managerUser, managerEmployee) {
    if (!employee || !employee.reportingManager) return false;
    const rawTarget = String(employee.reportingManager || "").toLowerCase();
    const managerName = (managerUser.fullName || "").toLowerCase();
    const empName = managerEmployee ? `${managerEmployee.firstName} ${managerEmployee.lastName}`.trim().toLowerCase() : "";
    const empId = (managerEmployee?.employeeId || "").toLowerCase();

    if (managerName && rawTarget.includes(managerName)) return true;
    if (empName && rawTarget.includes(empName)) return true;
    if (empId && rawTarget.includes(empId)) return true;
    return false;
}

/**
 * HR Employee Verification by Work Email
 * Allows HR to initiate chat with any employee by verifying their work email.
 */
export async function verifyEmployeeForHrChat(userId, workEmail) {
    const workspace = await getWorkspaceOrThrow(userId);
    const currentUser = await User.findById(userId).lean();
    if (!currentUser) throw ApiError.unauthorized("User not found");

    const currentEmployee = await findEmployeeForUser(userId, workspace._id);
    const currentCategory = await determineUserCategory(currentUser, workspace, currentEmployee);

    if (currentCategory !== "HR" && currentCategory !== "CEO") {
        throw ApiError.forbidden("Only HR and CEO can initiate employee chats via work email verification.");
    }

    const cleanEmail = String(workEmail || "").trim().toLowerCase();
    if (!cleanEmail) {
        throw ApiError.badRequest("Employee work email is required.");
    }

    // Find the employee in the workspace
    const employee = await Employee.findOne({
        workspace: workspace._id,
        $or: [
            { workEmail: cleanEmail },
            { loginEmail: cleanEmail },
            { personalEmail: cleanEmail },
        ],
    }).lean();

    if (!employee) {
        throw ApiError.notFound(`No employee found with work email "${cleanEmail}" in your organization.`);
    }

    // Find or locate their User account
    let targetUser = null;
    if (employee.linkedUser) {
        targetUser = await User.findById(employee.linkedUser).lean();
    }
    if (!targetUser) {
        targetUser = await User.findOne({
            $or: [
                { email: (employee.workEmail || "").toLowerCase() },
                { email: (employee.loginEmail || "").toLowerCase() },
                { email: (employee.personalEmail || "").toLowerCase() },
            ],
        }).lean();
    }

    if (!targetUser) {
        // Create an active user account for this employee so they can chat!
        const generatedUser = await User.create({
            fullName: `${employee.firstName} ${employee.lastName}`.trim(),
            email: employee.workEmail || employee.loginEmail || cleanEmail,
            company: workspace.companyName,
            companySize: "midsize",
            role: "Employee",
            systemRole: employee.systemRole || "Employee",
            status: "active",
            emailVerified: true,
            workspaceId: workspace._id,
            avatar: employee.avatar || "",
        });
        await Employee.updateOne({ _id: employee._id }, { $set: { linkedUser: generatedUser._id } });
        targetUser = generatedUser.toObject();
    }

    const existingConv = await Conversation.findOne({
        workspace: workspace._id,
        participants: { $all: [currentUser._id, targetUser._id], $size: 2 },
    }).select("_id").lean();

    return {
        id: targetUser._id.toString(),
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        email: targetUser.email,
        workEmail: employee.workEmail || targetUser.email,
        avatar: targetUser.avatar || employee.avatar || "",
        category: "Employee",
        designation: employee.designation || "Employee",
        department: employee.department || "",
        employeeId: employee.employeeId,
        alreadyChatting: Boolean(existingConv),
        conversationId: existingConv ? existingConv._id.toString() : null,
    };
}

/**
 * Start or get an existing 1-on-1 conversation
 */
export async function startOrGetConversation(userId, { recipientId, employeeWorkEmail = "" }) {
    const workspace = await getWorkspaceOrThrow(userId);
    const currentUser = await User.findById(userId).lean();
    if (!currentUser) throw ApiError.unauthorized("User not found");

    if (userId.toString() === recipientId.toString()) {
        throw ApiError.badRequest("You cannot start a chat with yourself.");
    }

    let recipientUser = await User.findById(recipientId).lean();

    // If recipient not found by ID but work email provided (HR flow)
    if (!recipientUser && employeeWorkEmail) {
        const verified = await verifyEmployeeForHrChat(userId, employeeWorkEmail);
        recipientUser = await User.findById(verified.id).lean();
    }

    if (!recipientUser) {
        throw ApiError.notFound("Recipient user not found.");
    }

    // Check if conversation already exists between these two users
    let conversation = await Conversation.findOne({
        workspace: workspace._id,
        participants: { $all: [currentUser._id, recipientUser._id], $size: 2 },
    });

    if (conversation) {
        return await formatConversation(conversation, currentUser._id, workspace._id);
    }

    // Validate permission matrix if creating a new conversation
    const currentEmployee = await findEmployeeForUser(userId, workspace._id);
    const currentCategory = await determineUserCategory(currentUser, workspace, currentEmployee);

    const recipientEmployee = await findEmployeeForUser(recipientUser._id, workspace._id);
    const recipientCategory = await determineUserCategory(recipientUser, workspace, recipientEmployee);

    let allowed = false;

    if (currentCategory === "CEO") {
        allowed = true;
    } else if (currentCategory === "Employee") {
        const isMyManager = currentEmployee && isEmployeeDirectReport(currentEmployee, recipientUser, recipientEmployee);
        if (isMyManager || (recipientCategory === "Manager" && isReportingManagerMatch(currentEmployee, recipientUser, recipientEmployee))) {
            allowed = true;
        } else if (recipientCategory === "Employee") {
            allowed = true;
        }
    } else if (currentCategory === "Manager") {
        const isMyReport = recipientEmployee && isEmployeeDirectReport(recipientEmployee, currentUser, currentEmployee);
        if (isMyReport || recipientCategory === "Manager" || recipientCategory === "HR" || recipientCategory === "CEO") {
            allowed = true;
        }
    } else if (currentCategory === "HR") {
        if (recipientCategory === "Manager" || recipientCategory === "HR" || recipientCategory === "CEO") {
            allowed = true;
        } else if (recipientCategory === "Employee") {
            // HR can chat with employee ONLY IF they add employee's work email
            const validWorkEmail = (recipientEmployee?.workEmail || recipientUser.email || "").toLowerCase();
            const inputWorkEmail = String(employeeWorkEmail || "").trim().toLowerCase();
            if (inputWorkEmail && inputWorkEmail === validWorkEmail) {
                allowed = true;
            } else {
                throw ApiError.forbidden(
                    "HR can only start a chat with an employee by verifying their official work email."
                );
            }
        }
    }

    if (!allowed) {
        throw ApiError.forbidden(`You are not permitted to initiate a chat with this user according to communication rules.`);
    }

    // Enforce organization chat quota (Free plan: max 2 chat members per user)
    await assertChatQuota(workspace._id, currentUser._id, recipientUser._id);

    conversation = await Conversation.create({
        workspace: workspace._id,
        participants: [currentUser._id, recipientUser._id],
        initiatedBy: currentUser._id,
        unreadCounts: new Map([
            [currentUser._id.toString(), 0],
            [recipientUser._id.toString(), 0],
        ]),
        lastMessage: {
            text: "Conversation started",
            sender: currentUser._id,
            createdAt: new Date(),
        },
    });

    return await formatConversation(conversation, currentUser._id, workspace._id);
}

/**
 * List all conversations for the current user
 */
export async function getUserConversations(userId) {
    const workspace = await getWorkspaceOrThrow(userId);

    const conversations = await Conversation.find({
        workspace: workspace._id,
        participants: userId,
    })
        .sort({ updatedAt: -1 })
        .lean();

    // Mark delivery for this user across all their incoming messages
    const convIds = conversations.map((c) => c._id);
    if (convIds.length > 0) {
        await ChatMessage.updateMany(
            {
                conversation: { $in: convIds },
                sender: { $ne: userId },
                "deliveredTo.user": { $ne: userId },
            },
            {
                $push: { deliveredTo: { user: userId, deliveredAt: new Date() } },
            }
        );
    }

    const formatted = [];
    for (const c of conversations) {
        formatted.push(await formatConversation(c, userId, workspace._id));
    }

    // Rank conversations (WhatsApp & Instagram style):
    // 1. Unseen/unread conversations (unreadCount > 0) rank on top!
    // 2. If multiple conversations have unseen messages, the one sent most recently ranks highest.
    // 3. Followed by read conversations, ordered by most recent message/activity.
    formatted.sort((a, b) => {
        const aUnread = (a.unreadCount || 0) > 0 ? 1 : 0;
        const bUnread = (b.unreadCount || 0) > 0 ? 1 : 0;

        if (aUnread !== bUnread) {
            return bUnread - aUnread;
        }

        const aTime = new Date(a.lastMessage?.createdAt || a.updatedAt || 0).getTime();
        const bTime = new Date(b.lastMessage?.createdAt || b.updatedAt || 0).getTime();
        return bTime - aTime;
    });

    return formatted;
}

/**
 * Helper to enrich conversation object with recipient profile, unread count, and last message
 */
async function formatConversation(conversation, currentUserId, workspaceId) {
    const recipientId = conversation.participants.find(
        (p) => p.toString() !== currentUserId.toString()
    );

    let recipientData = null;
    if (recipientId) {
        const rUser = await User.findById(recipientId).lean();
        if (rUser) {
            const rEmp = await findEmployeeForUser(recipientId, workspaceId);
            const rCategory = await determineUserCategory(rUser, { _id: workspaceId }, rEmp);
            recipientData = {
                id: rUser._id.toString(),
                name: rUser.fullName || rUser.name,
                email: rUser.email,
                workEmail: rEmp?.workEmail || rUser.email,
                avatar: rUser.avatar || rEmp?.avatar || "",
                category: rCategory,
                designation: rEmp?.designation || rCategory,
                department: rEmp?.department || "",
                phone: rUser.phone || rEmp?.phone || "",
            };
        }
    }

    const unreadMap = conversation.unreadCounts || {};
    const unread = typeof unreadMap.get === "function"
        ? unreadMap.get(currentUserId.toString()) || 0
        : unreadMap[currentUserId.toString()] || 0;

    const isMine = conversation.lastMessage?.sender?.toString() === currentUserId.toString();
    let lastMessageStatus = "sent";
    if (isMine && recipientId) {
        const rUnread = typeof unreadMap.get === "function"
            ? unreadMap.get(recipientId.toString()) || 0
            : unreadMap[recipientId.toString()] || 0;
        if (rUnread === 0) {
            lastMessageStatus = "seen";
        } else {
            lastMessageStatus = "delivered";
        }
    }

    return {
        id: conversation._id.toString(),
        recipient: recipientData,
        lastMessage: {
            text: conversation.lastMessage?.text || "",
            senderId: conversation.lastMessage?.sender?.toString() || "",
            isMine,
            status: lastMessageStatus,
            createdAt: conversation.lastMessage?.createdAt || conversation.updatedAt,
        },
        unreadCount: unread,
        updatedAt: conversation.updatedAt,
    };
}

/**
 * Get message history for a conversation
 */
export async function getConversationMessages(userId, conversationId, { limit = 50, before = null } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    // Mark unread messages as read for this user before querying
    await markConversationAsRead(userId, conversationId);

    const query = {
        conversation: conversationId,
        workspace: workspace._id,
    };

    if (before) {
        query.createdAt = { $lt: new Date(before) };
    }

    const messages = await ChatMessage.find(query)
        .sort({ createdAt: 1 })
        .limit(Math.min(100, Number(limit) || 50))
        .lean();

    const otherParticipantId = conversation.participants.find(
        (p) => p.toString() !== userId.toString()
    );
    const otherIdStr = otherParticipantId ? otherParticipantId.toString() : "";

    const formattedMessages = messages.map((m) => {
        const isMine = m.sender.toString() === userId.toString();
        let status = "sent";

        if (isMine && otherIdStr) {
            const isSeen = m.readBy?.some((r) => r.user?.toString() === otherIdStr);
            const isDelivered = isSeen || m.deliveredTo?.some((d) => d.user?.toString() === otherIdStr);

            if (isSeen) {
                status = "seen";
            } else if (isDelivered) {
                status = "delivered";
            } else {
                status = "sent";
            }
        }

        return {
            id: m._id.toString(),
            text: m.text,
            messageType: m.messageType || "text",
            voice: m.voice?.s3Key
                ? {
                      duration: m.voice.duration || 0,
                      mimeType: m.voice.mimeType || "audio/webm",
                      size: m.voice.size || 0,
                  }
                : undefined,
            attachments: Array.isArray(m.attachments) && m.attachments.length > 0
                ? m.attachments.map((a) => ({
                      fileId: a.fileId || a._id?.toString(),
                      fileName: a.fileName,
                      fileSize: a.fileSize || 0,
                      mimeType: a.mimeType || "application/octet-stream",
                  }))
                : undefined,
            senderId: m.sender.toString(),
            isMine,
            status,
            createdAt: m.createdAt,
        };
    });

    const formattedConv = await formatConversation(conversation, userId, workspace._id);

    return {
        conversation: formattedConv,
        messages: formattedMessages,
    };
}

/**
 * Send a message in a conversation
 */
export async function sendMessage(userId, conversationId, { text }) {
    const workspace = await getWorkspaceOrThrow(userId);
    const cleanText = String(text || "").trim();

    if (!cleanText) {
        throw ApiError.badRequest("Message text cannot be empty.");
    }

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    const sender = await User.findById(userId).lean();
    const recipientId = conversation.participants.find(
        (p) => p.toString() !== userId.toString()
    );

    const message = await ChatMessage.create({
        workspace: workspace._id,
        conversation: conversation._id,
        sender: userId,
        text: cleanText,
        deliveredTo: [{ user: userId, deliveredAt: new Date() }],
        readBy: [{ user: userId, readAt: new Date() }],
    });

    // Update conversation last message & increment unread count for recipient
    const recipientIdStr = recipientId.toString();
    const currentUnread = (conversation.unreadCounts?.get(recipientIdStr) || 0) + 1;
    conversation.unreadCounts.set(recipientIdStr, currentUnread);
    conversation.unreadCounts.set(userId.toString(), 0);

    conversation.lastMessage = {
        text: cleanText,
        sender: userId,
        createdAt: new Date(),
    };

    await conversation.save();

    // Create non-blocking notification for recipient
    if (recipientId && sender) {
        try {
            await createNotification({
                workspaceId: workspace._id,
                recipientId: recipientId,
                title: `New message from ${sender.fullName}`,
                message: cleanText.length > 80 ? `${cleanText.substring(0, 80)}...` : cleanText,
                type: "chat_message",
                link: `/chat?conv=${conversation._id}`,
                metadata: {
                    conversationId: conversation._id.toString(),
                    senderId: userId.toString(),
                },
            });
        } catch (notifErr) {
            console.error("Non-fatal notification error on chat message:", notifErr);
        }
    }

    return {
        id: message._id.toString(),
        text: message.text,
        senderId: userId.toString(),
        isMine: true,
        status: "sent",
        createdAt: message.createdAt,
    };
}

/**
 * Mark all messages in a conversation as read by the current user
 */
export async function markConversationAsRead(userId, conversationId) {
    const workspace = await getWorkspaceOrThrow(userId);

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) return { success: false };

    conversation.unreadCounts.set(userId.toString(), 0);
    await conversation.save();

    await ChatMessage.updateMany(
        {
            conversation: conversationId,
            sender: { $ne: userId },
            "readBy.user": { $ne: userId },
        },
        {
            $push: { readBy: { user: userId, readAt: new Date() } },
        }
    );

    await ChatMessage.updateMany(
        {
            conversation: conversationId,
            sender: { $ne: userId },
            "deliveredTo.user": { $ne: userId },
        },
        {
            $push: { deliveredTo: { user: userId, deliveredAt: new Date() } },
        }
    );

    return { success: true };
}

/**
 * Total unread messages across all conversations for current user
 */
export async function getTotalUnreadCount(userId) {
    const workspace = await getWorkspaceOrThrow(userId);

    const conversations = await Conversation.find({
        workspace: workspace._id,
        participants: userId,
    }).lean();

    const convIds = conversations.map((c) => c._id);
    if (convIds.length > 0) {
        await ChatMessage.updateMany(
            {
                conversation: { $in: convIds },
                sender: { $ne: userId },
                "deliveredTo.user": { $ne: userId },
            },
            {
                $push: { deliveredTo: { user: userId, deliveredAt: new Date() } },
            }
        );
    }

    let total = 0;
    const userIdStr = userId.toString();

    for (const c of conversations) {
        const unreadMap = c.unreadCounts || {};
        const count = typeof unreadMap.get === "function"
            ? unreadMap.get(userIdStr) || 0
            : unreadMap[userIdStr] || 0;
        total += Number(count) || 0;
    }

    return { unreadCount: total };
}

function formatDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const mins = Math.floor(s / 60);
    const remainder = s % 60;
    return `${mins < 10 ? "0" : ""}${mins}:${remainder < 10 ? "0" : ""}${remainder}`;
}

/**
 * Generate S3 presigned PUT URL and client-side envelope encryption parameters.
 * Client encrypts voice buffer locally via WebCrypto (AES-256-GCM) with the DEK,
 * then uploads the ciphertext directly to S3.
 */
export async function getVoicePresignedUploadUrl(userId, conversationId, { duration = 0, mimeType = "audio/webm", size = 0 } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    await assertStorageQuota(workspace._id, size || 0, [{ size: size || 0 }]);

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    const messageId = new mongoose.Types.ObjectId();
    // Canonical tree: messages/{conversationId}/voice/{filename}
    const s3Key = getMessageVoicePath(conversationId.toString(), `${messageId.toString()}.enc`);

    // 1. Generate presigned S3 PUT URL for uploading the encrypted octet-stream
    const presignedUrl = await getPresignedUploadUrl(s3Key, {
        contentType: "application/octet-stream",
        expiresIn: 300,
    });

    // 2. Generate envelope encryption params (DEK wrapped by master KEK, random IV, AAD)
    const encParams = createVoiceEncryptionParams({
        conversationId: conversationId.toString(),
        messageId: messageId.toString(),
    });

    return {
        messageId: messageId.toString(),
        s3Key,
        presignedUrl,
        iv: encParams.ivBase64,
        aad: encParams.aadBase64,
        wrappedDek: encParams.wrappedDek,
        dek: encParams.dekBase64,
    };
}

/**
 * Finalize voice message after client uploaded the encrypted ciphertext to S3 via presigned URL.
 */
export async function completeVoiceMessage(userId, conversationId, { messageId, s3Key, duration, size, mimeType, iv, authTag, wrappedDek }) {
    const workspace = await getWorkspaceOrThrow(userId);

    if (!s3Key || !iv || !authTag || !wrappedDek) {
        throw ApiError.badRequest("Missing required encrypted voice metadata.");
    }

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    const sender = await User.findById(userId).lean();
    const recipientId = conversation.participants.find(
        (p) => p.toString() !== userId.toString()
    );

    const durSec = Math.max(1, Math.round(Number(duration) || 0));
    const durStr = formatDuration(durSec);
    const displayText = `Voice message (${durStr})`;

    const messageDoc = {
        workspace: workspace._id,
        conversation: conversation._id,
        sender: userId,
        messageType: "voice",
        text: displayText,
        voice: {
            s3Key,
            duration: durSec,
            size: Number(size) || 0,
            mimeType: mimeType || "audio/webm",
            iv,
            authTag,
            wrappedDek,
            kekVersion: 1,
        },
        deliveredTo: [{ user: userId, deliveredAt: new Date() }],
        readBy: [{ user: userId, readAt: new Date() }],
    };

    if (messageId && mongoose.isValidObjectId(messageId)) {
        messageDoc._id = messageId;
    }

    const message = await ChatMessage.create(messageDoc);

    // Update conversation last message & increment unread count for recipient
    const recipientIdStr = recipientId ? recipientId.toString() : "";
    if (recipientIdStr) {
        const currentUnread = (conversation.unreadCounts?.get(recipientIdStr) || 0) + 1;
        conversation.unreadCounts.set(recipientIdStr, currentUnread);
    }
    conversation.unreadCounts.set(userId.toString(), 0);

    conversation.lastMessage = {
        text: displayText,
        sender: userId,
        createdAt: new Date(),
    };

    await conversation.save();

    if (recipientId && sender) {
        try {
            await createNotification({
                workspaceId: workspace._id,
                recipientId: recipientId,
                title: `Voice message from ${sender.fullName}`,
                message: displayText,
                type: "chat_message",
                link: `/chat?conv=${conversation._id}`,
                metadata: {
                    conversationId: conversation._id.toString(),
                    senderId: userId.toString(),
                },
            });
        } catch {}
    }

    return {
        id: message._id.toString(),
        text: message.text,
        messageType: "voice",
        voice: {
            duration: message.voice.duration,
            mimeType: message.voice.mimeType,
            size: message.voice.size,
        },
        senderId: userId.toString(),
        isMine: true,
        status: "sent",
        createdAt: message.createdAt,
    };
}

/**
 * Direct fallback for voice upload: server encrypts buffer and uploads to S3
 */
export async function uploadDirectVoiceMessage(userId, conversationId, { buffer, duration = 0, mimeType = "audio/webm" }) {
    const workspace = await getWorkspaceOrThrow(userId);
    const voiceSize = buffer?.length || 0;
    await assertStorageQuota(workspace._id, voiceSize, [{ size: voiceSize }]);

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    const messageId = new mongoose.Types.ObjectId();
    // Canonical tree: messages/{conversationId}/voice/{filename}
    let s3Key = getMessageVoicePath(conversationId.toString(), `${messageId.toString()}.enc`);

    // 1. Server-side envelope encryption
    const encrypted = encryptVoiceBuffer(buffer, {
        conversationId: conversationId.toString(),
        messageId: messageId.toString(),
    });

    // 2. Upload ciphertext to S3 (with fallback for development if IAM user lacks messages/* permission)
    try {
        await uploadEncryptedBlob(s3Key, encrypted.ciphertext);
    } catch (err) {
        if (/AccessDenied|not authorized/i.test(err?.message)) {
            console.warn(`[chat] S3 write to "${s3Key}" failed with AccessDenied. Falling back to legacy prefix for testing IAM policy.`);
            s3Key = `employees/${workspace._id}/chats/${conversationId}/${messageId.toString()}.enc`;
            await uploadEncryptedBlob(s3Key, encrypted.ciphertext);
        } else {
            throw err;
        }
    }

    // 3. Save message
    return await completeVoiceMessage(userId, conversationId, {
        messageId: messageId.toString(),
        s3Key,
        duration,
        size: buffer.length,
        mimeType,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        wrappedDek: encrypted.wrappedDek,
    });
}

/**
 * Stream and decrypt voice message for playback
 */
export async function getVoiceMessageStream(userId, messageId) {
    const message = await ChatMessage.findById(messageId);
    if (!message || message.messageType !== "voice" || !message.voice?.s3Key) {
        throw ApiError.notFound("Voice message not found.");
    }

    const workspace = await getWorkspaceOrThrow(userId);
    const conversation = await Conversation.findOne({
        _id: message.conversation,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.forbidden("Access to this voice message is denied.");
    }

    // Download ciphertext from S3
    const ciphertext = await getEncryptedBlob(message.voice.s3Key);

    // Decrypt ciphertext using master KEK and message-specific wrapped DEK
    const decryptedBuffer = decryptVoiceBuffer(ciphertext, {
        iv: message.voice.iv,
        authTag: message.voice.authTag,
        wrappedDek: message.voice.wrappedDek,
        conversationId: message.conversation.toString(),
        messageId: message._id.toString(),
    });

    return {
        buffer: decryptedBuffer,
        mimeType: message.voice.mimeType || "audio/webm",
        duration: message.voice.duration,
    };
}

/**
 * Upload chat attachment (encrypted in S3, Paid Plan Only)
 */
export async function uploadChatAttachment(userId, conversationId, { buffer, fileName, mimeType = "application/octet-stream", fileSize = 0 }) {
    const workspace = await getWorkspaceOrThrow(userId);
    const planConfig = resolvePlanConfig(workspace.subscription);

    if (!planConfig.features.chatAttachments) {
        throw ApiError.forbidden(
            "File attachments are available on paid plans (Growth, Paid Pro, Business Scale). Upgrade your plan to send documents and attachments.",
            "PAID_PLAN_REQUIRED"
        );
    }

    const size = fileSize || buffer?.length || 0;
    await assertStorageQuota(workspace._id, size, [{ size }]);

    const conversation = await Conversation.findOne({
        _id: conversationId,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.notFound("Conversation not found or access denied.");
    }

    const messageId = new mongoose.Types.ObjectId();
    const fileId = new mongoose.Types.ObjectId().toString();

    // S3 Canonical path: messages/{conversationId}/attachments/{fileId}.enc
    let s3Key = getMessageAttachmentPath(conversationId.toString(), `${fileId}.enc`);

    // Client-side / Envelope Encryption (AES-256-GCM) with KEK / wrapped DEK
    const encrypted = encryptAttachmentBuffer(buffer, {
        conversationId: conversationId.toString(),
        fileId,
    });

    try {
        await uploadEncryptedBlob(s3Key, encrypted.ciphertext);
    } catch (err) {
        if (/AccessDenied|not authorized/i.test(err?.message)) {
            console.warn(`[chat] S3 write to "${s3Key}" failed with AccessDenied. Falling back to prefix for testing IAM policy.`);
            s3Key = `employees/${workspace._id}/chats/${conversationId}/attachments/${fileId}.enc`;
            await uploadEncryptedBlob(s3Key, encrypted.ciphertext);
        } else {
            throw err;
        }
    }

    const isImage = (mimeType || "").toLowerCase().startsWith("image/");
    const msgType = isImage ? "image" : "file";
    const cleanFileName = String(fileName || "attachment").trim();

    const message = await ChatMessage.create({
        _id: messageId,
        workspace: workspace._id,
        conversation: conversation._id,
        sender: userId,
        messageType: msgType,
        text: cleanFileName,
        attachments: [
            {
                fileId,
                fileName: cleanFileName,
                fileSize: size,
                mimeType,
                s3Key,
                iv: encrypted.iv,
                authTag: encrypted.authTag,
                wrappedDek: encrypted.wrappedDek,
                kekVersion: 1,
            },
        ],
        deliveredTo: [{ user: userId, deliveredAt: new Date() }],
        readBy: [{ user: userId, readAt: new Date() }],
    });

    // Update conversation lastMessage & unread count for recipient
    const recipientId = conversation.participants.find(
        (p) => p.toString() !== userId.toString()
    );
    if (recipientId) {
        const recipientIdStr = recipientId.toString();
        const currentUnread = (conversation.unreadCounts?.get(recipientIdStr) || 0) + 1;
        conversation.unreadCounts.set(recipientIdStr, currentUnread);
    }
    conversation.unreadCounts.set(userId.toString(), 0);

    conversation.lastMessage = {
        text: isImage ? `Image: ${cleanFileName}` : `File: ${cleanFileName}`,
        sender: userId,
        createdAt: new Date(),
    };

    await conversation.save();

    // Send notification
    const sender = await User.findById(userId).lean();
    if (recipientId && sender) {
        try {
            await createNotification({
                workspaceId: workspace._id,
                recipientId: recipientId,
                title: `New attachment from ${sender.fullName}`,
                message: cleanFileName,
                type: "chat_message",
                link: `/chat?conv=${conversation._id}`,
                metadata: {
                    conversationId: conversation._id.toString(),
                    senderId: userId.toString(),
                },
            });
        } catch (notifErr) {
            console.error("Non-fatal notification error on attachment:", notifErr);
        }
    }

    return {
        id: message._id.toString(),
        text: message.text,
        messageType: message.messageType,
        attachments: [
            {
                fileId,
                fileName: cleanFileName,
                fileSize: size,
                mimeType,
            },
        ],
        senderId: userId.toString(),
        isMine: true,
        status: "sent",
        createdAt: message.createdAt,
    };
}

/**
 * Stream and decrypt chat attachment for download or preview
 */
export async function getAttachmentStream(userId, messageId, fileId) {
    const message = await ChatMessage.findById(messageId);
    if (!message) {
        throw ApiError.notFound("Message not found.");
    }

    const attachment = message.attachments?.find(
        (a) => a.fileId === fileId || a._id?.toString() === fileId
    );
    if (!attachment || !attachment.s3Key) {
        throw ApiError.notFound("Attachment file not found.");
    }

    const workspace = await getWorkspaceOrThrow(userId);
    const conversation = await Conversation.findOne({
        _id: message.conversation,
        workspace: workspace._id,
        participants: userId,
    });

    if (!conversation) {
        throw ApiError.forbidden("Access to this attachment is denied.");
    }

    const ciphertext = await getEncryptedBlob(attachment.s3Key);

    const decryptedBuffer = decryptAttachmentBuffer(ciphertext, {
        iv: attachment.iv,
        authTag: attachment.authTag,
        wrappedDek: attachment.wrappedDek,
        conversationId: message.conversation.toString(),
        fileId: attachment.fileId || fileId,
    });

    return {
        buffer: decryptedBuffer,
        mimeType: attachment.mimeType || "application/octet-stream",
        fileName: attachment.fileName || "attachment",
    };
}

