import { Router } from "express";
import {
    createEmployeeController,
    listEmployeesController,
    deleteEmployeeController,
    getEmployeeController,
    addDisciplinaryRecordController,
    downloadEmployeeDocumentController,
    deleteEmployeeDocumentController,
    updateVettingCheckController,
    addDocumentsController,
    updateEmployeeController,
    getEmployeeActivityController,
    getNextEmployeeIdController,
    uploadDraftDocumentController,
    deleteDraftDocumentController,
    listCorrectionRequestsController,
    approveCorrectionRequestController,
    rejectCorrectionRequestController,
    requestPromotionController,
    requestDocumentDeletionController,
    requestEmployeeDeletionController,
    requestAttendanceUpdateController,
    bulkImportEmployeesController,
    exportEmployeesController,
    getWorkspaceManagersController,
    replaceManagerController,
    bulkAssignManagerController,
    createEmployeeLoginAccountController,
    resendEmployeeInvitationController,
    updateEmployeePermissionsController,
} from "../../controllers/employee/employee.controller.js";
import { requireAuth, requirePermission } from "../../middleware/auth/auth.middleware.js";
import { uploadEmployeeFiles, uploadBulkImportFile } from "../../middleware/upload/multer.middleware.js";
import { employeeCreateLimiter } from "../../middleware/rateLimit/rateLimit.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import {
    createEmployeeSchema,
    updateEmployeeSchema,
} from "../../validators/employee/employee.validator.js";
import { ApiError } from "../../utils/ApiError.js";

const router = Router();

/**
 * After Multer runs, `req.body` is a flat object where every non-file
 * multipart part is a string (or Buffer, depending on charset).
 * The frontend sends two special fields:
 *   - `data`:      JSON string of the wizard payload
 *   - `fileMeta`:  JSON string of an array of per-file metadata
 */
function parseMultipartBody(req, _res, next) {
    try {
        // ---- parse `data` ----
        let rawData = req.body?.data;
        if (Buffer.isBuffer(rawData)) rawData = rawData.toString("utf8");
        rawData = String(rawData ?? "{}").trim();

        let parsed;
        try {
            parsed = JSON.parse(rawData);
        } catch {
            try {
                parsed = JSON.parse(Buffer.from(rawData, "latin1").toString("utf8"));
            } catch {
                return next(ApiError.badRequest("Invalid JSON in `data` field"));
            }
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return next(ApiError.badRequest("Invalid JSON in `data` field"));
        }

        // ---- parse `fileMeta` ----
        let fileMeta = [];
        let rawMeta = req.body?.fileMeta;
        if (Buffer.isBuffer(rawMeta)) rawMeta = rawMeta.toString("utf8");

        if (rawMeta !== undefined && rawMeta !== null && rawMeta !== "") {
            if (Array.isArray(rawMeta)) {
                fileMeta = rawMeta;
            } else if (typeof rawMeta === "object") {
                fileMeta = [rawMeta];
            } else {
                const asString = String(rawMeta).trim();
                try {
                    fileMeta = JSON.parse(asString);
                } catch {
                    try {
                        fileMeta = JSON.parse(Buffer.from(asString, "latin1").toString("utf8"));
                    } catch {
                        return next(
                            ApiError.badRequest(
                                `Invalid JSON in \`fileMeta\` field. Received: ${asString.slice(0, 120)}`
                            )
                        );
                    }
                }
            }
            if (!Array.isArray(fileMeta)) {
                return next(
                    ApiError.badRequest(
                        `\`fileMeta\` must be a JSON array. Received: ${typeof fileMeta}`
                    )
                );
            }
        }

        // ---- build the final body the controller will see ----
        req.body = { ...parsed, fileMeta };

        next();
    } catch (err) {
        next(err);
    }
}

router.post(
    "/",
    requireAuth,
    requirePermission("employees", "create"),
    employeeCreateLimiter,
    uploadEmployeeFiles,
    parseMultipartBody,
    validate(createEmployeeSchema),
    createEmployeeController
);

router.get("/", requireAuth, requirePermission("employees", "view"), listEmployeesController);

// ⚠️ IMPORTANT: These must be defined BEFORE `/:id` so Express 
// doesn't treat them as an employee ID.
router.get("/next-id", requireAuth, getNextEmployeeIdController);
router.get("/managers", requireAuth, getWorkspaceManagersController);
router.get("/export", requireAuth, requirePermission("employees", "view"), exportEmployeesController);
router.post("/managers/replace", requireAuth, replaceManagerController);
router.post("/managers/assign", requireAuth, bulkAssignManagerController);
router.post("/bulk-import", requireAuth, uploadBulkImportFile, bulkImportEmployeesController);
router.get("/correction-requests", requireAuth, listCorrectionRequestsController);
router.post("/correction-requests/:requestId/approve", requireAuth, approveCorrectionRequestController);
router.post("/correction-requests/:requestId/reject", requireAuth, rejectCorrectionRequestController);

router.post(
    "/draft-documents",
    requireAuth,
    employeeCreateLimiter,
    uploadEmployeeFiles,
    parseMultipartBody,
    uploadDraftDocumentController
);

router.delete(
    "/draft-documents/:fileId",
    requireAuth,
    deleteDraftDocumentController
);

router.get("/:id", requireAuth, requirePermission("employees", "view"), getEmployeeController);

// PATCH — partial update, JSON only
router.patch(
    "/:id",
    requireAuth,
    requirePermission("employees", "edit"),
    validate(updateEmployeeSchema),
    updateEmployeeController
);

router.delete("/:id", requireAuth, requirePermission("employees", "delete"), deleteEmployeeController);

router.post("/:id/disciplinary-records", requireAuth, addDisciplinaryRecordController);

router.get("/:id/documents/:fileId/download", requireAuth, downloadEmployeeDocumentController);
router.delete("/:id/documents/:fileId", requireAuth, deleteEmployeeDocumentController);
router.patch("/:id/vetting", requireAuth, updateVettingCheckController);
router.post("/:id/create-login", requireAuth, requirePermission("employees", "manageAccess"), createEmployeeLoginAccountController);
router.post("/:id/resend-invite", requireAuth, requirePermission("employees", "manageAccess"), resendEmployeeInvitationController);
router.patch("/:id/permissions", requireAuth, requirePermission("employees", "manageAccess"), updateEmployeePermissionsController);
router.post("/:id/request-promotion", requireAuth, requestPromotionController);
router.post("/:id/documents/:fileId/request-deletion", requireAuth, requestDocumentDeletionController);
router.post("/:id/request-deletion", requireAuth, requestEmployeeDeletionController);
router.post("/:id/request-attendance-update", requireAuth, requestAttendanceUpdateController);

router.post(
    "/:id/documents",
    requireAuth,
    employeeCreateLimiter,
    uploadEmployeeFiles,
    parseMultipartBody,
    addDocumentsController
);

router.get("/:id/activity", requireAuth, getEmployeeActivityController);

export default router;