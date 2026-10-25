import Joi from "joi";

export const createDeviceSchema = Joi.object({
    name: Joi.string().trim().min(2).max(100).required(),
    location: Joi.string().trim().max(100).allow("").default(""),
});

export const saveLinkSchema = Joi.object({
    employeeMongoId: Joi.string().trim().required(),
    deviceUserId: Joi.string().trim().allow("").default(""),
});