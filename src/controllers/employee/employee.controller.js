import crypto from "node:crypto";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { EmployeeActivity } from "../../model/employee/activity.model.js";
import { nextEmployeeId } from "../../services/employee/employee.service.js";
import {
    createEmployee,
    listEmployees,
    deleteEmployee,
    getEmployeeById,
    addDocumentsToEmployee,
    updateEmployee,
} from "../../services/employee/employee.service.js";

export const createEmployeeController = asyncHandler(async (req, res) => {
    if (!req.files || !Array.isArray(req.files)) {
        req.files = [];
    }

    // IMPORTANT: the multipart body has already been parsed by the
    // `parseMultipartBody` middleware on the route. `req.body` here is
    // a plain object with the wizard fields flattened, and
    // `req.body.fileMeta` is already a real array.
    //
    // DO NOT re-parse `data` or `fileMeta` here — that would fail
    // because `data` no longer exists on `req.body`.

    const { fileMeta = [], ...employeeData } = req.body;

    if (!Array.isArray(fileMeta)) {
        throw ApiError.badRequest("`fileMeta` must be an array");
    }

    if (fileMeta.length !== req.files.length) {
        throw ApiError.badRequest(
            `\`fileMeta\` length (${fileMeta.length}) must match the number of uploaded files (${req.files.length})`
        );
    }

    // Attach metadata to each uploaded file
    const files = req.files.map((f, i) => ({
        buffer: f.buffer,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        fileId: fileMeta[i]?.fileId || crypto.randomUUID(),
        type: fileMeta[i]?.type,
        label: fileMeta[i]?.label,
    }));

    const employee = await createEmployee(req.userId, employeeData, files);

    return res
        .status(201)
        .json(
            new ApiResponse(
                201,
                { employee: employee.toSafeJSON() },
                "Employee created"
            )
        );
});

export const listEmployeesController = asyncHandler(async (req, res) => {
    const employees = await listEmployees(req.userId);
    return res
        .status(200)
        .json(new ApiResponse(200, { employees }, "Employees loaded"));
});

export const deleteEmployeeController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await deleteEmployee(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, null, "Employee deleted"));
});

export const getEmployeeController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const employee = await getEmployeeById(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, { employee: employee.toSafeJSON() }, "Employee loaded"));
});

/**
 * POST /employees/:id/documents  (multipart/form-data)
 * Fields:
 *   - files: one or more file inputs (name="files")
 *   - fileMeta: JSON array of { fileId, type, label } matched by index
 *
 * Requires requireAuth.
 */
export const addDocumentsController = asyncHandler(async (req, res) => {
    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
        throw ApiError.badRequest("No files provided");
    }

    // `fileMeta` was parsed by parseMultipartBody middleware into a real array
    // at req.body.fileMeta. But for this route we don't need the wizard's
    // `data` field, so we only look at `fileMeta`.
    const fileMeta = Array.isArray(req.body?.fileMeta) ? req.body.fileMeta : [];

    if (fileMeta.length !== req.files.length) {
        throw ApiError.badRequest(
            `\`fileMeta\` length (${fileMeta.length}) must match number of files (${req.files.length})`
        );
    }

    const files = req.files.map((f, i) => ({
        buffer: f.buffer,
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        fileId: fileMeta[i]?.fileId || crypto.randomUUID(),
        type: fileMeta[i]?.type,
        label: fileMeta[i]?.label,
    }));

    const { id } = req.params;
    const { employee, addedCount } = await addDocumentsToEmployee(req.userId, id, files);

    return res
        .status(201)
        .json(
            new ApiResponse(
                201,
                { employee: employee.toSafeJSON(), addedCount },
                `${addedCount} document(s) uploaded`
            )
        );
});

export const updateEmployeeController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { employee, removedDocumentCount } = await updateEmployee(
        req.userId,
        id,
        req.body
    );

    return res.status(200).json(
        new ApiResponse(
            200,
            { employee: employee.toSafeJSON(), removedDocumentCount },
            "Employee updated"
        )
    );
});

export const getEmployeeActivityController = asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Use the existing service to resolve the employee ID (handles Mongo ID or EMP-00125)
    const employee = await getEmployeeById(req.userId, id);

    const activities = await EmployeeActivity.find({ employee: employee._id })
        .populate("actor", "fullName")
        .sort({ createdAt: -1 })
        .limit(50) // Limit to last 50 events
        .lean();

    const result = activities.map((a) => ({
        id: a._id.toString(),
        type: a.type,
        label: a.label,
        actorName: a.actor?.fullName || "System",
        at: a.createdAt.toISOString(),
    }));

    return res.status(200).json(new ApiResponse(200, { activities: result }, "Activity loaded"));
});

export const getNextEmployeeIdController = asyncHandler(async (req, res) => {
    // Resolve the workspace for this user
    const workspace = await getWorkspaceOrThrow(req.userId);

    // Generate the next available ID
    const nextId = await nextEmployeeId(workspace._id);

    return res.status(200).json(new ApiResponse(200, { employeeId: nextId }, "Next ID generated"));
});