import { env } from "../../config/env.js";
import { ApiError } from "../../utils/ApiError.js";

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

    const body = {
        success: false,
        message: error.message,
        ...(error.errors?.length ? { errors: error.errors } : {}),
        ...(env.isProd ? {} : { stack: err.stack }),
    };

    res.status(error.statusCode || 500).json(body);
};