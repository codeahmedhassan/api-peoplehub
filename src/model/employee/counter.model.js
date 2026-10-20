// src/model/employee/counter.model.js
import mongoose from "mongoose";

const { Schema, model } = mongoose;

const counterSchema = new Schema(
    {
        // Scope: one counter per workspace
        workspace: {
            type: Schema.Types.ObjectId,
            ref: "Workspace",
            required: true,
            unique: true,
            index: true,
        },
        sequence: {
            type: Number,
            required: true,
            default: 0,
        },
    },
    { timestamps: true }
);

export const EmployeeCounter = model("EmployeeCounter", counterSchema);