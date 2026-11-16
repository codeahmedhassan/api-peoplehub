// src/services/performance/performance.service.js
import mongoose from "mongoose";
import { PerformanceAppraisal, APPRAISAL_CATEGORIES } from "../../model/performance/performanceAppraisal.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { User } from "../../model/auth/auth.model.js";
import { EmployeeActivity } from "../../model/employee/activity.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { buildManagerDirectReportsMongoFilter } from "../employee/employee.service.js";

/**
 * Determine rating band based on numerical score (1.0 - 5.0)
 */
export function getRatingBand(score) {
    if (!score || score <= 0) return "Not Evaluated";
    if (score >= 4.8) return "Exceptional";
    if (score >= 4.0) return "Exceeds Expectations";
    if (score >= 3.0) return "Meets Expectations";
    if (score >= 2.0) return "Needs Improvement";
    return "Unsatisfactory";
}

/**
 * Resolve direct reports assigned under the logged-in user / manager.
 * Supports:
 * - Direct reports with reportingManager set to manager's employeeId, name, or fullName.
 * - CEO / Founder direct reports (including managers like HR or Dept heads reporting to CEO).
 */
export async function getManagerDirectReports(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const caller = await User.findById(userId).lean();
    if (!caller) throw ApiError.unauthorized("User not found");

    const isCEO = Boolean(
        workspace.owner?.toString() === userId.toString() ||
        caller.role === "Founder / CEO" ||
        caller.role === "Administrator"
    );

    // Look for employee profile belonging to caller
    const callerEmployee = await Employee.findOne({
        workspace: workspace._id,
        $or: [
            { linkedUser: caller._id },
            { loginEmail: caller.email?.toLowerCase() },
            { personalEmail: caller.email?.toLowerCase() },
        ],
    }).lean();

    const baseDirectFilter = buildManagerDirectReportsMongoFilter(workspace._id, caller, callerEmployee, { includeSelf: false });
    const orClauses = [...(baseDirectFilter.$or || [])];

    if (isCEO) {
        orClauses.push({
            reportingManager: {
                $in: [
                    "None (Reports to CEO)",
                    "Reports to CEO",
                    "CEO",
                    "Founder",
                    "Owner",
                    "None",
                    "",
                    null,
                ],
            },
        });
    }

    const filter = {
        workspace: workspace._id,
        employmentStatus: { $ne: "Terminated" },
        ...(callerEmployee ? { _id: { $ne: callerEmployee._id } } : {}),
        $or: orClauses,
    };

    let employees = await Employee.find(filter)
        .sort({ firstName: 1, lastName: 1 })
        .lean();

    // Fallback for CEO: If no explicit reportingManager matching CEO was set yet,
    // in small workspaces without hierarchy CEO manages all active employees (excluding self)
    if (isCEO && employees.length === 0) {
        employees = await Employee.find({
            workspace: workspace._id,
            employmentStatus: { $ne: "Terminated" },
            ...(callerEmployee ? { _id: { $ne: callerEmployee._id } } : {}),
        })
            .sort({ firstName: 1, lastName: 1 })
            .lean();
    }

    const hasTeam = employees.length > 0;

    return {
        hasTeam,
        teamCount: employees.length,
        manager: {
            id: caller._id.toString(),
            name: caller.fullName,
            role: caller.role,
            employeeId: callerEmployee?.employeeId || null,
        },
        employees: employees.map((emp) => ({
            id: emp._id.toString(),
            employeeId: emp.employeeId,
            name: `${emp.firstName} ${emp.lastName}`.trim(),
            firstName: emp.firstName,
            lastName: emp.lastName,
            avatar: emp.avatar || "",
            designation: emp.designation || "Staff",
            department: emp.department || "General",
            branch: emp.branch || emp.workLocation || "",
            reportingManager: emp.reportingManager || "",
            joiningDate: emp.joiningDate,
            latestAppraisal: emp.latestAppraisal || null,
        })),
    };
}

/**
 * Performance Dashboard analytics for the manager's team.
 */
export async function getPerformanceDashboardData(userId) {
    const { hasTeam, teamCount, manager, employees } = await getManagerDirectReports(userId);

    if (!hasTeam) {
        return {
            hasTeam: false,
            teamCount: 0,
            manager,
            message: "No employees are assigned under your management.",
        };
    }

    const employeeIds = employees.map((e) => e.id);

    // Fetch all historical appraisals for these employees
    const appraisals = await PerformanceAppraisal.find({
        employee: { $in: employeeIds },
        status: "completed",
    })
        .sort({ reviewDate: -1, createdAt: -1 })
        .lean();

    // Group appraisals by employee
    const appraisalsByEmp = new Map();
    for (const app of appraisals) {
        const empKey = app.employee.toString();
        if (!appraisalsByEmp.has(empKey)) {
            appraisalsByEmp.set(empKey, []);
        }
        appraisalsByEmp.get(empKey).push(app);
    }

    // Combine employees with their latest appraisal
    let totalScore = 0;
    let evaluatedCount = 0;
    let exceptionalCount = 0;
    let exceedsCount = 0;
    let meetsCount = 0;
    let needsImprovementCount = 0;
    let unratedCount = 0;

    // Category score aggregators
    const categoryTotals = {
        quality: { sum: 0, count: 0, name: "Quality of Work" },
        productivity: { sum: 0, count: 0, name: "Productivity & Timeliness" },
        communication: { sum: 0, count: 0, name: "Communication & Teamwork" },
        problemSolving: { sum: 0, count: 0, name: "Problem Solving & Initiative" },
        leadership: { sum: 0, count: 0, name: "Leadership & Values" },
    };

    const enrichedEmployees = employees.map((emp) => {
        const history = appraisalsByEmp.get(emp.id) || [];
        const latest = history[0] || null;

        if (latest) {
            totalScore += latest.overallRating;
            evaluatedCount++;

            if (latest.overallRating >= 4.8) exceptionalCount++;
            else if (latest.overallRating >= 4.0) exceedsCount++;
            else if (latest.overallRating >= 3.0) meetsCount++;
            else needsImprovementCount++;

            // Accumulate category scores
            if (Array.isArray(latest.categories)) {
                latest.categories.forEach((cat) => {
                    if (categoryTotals[cat.key]) {
                        categoryTotals[cat.key].sum += Number(cat.score) || 0;
                        categoryTotals[cat.key].count += 1;
                    }
                });
            }
        } else {
            unratedCount++;
        }

        return {
            ...emp,
            latestAppraisal: latest
                ? {
                      id: latest._id.toString(),
                      rating: latest.overallRating,
                      band: latest.ratingBand,
                      reviewPeriod: latest.reviewPeriod,
                      reviewDate: latest.reviewDate,
                      recommendation: latest.recommendation,
                      keyStrengths: latest.keyStrengths,
                      areasForImprovement: latest.areasForImprovement,
                  }
                : null,
            totalReviews: history.length,
        };
    });

    // Team average score
    const teamAverageRating = evaluatedCount > 0 ? Math.round((totalScore / evaluatedCount) * 10) / 10 : 0;
    const teamAverageBand = getRatingBand(teamAverageRating);

    // Ranking list sorted by rating descending
    const rankings = [...enrichedEmployees]
        .sort((a, b) => {
            const scoreA = a.latestAppraisal?.rating ?? -1;
            const scoreB = b.latestAppraisal?.rating ?? -1;
            return scoreB - scoreA;
        })
        .map((emp, index) => ({
            rank: index + 1,
            id: emp.id,
            employeeId: emp.employeeId,
            name: emp.name,
            avatar: emp.avatar,
            department: emp.department,
            designation: emp.designation,
            rating: emp.latestAppraisal?.rating ?? null,
            ratingBand: emp.latestAppraisal?.band ?? "Not Evaluated",
            reviewPeriod: emp.latestAppraisal?.reviewPeriod || "Pending Review",
            reviewDate: emp.latestAppraisal?.reviewDate || null,
            totalReviews: emp.totalReviews,
        }));

    // Top performers (rating >= 4.0 or top 3)
    const topPerformers = rankings.filter((r) => r.rating !== null && r.rating >= 4.0).slice(0, 5);

    // Performance by Category calculation
    const performanceByCategory = Object.entries(categoryTotals).map(([key, data]) => {
        const avg = data.count > 0 ? Math.round((data.sum / data.count) * 10) / 10 : 0;
        const percent = Math.round((avg / 5) * 100);
        let benchmark = "Good";
        if (avg >= 4.5) benchmark = "Outstanding";
        else if (avg >= 4.0) benchmark = "Strong";
        else if (avg >= 3.0) benchmark = "Solid";
        else if (avg > 0) benchmark = "Needs Focus";
        else benchmark = "Pending";

        return {
            key,
            name: data.name,
            score: avg,
            percentage: percent,
            benchmark,
            reviewsCount: data.count,
        };
    });

    // Recent reviews across the team
    const recentReviews = appraisals.slice(0, 6).map((app) => {
        const emp = employees.find((e) => e.id === app.employee.toString());
        return {
            id: app._id.toString(),
            employeeId: app.employeeId,
            employeeName: emp ? emp.name : "Employee",
            avatar: emp?.avatar || "",
            overallRating: app.overallRating,
            ratingBand: app.ratingBand,
            reviewPeriod: app.reviewPeriod,
            reviewDate: app.reviewDate,
            recommendation: app.recommendation,
        };
    });

    return {
        hasTeam: true,
        teamCount,
        manager,
        overview: {
            teamAverageRating,
            teamAverageBand,
            totalManaged: teamCount,
            reviewsCompleted: evaluatedCount,
            reviewsPending: unratedCount,
            topPerformersCount: topPerformers.length,
            needsImprovementCount,
            completionPercentage: teamCount > 0 ? Math.round((evaluatedCount / teamCount) * 100) : 0,
        },
        topPerformers,
        rankings,
        teamPerformance: {
            completionRate: teamCount > 0 ? Math.round((evaluatedCount / teamCount) * 100) : 0,
            distribution: [
                { band: "Exceptional", count: exceptionalCount, percent: teamCount > 0 ? Math.round((exceptionalCount / teamCount) * 100) : 0, color: "#10b981" },
                { band: "Exceeds Expectations", count: exceedsCount, percent: teamCount > 0 ? Math.round((exceedsCount / teamCount) * 100) : 0, color: "#3b82f6" },
                { band: "Meets Expectations", count: meetsCount, percent: teamCount > 0 ? Math.round((meetsCount / teamCount) * 100) : 0, color: "#6366f1" },
                { band: "Needs Improvement", count: needsImprovementCount, percent: teamCount > 0 ? Math.round((needsImprovementCount / teamCount) * 100) : 0, color: "#f59e0b" },
                { band: "Not Evaluated", count: unratedCount, percent: teamCount > 0 ? Math.round((unratedCount / teamCount) * 100) : 0, color: "#94a3b8" },
            ],
        },
        performanceByCategory,
        recentReviews,
    };
}

/**
 * Fetch a specific employee's appraisal history & details for the review form.
 */
export async function getEmployeeAppraisalDetails(userId, employeeIdentifier) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { employees, manager } = await getManagerDirectReports(userId);

    const isMatch = (e) =>
        e.employeeId?.toLowerCase() === employeeIdentifier.toLowerCase() ||
        e.id === employeeIdentifier;

    const empSummary = employees.find(isMatch);
    if (!empSummary) {
        throw ApiError.forbidden("You do not have permission to evaluate this employee or employee is not in your direct team.");
    }

    const employee = await Employee.findById(empSummary.id).lean();
    if (!employee) throw ApiError.notFound("Employee not found");

    const history = await PerformanceAppraisal.find({
        workspace: workspace._id,
        employee: employee._id,
    })
        .sort({ reviewDate: -1, createdAt: -1 })
        .lean();

    return {
        employee: {
            id: employee._id.toString(),
            employeeId: employee.employeeId,
            firstName: employee.firstName,
            lastName: employee.lastName,
            name: `${employee.firstName} ${employee.lastName}`.trim(),
            avatar: employee.avatar || "",
            designation: employee.designation || "Staff",
            department: employee.department || "General",
            branch: employee.branch || employee.workLocation || "",
            joiningDate: employee.joiningDate,
            reportingManager: employee.reportingManager,
            workingHours: employee.workingHours || 8,
            latestAppraisal: employee.latestAppraisal || null,
        },
        categoriesTemplate: APPRAISAL_CATEGORIES,
        history: history.map((h) => new PerformanceAppraisal(h).toSafeJSON()),
        manager,
    };
}

/**
 * Submit or update a performance appraisal evaluation for an employee.
 */
export async function submitEmployeeAppraisal(userId, employeeIdentifier, payload) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { employees, manager } = await getManagerDirectReports(userId);

    const isMatch = (e) =>
        e.employeeId?.toLowerCase() === employeeIdentifier.toLowerCase() ||
        e.id === employeeIdentifier;

    const empSummary = employees.find(isMatch);
    if (!empSummary) {
        throw ApiError.forbidden("You do not have permission to evaluate this employee.");
    }

    const employee = await Employee.findById(empSummary.id);
    if (!employee) throw ApiError.notFound("Employee not found");

    // Standardize categories and calculate score
    const rawCategories = Array.isArray(payload.categories) ? payload.categories : [];
    const categories = APPRAISAL_CATEGORIES.map((cat) => {
        const provided = rawCategories.find((c) => c.key === cat.key) || {};
        const score = Math.max(1, Math.min(5, Number(provided.score) || 3));
        return {
            key: cat.key,
            name: cat.name,
            score,
            comments: typeof provided.comments === "string" ? provided.comments.trim() : "",
        };
    });

    const sumScores = categories.reduce((acc, curr) => acc + curr.score, 0);
    const overallRating = Math.round((sumScores / categories.length) * 10) / 10;
    const ratingBand = getRatingBand(overallRating);

    const appraisal = await PerformanceAppraisal.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        manager: userId,
        managerName: manager.name,
        reviewPeriod: payload.reviewPeriod || "Annual Review",
        reviewDate: payload.reviewDate ? new Date(payload.reviewDate) : new Date(),
        nextReviewDate: payload.nextReviewDate ? new Date(payload.nextReviewDate) : null,
        overallRating,
        ratingBand,
        categories,
        keyStrengths: payload.keyStrengths || "",
        areasForImprovement: payload.areasForImprovement || "",
        goalsAndAchievements: payload.goalsAndAchievements || "",
        recommendation: payload.recommendation || "Retain at Current Level",
        managerPrivateNotes: payload.managerPrivateNotes || "",
        status: payload.status || "completed",
    });

    // Update summary on Employee document
    employee.latestAppraisal = {
        rating: overallRating,
        band: ratingBand,
        reviewDate: appraisal.reviewDate,
        reviewPeriod: appraisal.reviewPeriod,
        recommendation: appraisal.recommendation,
        appraisalId: appraisal._id,
    };
    await employee.save();

    // Log activity
    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Performance appraisal completed: ${overallRating} / 5.0 (${ratingBand}) for ${appraisal.reviewPeriod} by ${manager.name}.`,
    }).catch(() => {});

    return appraisal.toSafeJSON();
}
