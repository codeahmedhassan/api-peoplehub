import mongoose from "mongoose";
import { Employee } from "../../model/employee/employee.model.js";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { LeaveRequest } from "../../model/leave/leave.model.js";
import { PayrollBatch } from "../../model/payroll/payrollBatch.model.js";

// In-memory cache with 60-second TTL for heavy BI aggregations
const biCache = new Map();
const CACHE_TTL_MS = 60000;

function getCached(key) {
    const item = biCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
        biCache.delete(key);
        return null;
    }
    return item.data;
}

function setCached(key, data) {
    biCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

class ProprietaryBiAnalyticsService {
    /**
     * Complete Workforce Business Intelligence.
     * STRICT TENANT ISOLATION: Scoped to workspaceId.
     */
    async getWorkforceBI(workspaceId) {
        const cacheKey = `bi:workforce:${workspaceId}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        const orgObjId = new mongoose.Types.ObjectId(workspaceId);

        // 1. Total Active vs Inactive Employees
        const [statusCounts, deptDistribution, growthTrend] = await Promise.all([
            Employee.aggregate([
                { $match: { workspace: orgObjId } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
            Employee.aggregate([
                { $match: { workspace: orgObjId, status: "active" } },
                { $group: { _id: { $ifNull: ["$jobDetails.department", "Unassigned"] }, count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),
            Employee.aggregate([
                { $match: { workspace: orgObjId } },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: "%Y-%m",
                                date: { $ifNull: ["$jobDetails.joiningDate", "$createdAt"] },
                            },
                        },
                        newHires: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
                { $limit: 12 },
            ]),
        ]);

        const activeEmployees = statusCounts.find((s) => s._id === "active")?.count || 0;
        const inactiveEmployees = statusCounts.find((s) => s._id === "inactive" || s._id === "terminated")?.count || 0;
        const totalEmployees = statusCounts.reduce((acc, s) => acc + s.count, 0);

        const data = {
            totalEmployees,
            activeEmployees,
            inactiveEmployees,
            departmentDistribution: deptDistribution.map((d) => ({
                department: d._id,
                count: d.count,
                percentage: totalEmployees > 0 ? Math.round((d.count / totalEmployees) * 100) : 0,
            })),
            growthTrend: growthTrend.map((g) => ({
                month: g._id,
                newHires: g.newHires,
            })),
        };

        setCached(cacheKey, data);
        return data;
    }

    /**
     * Attendance Business Intelligence.
     * STRICT TENANT ISOLATION: Scoped to workspaceId.
     */
    async getAttendanceBI(workspaceId, days = 30) {
        const cacheKey = `bi:attendance:${workspaceId}:${days}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        const orgObjId = new mongoose.Types.ObjectId(workspaceId);
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        startDate.setHours(0, 0, 0, 0);

        const [statusTotals, dailyTrends, lateMetrics] = await Promise.all([
            AttendanceRecord.aggregate([
                { $match: { workspace: orgObjId, date: { $gte: startDate } } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
            AttendanceRecord.aggregate([
                { $match: { workspace: orgObjId, date: { $gte: startDate } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        present: { $sum: { $cond: [{ $in: ["$status", ["present", "remote"]] }, 1, 0] } },
                        absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
                        late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
                        halfDay: { $sum: { $cond: [{ $eq: ["$status", "half-day"] }, 1, 0] } },
                        avgHours: { $avg: "$hoursWorked" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            AttendanceRecord.aggregate([
                { $match: { workspace: orgObjId, date: { $gte: startDate }, status: "late" } },
                { $count: "totalLate" },
            ]),
        ]);

        const presentCount = statusTotals.find((s) => s._id === "present")?.count || 0;
        const absentCount = statusTotals.find((s) => s._id === "absent")?.count || 0;
        const lateCount = statusTotals.find((s) => s._id === "late")?.count || 0;
        const remoteCount = statusTotals.find((s) => s._id === "remote")?.count || 0;
        const totalRecords = statusTotals.reduce((acc, s) => acc + s.count, 0);

        const punctualityRate =
            totalRecords > 0 ? Math.round(((presentCount + remoteCount) / totalRecords) * 100) : 100;

        const data = {
            totalRecords,
            presentCount,
            absentCount,
            lateCount,
            remoteCount,
            punctualityRate,
            dailyTrends: dailyTrends.map((d) => ({
                date: d._id,
                present: d.present,
                absent: d.absent,
                late: d.late,
                halfDay: d.halfDay,
                avgHours: Math.round((d.avgHours || 0) * 10) / 10,
            })),
        };

        setCached(cacheKey, data);
        return data;
    }

    /**
     * Leave Business Intelligence.
     * STRICT TENANT ISOLATION: Scoped to workspaceId.
     */
    async getLeaveBI(workspaceId) {
        const cacheKey = `bi:leave:${workspaceId}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        const orgObjId = new mongoose.Types.ObjectId(workspaceId);

        const [statusAgg, typeAgg, approvalDurations] = await Promise.all([
            LeaveRequest.aggregate([
                { $match: { workspace: orgObjId } },
                { $group: { _id: "$status", count: { $sum: 1 }, totalDays: { $sum: "$totalDays" } } },
            ]),
            LeaveRequest.aggregate([
                { $match: { workspace: orgObjId } },
                { $group: { _id: "$type", count: { $sum: 1 } } },
                { $sort: { count: -1 } },
            ]),
            LeaveRequest.aggregate([
                {
                    $match: {
                        workspace: orgObjId,
                        status: { $in: ["approved", "rejected"] },
                        actionedAt: { $ne: null },
                    },
                },
                {
                    $project: {
                        durationHours: {
                            $divide: [{ $subtract: ["$actionedAt", "$createdAt"] }, 1000 * 60 * 60],
                        },
                    },
                },
                { $group: { _id: null, avgHours: { $avg: "$durationHours" } } },
            ]),
        ]);

        const approved = statusAgg.find((s) => s._id === "approved")?.count || 0;
        const rejected = statusAgg.find((s) => s._id === "rejected")?.count || 0;
        const pending = statusAgg.find((s) => s._id === "pending")?.count || 0;
        const total = statusAgg.reduce((acc, s) => acc + s.count, 0);

        const approvalRate = total > 0 ? Math.round((approved / total) * 100) : 0;
        const rejectionRate = total > 0 ? Math.round((rejected / total) * 100) : 0;
        const avgApprovalHours =
            approvalDurations[0]?.avgHours ? Math.round(approvalDurations[0].avgHours * 10) / 10 : 0;

        const data = {
            totalRequests: total,
            approved,
            rejected,
            pending,
            approvalRate,
            rejectionRate,
            avgApprovalHours,
            typeDistribution: typeAgg.map((t) => ({ type: t._id || "Other", count: t.count })),
        };

        setCached(cacheKey, data);
        return data;
    }

    /**
     * Payroll Business Intelligence.
     * STRICT TENANT ISOLATION: Scoped to workspaceId.
     */
    async getPayrollBI(workspaceId) {
        const cacheKey = `bi:payroll:${workspaceId}`;
        const cached = getCached(cacheKey);
        if (cached) return cached;

        const orgObjId = new mongoose.Types.ObjectId(workspaceId);

        const [batches, batchStatusAgg] = await Promise.all([
            PayrollBatch.find({ workspace: orgObjId })
                .sort({ createdAt: -1 })
                .limit(12)
                .select("month year status employeeCount createdAt updatedAt")
                .lean(),
            PayrollBatch.aggregate([
                { $match: { workspace: orgObjId } },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
        ]);

        const completed = batchStatusAgg.find((b) => b._id === "completed" || b._id === "approved")?.count || 0;
        const totalBatches = batchStatusAgg.reduce((acc, b) => acc + b.count, 0);
        const successRate = totalBatches > 0 ? Math.round((completed / totalBatches) * 100) : 100;

        const data = {
            totalBatches,
            completedBatches: completed,
            successRate,
            recentBatches: batches.map((b) => ({
                id: b._id,
                period: `${b.month}/${b.year}`,
                status: b.status,
                employeeCount: b.employeeCount || 0,
                processingDurationSeconds: b.updatedAt
                    ? Math.round((new Date(b.updatedAt) - new Date(b.createdAt)) / 1000)
                    : 0,
            })),
        };

        setCached(cacheKey, data);
        return data;
    }
}

export const biAnalyticsService = new ProprietaryBiAnalyticsService();
