// src/model/payroll/salaryStructure.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const salaryStructureSchema = new Schema(
    {
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            maxlength: 30,
        },
        gradeLevel: {
            type: String,
            trim: true,
            default: "Standard",
        },
        description: {
            type: String,
            trim: true,
            default: "",
        },
        components: [
            {
                type: Schema.Types.ObjectId,
                ref: "SalaryComponent",
            },
        ],
        baseSalaryRange: {
            min: { type: Number, default: 0 },
            max: { type: Number, default: 0 },
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: true }
);

salaryStructureSchema.index({ workspace: 1, code: 1 }, { unique: true });

export const SalaryStructure = model("SalaryStructure", salaryStructureSchema);
