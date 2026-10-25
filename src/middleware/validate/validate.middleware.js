import { ApiError } from "../../utils/ApiError.js";

export const validate = (schema) => (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
    });

    if (error) {
        const errors = error.details.map((d) => ({
            field: d.path.join("."),
            message: d.message,
        }));
        return next(ApiError.badRequest("Validation failed", errors));
    }

    req.body = value;
    next();
};

/**
 * Validates `req.query`. Because Express gives us strings for everything
 * in the query, schemas for query validation should coerce where needed.
 * The validated value is written back to `req.query`, so coercions
 * (numbers, dates, etc.) are available in the controller.
 */
export const validateQuery = (schema) => (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });

    if (error) {
        const errors = error.details.map((d) => ({
            field: d.path.join("."),
            message: d.message,
        }));
        return next(ApiError.badRequest("Validation failed", errors));
    }

    // In Express 5, req.query is read-only. In Express 4 it's writable.
    // To be compatible with both, we assign the validated object to a
    // separate property that controllers use.
    req.validatedQuery = value;
    next();
};