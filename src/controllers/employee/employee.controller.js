import crypto from "node:crypto";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { ApiError } from "../../utils/ApiError.js";
import { EmployeeActivity } from "../../model/employee/activity.model.js";
import { nextEmployeeId } from "../../services/employee/employee.service.js";
import { getWorkspaceOrThrow } from "../../services/workspace/workspace.service.js";
import { eventEngine } from "../../services/observability/eventEngine.service.js";
import {
    createEmployee,
    listEmployees,
    deleteEmployee,
    getEmployeeById,
    getEmployeeDetailBundle,
    addDisciplinaryRecord,
    downloadEmployeeDocument,
    deleteEmployeeDocument,
    updateVettingCheck,
    addDocumentsToEmployee,
    updateEmployee,
    listCorrectionRequests,
    approveCorrectionRequest,
    rejectCorrectionRequest,
    requestEmployeePromotion,
    requestDocumentDeletion,
    requestEmployeeDeletion,
    requestAttendanceUpdate,
    bulkImportEmployees,
    exportEmployees,
    getWorkspaceManagers,
    replaceManager,
    bulkAssignManager,
    createEmployeeLoginAccount,
    resendEmployeeInvitation,
    updateEmployeePermissions,
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

    if (employee) {
        eventEngine.trackEvent({
            eventName: "employee_created",
            module: "employee",
            feature: "create_profile",
            organizationId: employee.workspace,
            userId: req.userId,
            requestId: req.id,
            properties: {
                department: employee.jobDetails?.department,
                designation: employee.jobDetails?.designation,
            },
        });
    }

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

    eventEngine.trackEvent({
        eventName: "employee_deactivated",
        module: "employee",
        feature: "delete_employee",
        organizationId: req.user?.activeWorkspace || req.workspace?._id,
        userId: req.userId,
        requestId: req.id,
    });

    return res
        .status(200)
        .json(new ApiResponse(200, null, "Employee deleted"));
});

export const getEmployeeController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const employee = await getEmployeeDetailBundle(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, { employee }, "Employee loaded"));
});

export const addDisciplinaryRecordController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await addDisciplinaryRecord(req.userId, id, req.body);
    const employee = await getEmployeeDetailBundle(req.userId, id);
    return res
        .status(201)
        .json(new ApiResponse(201, { employee }, "Disciplinary record added successfully"));
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

export const downloadEmployeeDocumentController = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    const { inline } = req.query;
    const { buffer, fileName, mimeType } = await downloadEmployeeDocument(req.userId, id, fileId);

    const disposition = inline === "true" ? "inline" : "attachment";
    res.setHeader("Content-Type", mimeType || "application/octet-stream");
    res.setHeader(
        "Content-Disposition",
        `${disposition}; filename="${encodeURIComponent(fileName)}"`
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Length", buffer.length);
    return res.end(buffer);
});

export const deleteEmployeeDocumentController = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    await deleteEmployeeDocument(req.userId, id, fileId);
    const employee = await getEmployeeDetailBundle(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, { employee }, "Document deleted successfully"));
});

export const updateVettingCheckController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    await updateVettingCheck(req.userId, id, req.body);
    const employee = await getEmployeeDetailBundle(req.userId, id);
    return res
        .status(200)
        .json(new ApiResponse(200, { employee }, "Vetting check updated successfully"));
});

export const updateEmployeeController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await updateEmployee(
        req.userId,
        id,
        req.body
    );

    if (result.isCorrectionRequest) {
        return res.status(200).json(
            new ApiResponse(
                200,
                {
                    isCorrectionRequest: true,
                    correctionRequestId: result.correctionRequestId,
                    employee: result.employee?.toSafeJSON ? result.employee.toSafeJSON() : result.employee,
                },
                result.message || "Correction request submitted to HR for approval"
            )
        );
    }

    return res.status(200).json(
        new ApiResponse(
            200,
            { employee: result.employee.toSafeJSON(), removedDocumentCount: result.removedDocumentCount },
            "Employee updated"
        )
    );
});

export const listCorrectionRequestsController = asyncHandler(async (req, res) => {
    const requests = await listCorrectionRequests(req.userId, {
        status: req.query.status,
    });
    return res.status(200).json(new ApiResponse(200, { requests }, "Correction requests loaded"));
});

export const approveCorrectionRequestController = asyncHandler(async (req, res) => {
    const { requestId } = req.params;
    const { selectedFields } = req.body || {};
    const result = await approveCorrectionRequest(req.userId, requestId, { selectedFields });
    return res.status(200).json(new ApiResponse(200, result, "Correction request approved and applied"));
});

export const rejectCorrectionRequestController = asyncHandler(async (req, res) => {
    const { requestId } = req.params;
    const { reason } = req.body || {};
    const result = await rejectCorrectionRequest(req.userId, requestId, reason);
    return res.status(200).json(new ApiResponse(200, result, "Correction request rejected"));
});

export const requestPromotionController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await requestEmployeePromotion(req.userId, id, req.body || {});
    return res.status(201).json(new ApiResponse(201, result, "Promotion and increment request submitted to HR"));
});

export const requestDocumentDeletionController = asyncHandler(async (req, res) => {
    const { id, fileId } = req.params;
    const { reason } = req.body || {};
    const result = await requestDocumentDeletion(req.userId, id, fileId, reason);
    return res.status(201).json(new ApiResponse(201, result, "Document deletion request submitted to HR"));
});

export const requestEmployeeDeletionController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await requestEmployeeDeletion(req.userId, id, req.body || {});
    return res.status(201).json(new ApiResponse(201, result, "Employee deletion request submitted to HR"));
});

export const requestAttendanceUpdateController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await requestAttendanceUpdate(req.userId, id, req.body || {});
    return res.status(201).json(new ApiResponse(201, result, "Attendance update request submitted to HR"));
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

    const result = activities.map((a) => {
        let atStr = null;
        if (a.createdAt instanceof Date) {
            atStr = a.createdAt.toISOString();
        } else if (a.createdAt) {
            const d = new Date(a.createdAt);
            atStr = isNaN(d.getTime()) ? String(a.createdAt) : d.toISOString();
        } else {
            atStr = new Date().toISOString();
        }
        return {
            id: a._id.toString(),
            type: a.type,
            label: a.label,
            actorName: a.actor?.fullName || "System",
            at: atStr,
        };
    });

    return res.status(200).json(new ApiResponse(200, { activities: result }, "Activity loaded"));
});

export const getNextEmployeeIdController = asyncHandler(async (req, res) => {
    // Resolve the workspace for this user
    const workspace = await getWorkspaceOrThrow(req.userId);

    // Generate the next available ID
    const commit = req.query.commit === "true";
    const nextId = await nextEmployeeId(workspace._id, {
        commit,
        department: req.query.department,
        branch: req.query.branch || req.query.workLocation,
        workLocation: req.query.workLocation || req.query.branch,
        joiningDate: req.query.joiningDate,
    });

    return res.status(200).json(new ApiResponse(200, { employeeId: nextId }, "Next ID generated"));
});
export const uploadDraftDocumentController = asyncHandler(async (req, res) => {
    const { getWorkspaceOrThrow } = await import("../../services/workspace/workspace.service.js");
    const { encryptFile } = await import("../../services/storage/document-crypto.service.js");
    const { uploadEncryptedBlob, deleteEncryptedBlob, getEmployeeAttachmentPath } = await import("../../services/storage/s3.service.js");

    const workspace = await getWorkspaceOrThrow(req.userId);
    const files = req.files || [];
    if (files.length === 0) {
        throw ApiError.badRequest("No file uploaded");
    }

    const { fileMeta = [] } = req.body;
    const uploadedDocs = [];

    try {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            const meta = fileMeta[i] || {};
            const fileId = meta.fileId || crypto.randomUUID();
            const type = meta.type || "Other";
            const label = meta.label || f.originalname;

            const { ciphertext, iv, authTag, wrappedDek, kekVersion } =
                encryptFile(f.buffer, {
                    employeeId: `draft-${workspace._id}`,
                    fileId,
                });

            // Canonical tree: employees/{employeeId}/attachments/{filename}
            const s3Key = getEmployeeAttachmentPath(`draft-${workspace._id}`, `${fileId}.enc`);
            await uploadEncryptedBlob(s3Key, ciphertext);

            uploadedDocs.push({
                fileId,
                type,
                label,
                fileName: f.originalname,
                fileSize: f.size,
                mimeType: f.mimetype,
                s3Key,
                iv,
                authTag,
                wrappedDek,
                kekVersion,
            });
        }
    } catch (err) {
        for (const doc of uploadedDocs) {
            try {
                await deleteEncryptedBlob(doc.s3Key);
            } catch {}
        }
        throw err;
    }

    return res.status(201).json(new ApiResponse(201, { documents: uploadedDocs }, "Draft document(s) uploaded to S3"));
});

export const deleteDraftDocumentController = asyncHandler(async (req, res) => {
    const { getWorkspaceOrThrow } = await import("../../services/workspace/workspace.service.js");
    const { deleteEncryptedBlob, getEmployeeAttachmentPath } = await import("../../services/storage/s3.service.js");

    const workspace = await getWorkspaceOrThrow(req.userId);
    const { fileId } = req.params;

    if (!fileId) {
        throw ApiError.badRequest("fileId is required");
    }

    const s3Key = getEmployeeAttachmentPath(`draft-${workspace._id}`, `${fileId}.enc`);
    try {
        await deleteEncryptedBlob(s3Key);
    } catch (err) {
        // Also attempt legacy path if present
        try {
            await deleteEncryptedBlob(`employees/${workspace._id}/drafts/${fileId}.enc`);
        } catch {
            console.warn(`[deleteDraftDocument] S3 deletion warning: ${err.message}`);
        }
    }

    return res.status(200).json(new ApiResponse(200, { fileId }, "Draft document deleted from S3"));
});

export const bulkImportEmployeesController = asyncHandler(async (req, res) => {
    let fileBuffer = req.file?.buffer;
    let fileMime = req.file?.mimetype;
    let fileName = req.file?.originalname;
    let rawRecords = req.body?.records;

    if (typeof rawRecords === "string") {
        try {
            rawRecords = JSON.parse(rawRecords);
        } catch {}
    }

    const result = await bulkImportEmployees(req.userId, {
        fileBuffer,
        fileMime,
        fileName,
        rawRecords,
    });

    return res.status(200).json(new ApiResponse(200, result, "Employees bulk import processed successfully"));
});

export const exportEmployeesController = asyncHandler(async (req, res) => {
    const { format, department, branch, status, q } = req.query;
    const { buffer, contentType, filename } = await exportEmployees(req.userId, {
        format,
        department,
        branch,
        status,
        q,
    });
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(buffer);
});

export const getWorkspaceManagersController = asyncHandler(async (req, res) => {
    const result = await getWorkspaceManagers(req.userId);
    return res.status(200).json(new ApiResponse(200, result, "Workspace managers retrieved successfully"));
});

export const replaceManagerController = asyncHandler(async (req, res) => {
    const { currentManagerId, newManagerId, newManagerName, employeeIds, reason } = req.body;
    const result = await replaceManager(req.userId, {
        currentManagerId,
        newManagerId,
        newManagerName,
        employeeIds,
        reason,
    });
    return res.status(200).json(new ApiResponse(200, result, "Manager replacement completed successfully"));
});

export const bulkAssignManagerController = asyncHandler(async (req, res) => {
    const { employeeIds, managerId, managerName } = req.body;
    const result = await bulkAssignManager(req.userId, {
        employeeIds,
        managerId,
        managerName,
    });
    return res.status(200).json(new ApiResponse(200, result, "Manager assigned successfully"));
});

export const createEmployeeLoginAccountController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await createEmployeeLoginAccount(req.userId, id, req.body);
    return res.status(201).json(new ApiResponse(201, result, result.message));
});

export const resendEmployeeInvitationController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await resendEmployeeInvitation(req.userId, id);
    return res.status(200).json(new ApiResponse(200, result, result.message));
});

export const updateEmployeePermissionsController = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await updateEmployeePermissions(req.userId, id, req.body);
    return res.status(200).json(new ApiResponse(200, result, result.message));
});
