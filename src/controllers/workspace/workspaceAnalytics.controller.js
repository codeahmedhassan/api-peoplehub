import { biAnalyticsService } from "../../services/observability/biAnalytics.service.js";
import { ApiError } from "../../utils/ApiError.js";

function getWorkspaceId(req) {
    const wsId = req.workspace?._id || req.user?.activeWorkspace;
    if (!wsId) {
        throw ApiError.badRequest("No active workspace found for this user");
    }
    return wsId.toString();
}

export async function getWorkforceBiController(req, res, next) {
    try {
        const workspaceId = getWorkspaceId(req);
        const data = await biAnalyticsService.getWorkforceBI(workspaceId);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getAttendanceBiController(req, res, next) {
    try {
        const workspaceId = getWorkspaceId(req);
        const days = parseInt(req.query.days || "30", 10);
        const data = await biAnalyticsService.getAttendanceBI(workspaceId, days);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getLeaveBiController(req, res, next) {
    try {
        const workspaceId = getWorkspaceId(req);
        const data = await biAnalyticsService.getLeaveBI(workspaceId);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getPayrollBiController(req, res, next) {
    try {
        const workspaceId = getWorkspaceId(req);
        const data = await biAnalyticsService.getPayrollBI(workspaceId);
        res.json({ success: true, data });
    } catch (err) {
        next(err);
    }
}

export async function getOverviewBiController(req, res, next) {
    try {
        const workspaceId = getWorkspaceId(req);
        const [workforce, attendance, leave, payroll] = await Promise.all([
            biAnalyticsService.getWorkforceBI(workspaceId),
            biAnalyticsService.getAttendanceBI(workspaceId, 7),
            biAnalyticsService.getLeaveBI(workspaceId),
            biAnalyticsService.getPayrollBI(workspaceId),
        ]);

        res.json({
            success: true,
            data: {
                workforce,
                attendance,
                leave,
                payroll,
            },
        });
    } catch (err) {
        next(err);
    }
}
