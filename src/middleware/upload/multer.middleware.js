// src/middleware/upload/multer.middleware.js
import multer from "multer";
import path from "node:path";
import {
    ALLOWED_MIME_TYPES,
    ALLOWED_EXTENSIONS,
    MAX_FILE_SIZE_BYTES,
    MAX_FILES_PER_EMPLOYEE,
} from "../../constants/employee.js";
import { ApiError } from "../../utils/ApiError.js";

// In-memory storage: nothing hits disk unencrypted.
const storage = multer.memoryStorage();

function fileFilter(_req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return cb(ApiError.badRequest(`Unsupported file type: ${file.mimetype}`));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
        return cb(ApiError.badRequest(`Unsupported file extension: ${ext}`));
    }
    cb(null, true);
}

export const uploadEmployeeFiles = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES,
        files: MAX_FILES_PER_EMPLOYEE,
        fields: 50,
        parts: 60,
    },
}).array("files", MAX_FILES_PER_EMPLOYEE);