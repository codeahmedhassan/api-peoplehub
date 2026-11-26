import { AuditLog } from "../../model/audit/auditLog.model.js";
import { User } from "../../model/auth/auth.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { getCallerRoleContext } from "../employee/employee.service.js";
import { resolvePlanConfig } from "../workspace/plan.service.js";
import { ApiError } from "../../utils/ApiError.js";

/**
 * Global helper to record structured audit logs across any HR workflow.
 * Guaranteed to never throw uncaught exceptions that interrupt the main transaction.
 */
export async function recordAuditLog({
    workspaceId,
    actorId,
    actorName,
    actorEmail,
    actorRole,
    action,
    module,
    targetId = "",
    targetName = "",
    targetType = "",
    description,
    details = {},
    ipAddress = "",
    status = "success",
    req = null,
}) {
    try {
        if (!workspaceId || !action || !module || !description) {
            return null;
        }

        let resolvedIp = ipAddress;
        if (!resolvedIp && req) {
            resolvedIp = req.headers?.["x-forwarded-for"]?.split(",")?.[0]?.trim() || req.ip || req.socket?.remoteAddress || "";
        }

        let resolvedActorName = actorName;
        let resolvedActorEmail = actorEmail;
        let resolvedActorRole = actorRole;

        if ((!resolvedActorName || !resolvedActorRole) && actorId) {
            try {
                const user = await User.findById(actorId).lean();
                if (user) {
                    resolvedActorName = resolvedActorName || user.fullName || "User";
                    resolvedActorEmail = resolvedActorEmail || user.email || "";
                    resolvedActorRole = resolvedActorRole || user.systemRole || user.role || "User";
                }
            } catch {}
        }

        return await AuditLog.create({
            workspace: workspaceId,
            actor: actorId || null,
            actorName: resolvedActorName || "System / Automated",
            actorEmail: resolvedActorEmail || "",
            actorRole: resolvedActorRole || "System",
            action,
            module,
            targetId: String(targetId || ""),
            targetName: String(targetName || ""),
            targetType: String(targetType || ""),
            description: String(description).slice(0, 1000),
            details: details || {},
            ipAddress: resolvedIp,
            status,
        });
    } catch (err) {
        console.error("Non-fatal AuditLog error:", err);
        return null;
    }
}

/**
 * Retrieves paginated audit logs for a workspace with dynamic search and multi-facet filters.
 * Accessible to CEO and HR (or any user with auditLogs.view permission).
 */
export async function getWorkspaceAuditLogs(userId, query = {}) {
    const workspace = await getWorkspaceOrThrow(userId);

    const planConfig = resolvePlanConfig(workspace.subscription);
    if (!planConfig.features.auditLogs) {
        throw ApiError.forbidden(
            "Audit Logs are available on the Paid Pro ($49/mo) and Business Scale ($119/mo) plans. Please upgrade your plan to view audit logs.",
            "PLAN_UPGRADE_REQUIRED"
        );
    }

    const { isCEO, isHR, caller } = await getCallerRoleContext(userId, workspace);

    const hasAuditPerm = Boolean(
        isCEO ||
        isHR ||
        caller?.permissions?.auditLogs?.view ||
        caller?.permissions?.all
    );

    if (!hasAuditPerm) {
        throw ApiError.forbidden("You do not have permission to view workspace audit logs.");
    }

    const {
        search = "",
        module: moduleFilter = "",
        action: actionFilter = "",
        actorId = "",
        startDate = "",
        endDate = "",
        page = 1,
        limit = 50,
    } = query;

    const filter = { workspace: workspace._id };

    if (moduleFilter && moduleFilter !== "All") {
        filter.module = moduleFilter;
    }

    if (actionFilter) {
        filter.action = actionFilter;
    }

    if (actorId) {
        filter.actor = actorId;
    }

    if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) {
            const start = new Date(startDate);
            if (!isNaN(start.getTime())) filter.createdAt.$gte = start;
        }
        if (endDate) {
            const end = new Date(endDate);
            if (!isNaN(end.getTime())) {
                end.setHours(23, 59, 59, 999);
                filter.createdAt.$lte = end;
            }
        }
    }

    if (search && search.trim()) {
        const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(escaped, "i");
        filter.$or = [
            { description: regex },
            { actorName: regex },
            { actorEmail: regex },
            { targetName: regex },
            { action: regex },
            { ipAddress: regex },
        ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;

    const [logs, totalCount, moduleCounts] = await Promise.all([
        AuditLog.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum)
            .lean(),
        AuditLog.countDocuments(filter),
        AuditLog.aggregate([
            { $match: { workspace: workspace._id } },
            { $group: { _id: "$module", count: { $sum: 1 } } },
        ]),
    ]);

    const moduleStats = {};
    for (const item of moduleCounts) {
        if (item._id) moduleStats[item._id] = item.count;
    }

    return {
        logs: logs.map((l) => ({
            id: l._id,
            actorId: l.actor,
            actorName: l.actorName,
            actorEmail: l.actorEmail,
            actorRole: l.actorRole,
            action: l.action,
            module: l.module,
            targetId: l.targetId,
            targetName: l.targetName,
            targetType: l.targetType,
            description: l.description,
            details: l.details,
            ipAddress: l.ipAddress,
            status: l.status,
            createdAt: l.createdAt,
        })),
        pagination: {
            page: pageNum,
            limit: limitNum,
            totalCount,
            totalPages: Math.ceil(totalCount / limitNum),
        },
        moduleStats,
    };
}
