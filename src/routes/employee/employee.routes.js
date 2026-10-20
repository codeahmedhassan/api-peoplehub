import { Router } from "express";
import {
    createEmployeeController,
    listEmployeesController,
    deleteEmployeeController,
} from "../../controllers/employee/employee.controller.js";
import { requireAuth } from "../../middleware/auth/auth.middleware.js";
import { uploadEmployeeFiles } from "../../middleware/upload/multer.middleware.js";
import { employeeCreateLimiter } from "../../middleware/rateLimit/rateLimit.middleware.js";
import { validate } from "../../middleware/validate/validate.middleware.js";
import { createEmployeeSchema } from "../../validators/employee/employee.validator.js";
import { ApiError } from "../../utils/ApiError.js";

const router = Router();

/**
 * After Multer runs, `req.body` is a flat object where every non-file
 * multipart part is a string (or Buffer, depending on charset).
 * The frontend sends two special fields:
 *   - `data`:      JSON string of the wizard payload
 *   - `fileMeta`:  JSON string of an array of per-file metadata
 *
 * This middleware:
 *   1. Parses both into JavaScript values.
 *   2. Replaces `req.body` with the parsed `data` object.
 *   3. Attaches the parsed `fileMeta` array at `req.body.fileMeta`
 *      so the Joi validator can check it AND the controller can use it.
 *
 * This is the ONLY place these two fields are parsed. The controller
 * MUST NOT re-parse them.
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
        // `data` fields flat, `fileMeta` as an array.
        req.body = { ...parsed, fileMeta };

        next();
    } catch (err) {
        next(err);
    }
}

router.post(
    "/",
    requireAuth,
    employeeCreateLimiter,
    uploadEmployeeFiles,
    parseMultipartBody,
    validate(createEmployeeSchema),
    createEmployeeController
);

router.get("/", requireAuth, listEmployeesController);
router.delete("/:id", requireAuth, deleteEmployeeController);

export default router;