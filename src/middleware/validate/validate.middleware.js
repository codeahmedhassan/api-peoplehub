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