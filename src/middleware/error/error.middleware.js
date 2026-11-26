import { env } from "../../config/env.js";
import { ApiError } from "../../utils/ApiError.js";
import { errorTracker } from "../../services/observability/errorTracker.service.js";
import { logger } from "../../services/observability/structuredLogger.service.js";

export const notFound = (req, res, next) => {
    next(ApiError.notFound(`Route ${req.originalUrl} not found`));
};

export const errorHandler = (err, req, res, _next) => {
    let error = err;

    if (!(error instanceof ApiError)) {
        // Mongoose duplicate key
        if (error.code === 11000) {
            const field = Object.keys(error.keyValue || {})[0] || "field";
            error = ApiError.conflict(`${field} already exists`);
        }
        // Mongoose validation
        else if (error.name === "ValidationError") {
            const errors = Object.values(error.errors).map((e) => ({
                field: e.path,
                message: e.message,
            }));
            error = ApiError.badRequest("Validation failed", errors);
        }
        // JWT
        else if (error.name === "JsonWebTokenError") {
            error = ApiError.unauthorized("Invalid token");
        } else if (error.name === "TokenExpiredError") {
            error = ApiError.unauthorized("Token expired");
        } else {
            error = ApiError.internal(
                env.isProd ? "Something went wrong" : error.message
            );
        }
    }

    // Proprietary Error Tracking: Record the error internally for Super Admin
    try {
        errorTracker.trackError(err, req, {
            originalErrorName: err.name,
            originalErrorMessage: err.message,
            statusCode: error.statusCode || 500,
        });
        logger.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err.message}`, {
            requestId: req.id,
            statusCode: error.statusCode || 500,
            endpoint: req.originalUrl,
            errorName: err.name,
            stack: err.stack,
        });
    } catch {
        // Observability failure must never prevent customer error response
    }

    const body = {
        success: false,
        message: error.message,
        ...(error.errors?.length ? { errors: error.errors } : {}),
        ...(env.isProd ? {} : { stack: err.stack }),
    };

    res.status(error.statusCode || 500).json(body);
};
