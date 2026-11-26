// src/services/workspace/plan.service.js
import mongoose from "mongoose";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { Device } from "../../model/attendance/device.model.js";
import { ChatMessage } from "../../model/chat/message.model.js";
import { Conversation } from "../../model/chat/conversation.model.js";
import { ApiError } from "../../utils/ApiError.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Multi-tier profitability-guarded SaaS plan matrix.
 * Calibrated against AWS S3 ($0.025/GB storage + $0.1093/GB transfer out),
 * AWS EC2 t3.small (~$15.18/mo base + EBS), MongoDB Atlas Flex/M10 ($8-$65/mo),
 * and Paddle Merchant-of-Record transaction fees (5% + $0.50 per invoice).
 */
export const PLAN_CONFIGS = {
    free: {
        plan: "free",
        planName: "Starter Free Plan",
        monthlyPriceUsd: 0,
        yearlyMonthlyPriceUsd: 0,
        isPaid: false,
        storageLimitBytes: 250 * MB, // 250 MB combined DB + S3 cap
        maxEmployees: 20,
        maxDevices: 2,
        maxChatMembersPerUser: 2,
        maxFileSizeBytes: 5 * MB,
        maxSalaryComponents: 7,
        features: {
            advancedReports: false,
            advancedEmails: false,
            chatAttachments: false,
            auditLogs: false,
        },
    },
    growth: {
        plan: "growth",
        planName: "Growth Plan",
        monthlyPriceUsd: 19,
        yearlyMonthlyPriceUsd: 15,
        isPaid: true,
        storageLimitBytes: 2 * GB, // 2 GB combined DB + S3 cap
        maxEmployees: 50,
        maxDevices: 4,
        maxChatMembersPerUser: 15,
        maxFileSizeBytes: 10 * MB,
        maxSalaryComponents: 15,
        features: {
            advancedReports: true,
            advancedEmails: true,
            chatAttachments: true,
            auditLogs: false, // Reserved for Paid Pro ($49) and Business Scale ($119)
        },
    },
    pro: {
        plan: "pro",
        planName: "Paid Pro Plan",
        monthlyPriceUsd: 49,
        yearlyMonthlyPriceUsd: 39,
        isPaid: true,
        storageLimitBytes: 10 * GB, // 10 GB combined DB + S3 cap
        maxEmployees: 150,
        maxDevices: 10,
        maxChatMembersPerUser: 100,
        maxFileSizeBytes: 15 * MB,
        maxSalaryComponents: null,
        features: {
            advancedReports: true,
            advancedEmails: true,
            chatAttachments: true,
            auditLogs: true,
        },
    },
    enterprise: {
        plan: "enterprise",
        planName: "Business Scale Plan",
        monthlyPriceUsd: 119,
        yearlyMonthlyPriceUsd: 95,
        isPaid: true,
        storageLimitBytes: 50 * GB, // 50 GB combined DB + S3 cap
        maxEmployees: 500,
        maxDevices: 30,
        maxChatMembersPerUser: 500,
        maxFileSizeBytes: 25 * MB,
        maxSalaryComponents: null,
        features: {
            advancedReports: true,
            advancedEmails: true,
            chatAttachments: true,
            auditLogs: true,
        },
    },
};

export const FREE_PLAN_LIMITS = {
    PLAN: "free",
    STORAGE_BYTES: PLAN_CONFIGS.free.storageLimitBytes,
    MAX_EMPLOYEES: PLAN_CONFIGS.free.maxEmployees,
    MAX_DEVICES: PLAN_CONFIGS.free.maxDevices,
    MAX_CHAT_MEMBERS_PER_USER: PLAN_CONFIGS.free.maxChatMembersPerUser,
    MAX_FILE_SIZE_BYTES: PLAN_CONFIGS.free.maxFileSizeBytes,
};

export const VALID_PLAN_KEYS = ["free", "growth", "pro", "enterprise", "paid"];

export function normalizePlanKey(planOrSub) {
    const raw = typeof planOrSub === "string" ? planOrSub : planOrSub?.plan;
    if (raw === "paid" || raw === "pro") return "pro";
    if (raw === "growth") return "growth";
    if (raw === "enterprise") return "enterprise";
    return "free";
}

export function resolvePlanConfig(planOrSub) {
    const key = normalizePlanKey(planOrSub);
    return PLAN_CONFIGS[key];
}

function formatLimitBytesLabel(bytes) {
    if (!bytes) return "0 MB";
    if (bytes >= GB) return `${Math.round((bytes / GB) * 10) / 10} GB`;
    return `${Math.round(bytes / MB)} MB`;
}

/**
 * Calculates detailed storage usage across:
 * 1. Database Memory / BSON storage (workspace + all tenant collections)
 * 2. S3 Object Storage (employee documents, chat voice and attachments)
 */
export async function getWorkspaceStorageDetails(workspaceId, { persist = true } = {}) {
    const wsObjectId = new mongoose.Types.ObjectId(workspaceId);
    const wsIdStr = wsObjectId.toString();
    const db = mongoose.connection.db;

    const wsSelfAgg = await db.collection("workspaces").aggregate([
        { $match: { _id: wsObjectId } },
        { $project: { size: { $bsonSize: "$$ROOT" } } }
    ]).toArray();
    const wsDocBytes = wsSelfAgg[0]?.size || 0;

    let databaseBytes = wsDocBytes;
    const dbBreakdown = {
        workspace: wsDocBytes,
    };

    const platformCollections = new Set([
        "workspaces",
        "superadmins",
        "superadmin2facodes",
        "superadminauditlogs",
        "apm_metrics",
        "apm_snapshots",
        "system_errors",
        "structured_logs",
        "analytics_outbox"
    ]);

    try {
        const collections = await db.listCollections().toArray();
        for (const col of collections) {
            if (platformCollections.has(col.name)) continue;
            try {
                const agg = await db.collection(col.name).aggregate([
                    { $match: { workspace: { $in: [wsObjectId, wsIdStr] } } },
                    { $group: { _id: null, totalBytes: { $sum: { $bsonSize: "$$ROOT" } } } }
                ]).toArray();
                const colBytes = agg[0]?.totalBytes || 0;
                if (colBytes > 0) {
                    databaseBytes += colBytes;
                    dbBreakdown[col.name] = colBytes;
                }
            } catch {
                // Ignore collection-specific matching errors
            }
        }
    } catch (e) {
        console.error("Non-fatal database storage scan error:", e);
    }

    let empDocsBytes = 0;
    try {
        const empDocsAgg = await Employee.aggregate([
            { $match: { workspace: wsObjectId, isDeleted: { $ne: true } } },
            { $unwind: "$documents" },
            { $group: { _id: null, totalBytes: { $sum: { $ifNull: ["$documents.fileSize", 0] } } } }
        ]);
        empDocsBytes = empDocsAgg[0]?.totalBytes || 0;
    } catch (e) {
        console.error("Non-fatal employee documents storage aggregate error:", e);
    }

    let chatVoiceBytes = 0;
    try {
        const chatMediaAgg = await ChatMessage.aggregate([
            { $match: { workspace: wsObjectId } },
            { $group: { _id: null, totalBytes: { $sum: { $ifNull: ["$voice.size", 0] } } } }
        ]);
        chatVoiceBytes = chatMediaAgg[0]?.totalBytes || 0;
    } catch (e) {
        console.error("Non-fatal chat voice storage aggregate error:", e);
    }

    let chatAttachmentBytes = 0;
    try {
        const chatAttachmentAgg = await ChatMessage.aggregate([
            { $match: { workspace: wsObjectId, "attachments.0": { $exists: true } } },
            { $unwind: "$attachments" },
            { $group: { _id: null, totalBytes: { $sum: { $ifNull: ["$attachments.fileSize", "$attachments.size", 0] } } } }
        ]);
        chatAttachmentBytes = chatAttachmentAgg[0]?.totalBytes || 0;
    } catch {
        // ChatMessage attachments fallback
    }

    const s3Bytes = empDocsBytes + chatVoiceBytes + chatAttachmentBytes;
    const s3Breakdown = {
        employeeDocuments: empDocsBytes,
        chatVoice: chatVoiceBytes,
        chatAttachments: chatAttachmentBytes,
    };

    const totalBytes = databaseBytes + s3Bytes;

    if (persist) {
        try {
            await Workspace.updateOne(
                { _id: wsObjectId },
                {
                    $set: {
                        "storageUsage.totalBytesUsed": totalBytes,
                        "storageUsage.databaseBytesUsed": databaseBytes,
                        "storageUsage.s3BytesUsed": s3Bytes,
                        "storageUsage.lastCalculatedAt": new Date(),
                        "storageUsage.breakdown": {
                            database: dbBreakdown,
                            s3: s3Breakdown,
                        },
                    },
                }
            );
        } catch (err) {
            console.error("Non-fatal storage persistence warning:", err);
        }
    }

    return {
        totalBytes,
        databaseBytes,
        s3Bytes,
        breakdown: {
            database: dbBreakdown,
            s3: s3Breakdown,
        },
    };
}

export async function calculateWorkspaceStorageBytes(workspaceId, options = { persist: true }) {
    const details = await getWorkspaceStorageDetails(workspaceId, options);
    return details.totalBytes;
}

export async function syncAllWorkspacesStorage() {
    try {
        const workspaces = await Workspace.find().select("_id").lean();
        for (const ws of workspaces) {
            await getWorkspaceStorageDetails(ws._id, { persist: true });
        }
    } catch (err) {
        console.error("Non-fatal syncAllWorkspacesStorage error:", err);
    }
}

/**
 * Returns complete plan details, usage statistics, and bounded tier entitlements
 */
export async function getWorkspacePlanUsage(workspaceId) {
    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const config = resolvePlanConfig(workspace.subscription);

    const [employeeCount, deviceCount, storageDetails] = await Promise.all([
        Employee.countDocuments({ workspace: workspace._id, isDeleted: { $ne: true } }),
        Device.countDocuments({ workspace: workspace._id, status: { $ne: "revoked" } }),
        getWorkspaceStorageDetails(workspace._id, { persist: true }),
    ]);

    const maxEmployees = config.maxEmployees;
    const maxDevices = config.maxDevices;
    const storageLimitBytes = config.storageLimitBytes;

    const storageUsedBytes = storageDetails.totalBytes;
    const databaseBytes = storageDetails.databaseBytes;
    const s3Bytes = storageDetails.s3Bytes;

    const isEmployeeLimitReached = employeeCount >= maxEmployees;
    const isDeviceLimitReached = deviceCount >= maxDevices;
    const isStorageLimitReached = storageUsedBytes >= storageLimitBytes;

    const rawStoragePercent = storageLimitBytes ? (storageUsedBytes / storageLimitBytes) * 100 : 0;
    const storagePercent = Math.min(100, Math.round(rawStoragePercent * 100) / 100);

    return {
        plan: config.plan,
        planName: config.planName,
        monthlyPriceUsd: config.monthlyPriceUsd,
        yearlyMonthlyPriceUsd: config.yearlyMonthlyPriceUsd,
        isPaid: config.isPaid,
        isFree: !config.isPaid,
        employeeCount,
        maxEmployees,
        isEmployeeLimitReached,
        deviceCount,
        maxDevices,
        isDeviceLimitReached,
        storageUsedBytes,
        databaseBytes,
        s3Bytes,
        storageLimitBytes,
        storageRemainingBytes: Math.max(0, storageLimitBytes - storageUsedBytes),
        isStorageLimitReached,
        storagePercent,
        storageBreakdown: storageDetails.breakdown,
        maxChatMembersPerUser: config.maxChatMembersPerUser,
        maxFileSizeBytes: config.maxFileSizeBytes,
        maxSalaryComponents: config.maxSalaryComponents,
        upgradedAt: workspace.subscription?.upgradedAt || null,
        features: {
            advancedReports: config.features.advancedReports,
            advancedEmails: config.features.advancedEmails,
            unlimitedEmployees: false,
            unlimitedDevices: false,
            unlimitedStorage: false,
            unlimitedChatMembers: false,
            chatAttachments: config.features.chatAttachments,
            auditLogs: config.features.auditLogs,
        },
    };
}

/**
 * Enforces bounded employee headcount quota for ALL tiers (single add & bulk CSV import)
 */
export async function assertEmployeeQuota(workspaceId, incomingCount = 1) {
    const workspace = await Workspace.findById(workspaceId).select("subscription").lean();
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const config = resolvePlanConfig(workspace.subscription);
    const employeeCount = await Employee.countDocuments({ workspace: workspaceId, isDeleted: { $ne: true } });

    if (employeeCount + incomingCount > config.maxEmployees) {
        throw ApiError.forbidden(
            `Your organization has reached or would exceed the ${config.maxEmployees}-employee limit on the ${config.planName} (currently ${employeeCount}/${config.maxEmployees}). Upgrade to a higher plan to add more team members.`,
            "EMPLOYEE_LIMIT_REACHED"
        );
    }
}

/**
 * Enforces bounded biometric device quota for ALL tiers
 */
export async function assertDeviceQuota(workspaceId) {
    const workspace = await Workspace.findById(workspaceId).select("subscription").lean();
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const config = resolvePlanConfig(workspace.subscription);
    const deviceCount = await Device.countDocuments({ workspace: workspaceId, status: { $ne: "revoked" } });

    if (deviceCount >= config.maxDevices) {
        throw ApiError.forbidden(
            `${config.planName} allows a maximum of ${config.maxDevices} active biometric devices (${deviceCount}/${config.maxDevices} used). Upgrade your plan to connect more devices.`,
            "DEVICE_LIMIT_REACHED"
        );
    }
}

/**
 * Enforces both per-file upload size limit AND combined DB+S3 storage cap for ALL tiers
 */
export async function assertStorageQuota(workspaceId, incomingBytes = 0, files = null) {
    const workspace = await Workspace.findById(workspaceId).select("subscription").lean();
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const config = resolvePlanConfig(workspace.subscription);

    if (Array.isArray(files) && files.length > 0) {
        for (const f of files) {
            const size = Number(f?.size || f?.fileSize || f?.buffer?.length || 0);
            if (size > config.maxFileSizeBytes) {
                throw ApiError.badRequest(
                    `File exceeds the ${formatLimitBytesLabel(config.maxFileSizeBytes)} per-file limit on the ${config.planName}.`
                );
            }
        }
    } else if (incomingBytes > config.maxFileSizeBytes) {
        throw ApiError.badRequest(
            `File exceeds the ${formatLimitBytesLabel(config.maxFileSizeBytes)} per-file limit on the ${config.planName}.`
        );
    }

    const currentUsage = await calculateWorkspaceStorageBytes(workspaceId);
    if (currentUsage + incomingBytes > config.storageLimitBytes) {
        throw ApiError.forbidden(
            `Your organization has reached the ${formatLimitBytesLabel(config.storageLimitBytes)} combined storage limit on the ${config.planName}. Upgrade your plan or remove unused files to continue uploading.`,
            "STORAGE_LIMIT_REACHED"
        );
    }
}

/**
 * Enforces per-user direct chat contact quota across ALL tiers
 */
export async function assertChatQuota(workspaceId, userId, recipientId) {
    const workspace = await Workspace.findById(workspaceId).select("subscription").lean();
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const config = resolvePlanConfig(workspace.subscription);

    const existing = await Conversation.findOne({
        workspace: workspaceId,
        participants: { $all: [userId, recipientId], $size: 2 },
    }).select("_id").lean();

    if (existing) return;

    const limit = config.maxChatMembersPerUser;

    const senderConvCount = await Conversation.countDocuments({
        workspace: workspaceId,
        participants: userId,
    });

    if (senderConvCount >= limit) {
        throw ApiError.forbidden(
            `You have reached your ${config.planName} limit of ${limit} direct chat contacts. Upgrade your organization plan to message more team members.`,
            "CHAT_MEMBER_LIMIT_REACHED"
        );
    }

    const recipientConvCount = await Conversation.countDocuments({
        workspace: workspaceId,
        participants: recipientId,
    });

    if (recipientConvCount >= limit) {
        throw ApiError.forbidden(
            `The selected team member has reached their ${config.planName} limit of ${limit} chat contacts. Upgrade your organization plan to expand messaging limits.`,
            "CHAT_MEMBER_LIMIT_REACHED"
        );
    }
}

export async function isAdvancedEmailAllowed(workspaceId) {
    if (!workspaceId) return false;
    const workspace = await Workspace.findById(workspaceId).select("subscription").lean();
    return resolvePlanConfig(workspace?.subscription).features.advancedEmails;
}

/**
 * Updates subscription plan across all supported tiers (free, growth, pro, enterprise)
 */
export async function updateWorkspaceSubscriptionPlan(workspaceId, newPlan, { markPaid = false } = {}) {
    if (!VALID_PLAN_KEYS.includes(newPlan)) {
        throw ApiError.badRequest("Invalid plan. Expected 'free', 'growth', 'pro', or 'enterprise'.");
    }

    const config = resolvePlanConfig(newPlan);
    const existing = await Workspace.findById(workspaceId).select("subscription billing accessRevoked").lean();
    if (!existing) throw ApiError.notFound("Workspace not found");

    const prevPlan = normalizePlanKey(existing.subscription);
    const now = new Date();
    const update = {
        "subscription.plan": config.plan,
        "subscription.planName": config.planName,
        "subscription.storageLimitBytes": config.storageLimitBytes,
        "subscription.maxEmployees": config.maxEmployees,
        "subscription.maxDevices": config.maxDevices,
        "subscription.upgradedAt": config.isPaid ? now : null,
    };

    if (!config.isPaid) {
        update.accessRevoked = false;
        update.accessRevokedAt = null;
        update.accessRevokedReason = "";
        update["billing.paymentStatus"] = "none";
        update["billing.firstFollowUpSentAt"] = null;
        update["billing.secondFollowUpSentAt"] = null;
    } else if (markPaid) {
        update.accessRevoked = false;
        update.accessRevokedAt = null;
        update.accessRevokedReason = "";
        update["billing.paymentStatus"] = "paid";
        update["billing.paidAt"] = now;
        update["billing.restoredAt"] = existing.accessRevoked ? now : existing.billing?.restoredAt || null;
    } else if (prevPlan !== config.plan || !existing.billing?.paymentStatus || existing.billing?.paymentStatus === "none") {
        update.accessRevoked = false;
        update.accessRevokedAt = null;
        update.accessRevokedReason = "";
        update["billing.paymentStatus"] = "unpaid";
        update["billing.firstFollowUpSentAt"] = null;
        update["billing.secondFollowUpSentAt"] = null;
        update["billing.paidAt"] = null;
    }

    const workspace = await Workspace.findByIdAndUpdate(workspaceId, { $set: update }, { new: true });
    if (!workspace) throw ApiError.notFound("Workspace not found");

    return getWorkspacePlanUsage(workspaceId);
}
