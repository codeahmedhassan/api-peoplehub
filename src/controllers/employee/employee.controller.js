import crypto from "node:crypto";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { createEmployee, listEmployees, deleteEmployee } from "../../services/employee/employee.service.js";

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