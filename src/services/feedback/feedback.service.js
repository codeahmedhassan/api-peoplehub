import { Feedback } from "../../model/feedback/feedback.model.js";
import { User } from "../../model/auth/auth.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { ApiError } from "../../utils/ApiError.js";

export async function createFeedback(userId, data, req = null) {
    if (!data.title || !data.title.trim()) {
        throw ApiError.badRequest("Please provide a title for your feedback or report");
    }
    if (!data.description || !data.description.trim()) {
        throw ApiError.badRequest("Please provide a description explaining the issue or suggestion");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw ApiError.unauthorized("User account not found");
    }

    let workspace = null;
    try {
        workspace = await getWorkspaceOrThrow(userId);
    } catch {
        workspace = null;
    }

    const validTypes = ["bug", "suggestion", "feedback"];
    const type = validTypes.includes(data.type) ? data.type : "feedback";

    const validPriorities = ["low", "medium", "high", "critical"];
    const priority = validPriorities.includes(data.priority) ? data.priority : "medium";

    // Clean and validate images (max 6 images)
    let images = [];
    if (Array.isArray(data.images)) {
        images = data.images
            .filter((img) => typeof img === "string" && img.trim().length > 0)
            .slice(0, 6);
    }

    const feedback = await Feedback.create({
        workspace: workspace?._id || null,
        workspaceName: workspace?.companyName || "Personal Workspace",
        user: user._id,
        userName: user.fullName || user.name || "Workspace Member",
        userEmail: user.email,
        userRole: user.systemRole || user.role || "Member",
        type,
        category: data.category?.trim() || "General",
        title: data.title.trim(),
        description: data.description.trim(),
        priority,
        images,
        pageUrl: data.pageUrl?.trim() || "",
        browserInfo: req?.headers?.["user-agent"] || "",
        status: "pending",
    });

    return feedback;
}

export async function getMyFeedbacks(userId) {
    const feedbacks = await Feedback.find({ user: userId })
        .sort({ createdAt: -1 })
        .lean();
    return feedbacks;
}

export async function listFeedbacksForSuperAdmin({ type, status, search, page = 1, limit = 50 }) {
    const filter = {};

    if (type && type !== "all") {
        filter.type = type;
    }

    if (status && status !== "all") {
        filter.status = status;
    }

    if (search && search.trim()) {
        const regex = new RegExp(search.trim(), "i");
        filter.$or = [
            { title: regex },
            { description: regex },
            { userName: regex },
            { userEmail: regex },
            { workspaceName: regex },
            { category: regex },
        ];
    }

    const skip = (page - 1) * limit;

    const [feedbacks, total, pending, inReview, resolved, dismissed, bugs, suggestions, generalFeedback] =
        await Promise.all([
            Feedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            Feedback.countDocuments(filter),
            Feedback.countDocuments({ status: "pending" }),
            Feedback.countDocuments({ status: "in_review" }),
            Feedback.countDocuments({ status: "resolved" }),
            Feedback.countDocuments({ status: "dismissed" }),
            Feedback.countDocuments({ type: "bug" }),
            Feedback.countDocuments({ type: "suggestion" }),
            Feedback.countDocuments({ type: "feedback" }),
        ]);

    const totalAll = await Feedback.countDocuments({});

    return {
        feedbacks,
        total,
        page,
        limit,
        stats: {
            totalAll,
            pending,
            inReview,
            resolved,
            dismissed,
            bugs,
            suggestions,
            generalFeedback,
        },
    };
}

export async function updateFeedbackStatus({ feedbackId, status, adminNotes, superAdminId }) {
    const validStatuses = ["pending", "in_review", "resolved", "dismissed"];
    if (!validStatuses.includes(status)) {
        throw ApiError.badRequest(`Invalid status: ${status}. Must be one of: ${validStatuses.join(", ")}`);
    }

    const feedback = await Feedback.findById(feedbackId);
    if (!feedback) {
        throw ApiError.notFound("Feedback item not found");
    }

    feedback.status = status;
    if (adminNotes !== undefined) {
        feedback.adminNotes = adminNotes;
    }

    if (status === "resolved" || status === "dismissed") {
        feedback.resolvedBy = superAdminId;
        feedback.resolvedAt = new Date();
    }

    await feedback.save();
    return feedback;
}
