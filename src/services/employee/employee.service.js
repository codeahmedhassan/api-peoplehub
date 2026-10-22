// src/services/employee/employee.service.js
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Employee } from "../../model/employee/employee.model.js";
import { EmployeeCounter } from "../../model/employee/counter.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { encryptFile } from "../storage/document-crypto.service.js";
import { uploadEncryptedBlob } from "../storage/s3.service.js";
import {
    EMPLOYEE_ID_PREFIX,
    EMPLOYEE_ID_START,
    EMPLOYEE_ID_PAD,
    MAX_FILES_PER_EMPLOYEE,
} from "../../constants/employee.js";

async function getOwnedWorkspace(userId) {
    const ws = await Workspace.findOne({ owner: userId });
    if (!ws) {
        throw ApiError.forbidden(
            "You don't have a workspace yet. Complete workspace setup first."
        );
    }
    return ws;
}

/**
 * Resolve an employee by either its Mongo _id or its human employeeId
 * ("EMP-00125"). Scoped to the caller's workspace.
 */
async function findEmployeeForUser(userId, idOrEmployeeId) {
    const workspace = await getOwnedWorkspace(userId);

    const baseFilter = { workspace: workspace._id };
    const filter = mongoose.isValidObjectId(idOrEmployeeId)
        ? { ...baseFilter, _id: idOrEmployeeId }
        : { ...baseFilter, employeeId: idOrEmployeeId };

    const employee = await Employee.findOne(filter);
    if (!employee) throw ApiError.notFound("Employee not found");
    return employee;
}

export async function getEmployeeById(userId, idOrEmployeeId) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    return employee;
}

async function nextEmployeeId(workspaceId) {
    const counter = await EmployeeCounter.findOneAndUpdate(
        { workspace: workspaceId },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    const seq = EMPLOYEE_ID_START + counter.sequence - 1;
    return `${EMPLOYEE_ID_PREFIX}-${String(seq).padStart(EMPLOYEE_ID_PAD, "0")}`;
}

function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Create an employee.
 *
 * @param {string} userId       - authenticated user id
 * @param {object} body         - wizard payload (already Joi-validated)
 * @param {Array<{originalname, mimetype, size, buffer, fileId, type, label}>} files
 *                                - already validated files, with fileId + type + label
 * @returns {Promise<object>}   - saved Employee document
 */
export async function createEmployee(userId, body, files = []) {
    const workspace = await getOwnedWorkspace(userId);

    // -------------------------------------------------------------------
    // Auto-generate employee ID
    // -------------------------------------------------------------------
    const employeeId = await nextEmployeeId(workspace._id);

    // -------------------------------------------------------------------
    // If a login is requested, provision a User with status "invited"
    // -------------------------------------------------------------------
    let linkedUser = null;
    if (body.createLogin && body.loginEmail) {
        const existing = await User.findOne({ email: body.loginEmail });
        if (existing) {
            throw ApiError.conflict(
                `A user with email ${body.loginEmail} already exists. Choose a different login email.`
            );
        }
        // "invited" status means: can't log in until the invite flow exists.
        // password is set to an unusable random bcrypt hash — no login possible.
        linkedUser = await User.create({
            fullName: `${body.firstName} ${body.lastName}`.trim(),
            email: body.loginEmail,
            password: "!" + crypto.randomBytes(32).toString("hex"), // bcrypt-incompatible placeholder
            company: workspace.companyName,
            companySize: "1-10", // best-effort — this field isn't used for employee accounts
            role: "Other",
            status: "pending",      // pending until invite activation
            emailVerified: false,
            setupCompletedAt: null,
        });
    }

    // -------------------------------------------------------------------
    // Create the employee document in the DB first so we have an _id
    // to use in the AAD binding and S3 key path.
    // -------------------------------------------------------------------
    const employee = new Employee({
        workspace: workspace._id,
        employeeId,

        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        preferredName: body.preferredName || "",
        gender: body.gender || "",
        avatar: body.avatar || "",
        manuallyPickedAvatar: Boolean(body.manuallyPickedAvatar),

        employmentStatus: body.employmentStatus,
        employmentType: body.employmentType,
        designation: body.designation || "",
        department: body.department,
        reportingManager: body.reportingManager || "",
        joiningDate: parseDate(body.joiningDate) || new Date(),
        workLocation: body.workLocation || "",
        workArrangement: body.workArrangement || "",
        probationEndDate: parseDate(body.probationEndDate),
        contractEndDate: parseDate(body.contractEndDate),
        employeeCategory: body.employeeCategory || "",

        personalEmail: body.personalEmail || "",
        dateOfBirth: parseDate(body.dateOfBirth),
        residentialAddress: body.residentialAddress || "",
        city: body.city || "",
        country: body.country || "",
        emergencyName: body.emergencyName || "",
        emergencyRelation: body.emergencyRelation || "",
        emergencyPhone: body.emergencyPhone || "",

        workSchedule: body.workSchedule || "",
        weeklyWorkingDays: body.weeklyWorkingDays || "",
        attendanceLocation: body.attendanceLocation || "",
        attendanceMethod: body.attendanceMethod || "",
        attendanceEligibility: body.attendanceEligibility || "Eligible",
        overtimeEligibility: Boolean(body.overtimeEligibility),
        timeZone: body.timeZone || "",

        salaryAmount: Number(body.salaryAmount),
        salaryCurrency: body.salaryCurrency,
        payFrequency: body.payFrequency,
        bankAccountName: body.bankAccountName || "",
        bankAccountNumber: body.bankAccountNumber || "",
        bankName: body.bankName || "",
        taxIdentifier: body.taxIdentifier || "",
        payrollGroup: body.payrollGroup || "",

        nationalId: body.nationalId || "",
        documents: [],

        createLogin: Boolean(body.createLogin),
        loginEmail: body.loginEmail || "",
        systemRole: body.systemRole || "Employee",
        sendInvitation: Boolean(body.sendInvitation),
        linkedUser: linkedUser ? linkedUser._id : null,
    });

    const savedEmployee = await employee.save();

    // -------------------------------------------------------------------
    // Encrypt + upload each file, then attach metadata to the employee.
    // -------------------------------------------------------------------
    if (files.length > 0) {
        const uploadedMeta = [];
        try {
            for (const f of files) {
                const { ciphertext, iv, authTag, wrappedDek, kekVersion } =
                    encryptFile(f.buffer, {
                        employeeId: savedEmployee._id.toString(),
                        fileId: f.fileId,
                    });

                const s3Key = `employees/${workspace._id}/${savedEmployee._id}/${f.fileId}.enc`;
                await uploadEncryptedBlob(s3Key, ciphertext);

                uploadedMeta.push({
                    fileId: f.fileId,
                    type: f.type,
                    label: f.label,
                    fileName: f.originalname,
                    fileSize: f.size, // plaintext size
                    mimeType: f.mimetype,
                    s3Key,
                    iv,
                    authTag,
                    wrappedDek,
                    kekVersion,
                    uploadedBy: userId,
                });
            }

            savedEmployee.documents = uploadedMeta;
            await savedEmployee.save();
        } catch (err) {
            // Roll back any partial S3 uploads
            const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
            for (const m of uploadedMeta) {
                try {
                    await deleteEncryptedBlob(m.s3Key);
                } catch {
                    /* best-effort */
                }
            }
            // Roll back employee + linked user
            await Employee.deleteOne({ _id: savedEmployee._id });
            if (linkedUser) await User.deleteOne({ _id: linkedUser._id });
            throw err;
        }
    }

    return savedEmployee;
}

export async function listEmployees(userId) {
    const workspace = await getOwnedWorkspace(userId);
    const employees = await Employee.find({ workspace: workspace._id })
        .sort({ createdAt: -1 })
        .lean();
    return employees.map((e) => {
        const { documents, bankAccountNumber, taxIdentifier, ...rest } = e;
        return {
            ...rest,
            id: e._id,
            documentCount: documents?.length ?? 0,
        };
    });
}

/**
 * Change: deleteEmployee now accepts either a Mongo _id or an employeeId
 * ("EMP-00125"). Signature is unchanged — the id is just more flexible now.
 *
 * OVERWRITE the existing `deleteEmployee` function with this version.
 */
export async function deleteEmployee(userId, idOrEmployeeId) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    // Delete every encrypted blob from S3 first.
    const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
    for (const doc of employee.documents) {
        try {
            await deleteEncryptedBlob(doc.s3Key);
        } catch (err) {
            console.error(
                `[deleteEmployee] failed to delete s3 ${doc.s3Key}:`,
                err.message
            );
        }
    }

    // Delete the linked User, if any, so the login email is freed up.
    if (employee.linkedUser) {
        try {
            const { User } = await import("../../model/auth/auth.model.js");
            await User.deleteOne({ _id: employee.linkedUser });
        } catch (err) {
            console.error(
                `[deleteEmployee] failed to delete linked user:`,
                err.message
            );
        }
    }

    await Employee.deleteOne({ _id: employee._id });
}

/**
 * Add new documents to an existing employee.
 *
 * @param {string} userId          - authenticated user
 * @param {string} idOrEmployeeId  - Mongo _id OR human employeeId
 * @param {Array<{originalname, mimetype, size, buffer, fileId, type, label}>} files
 * @returns {{ employee: object, addedCount: number }}
 */
export async function addDocumentsToEmployee(userId, idOrEmployeeId, files) {
    if (!files || files.length === 0) {
        throw ApiError.badRequest("No files provided");
    }

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const existingCount = employee.documents?.length ?? 0;
    if (existingCount + files.length > MAX_FILES_PER_EMPLOYEE) {
        throw ApiError.badRequest(
            `This employee already has ${existingCount} document(s). ` +
            `The limit is ${MAX_FILES_PER_EMPLOYEE} per employee.`
        );
    }

    const uploadedMeta = [];
    try {
        for (const f of files) {
            const { ciphertext, iv, authTag, wrappedDek, kekVersion } =
                encryptFile(f.buffer, {
                    employeeId: employee._id.toString(),
                    fileId: f.fileId,
                });

            const s3Key = `employees/${employee.workspace}/${employee._id}/${f.fileId}.enc`;
            await uploadEncryptedBlob(s3Key, ciphertext);

            uploadedMeta.push({
                fileId: f.fileId,
                type: f.type,
                label: f.label,
                fileName: f.originalname,
                fileSize: f.size,
                mimeType: f.mimetype,
                s3Key,
                iv,
                authTag,
                wrappedDek,
                kekVersion,
                uploadedBy: userId,
            });
        }

        employee.documents = [...employee.documents, ...uploadedMeta];
        await employee.save();

        return { employee, addedCount: uploadedMeta.length };
    } catch (err) {
        // Roll back S3 uploads if anything fails after some succeeded
        const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
        for (const m of uploadedMeta) {
            try {
                await deleteEncryptedBlob(m.s3Key);
            } catch {
                /* best-effort */
            }
        }
        throw err;
    }
}

/**
 * Update an existing employee with a partial patch.
 *
 * @param {string} userId          - authenticated user
 * @param {string} idOrEmployeeId  - Mongo _id OR human employeeId
 * @param {object} patch           - validated PATCH body
 * @returns {{ employee: object, removedDocumentCount: number }}
 */
export async function updateEmployee(userId, idOrEmployeeId, patch) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    // ----- 1) Remove documents (S3 + array) -----
    let removedDocumentCount = 0;
    if (Array.isArray(patch.removedDocumentIds) && patch.removedDocumentIds.length > 0) {
        const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
        const idsToRemove = new Set(patch.removedDocumentIds);

        const toKeep = [];
        for (const doc of employee.documents) {
            if (idsToRemove.has(doc.fileId)) {
                try {
                    await deleteEncryptedBlob(doc.s3Key);
                } catch (err) {
                    console.error(
                        `[updateEmployee] failed to delete s3 ${doc.s3Key}:`,
                        err.message
                    );
                }
                removedDocumentCount += 1;
            } else {
                toKeep.push(doc);
            }
        }
        employee.documents = toKeep;
    }

    // ----- 2) Apply field updates -----
    const setField = (key, transform) => {
        if (patch[key] === undefined) return;
        const value = transform ? transform(patch[key]) : patch[key];
        employee[key] = value;
    };

    setField("firstName");
    setField("lastName");
    setField("phone");
    setField("preferredName");
    setField("gender");
    setField("avatar");
    setField("manuallyPickedAvatar");

    setField("employmentStatus");
    setField("employmentType");
    setField("designation");
    setField("department");
    setField("reportingManager");
    setField("joiningDate", parseDate);
    setField("workLocation");
    setField("workArrangement");
    setField("probationEndDate", parseDate);
    setField("contractEndDate", parseDate);
    setField("employeeCategory");

    setField("personalEmail");
    setField("dateOfBirth", parseDate);
    setField("residentialAddress");
    setField("city");
    setField("country");
    setField("emergencyName");
    setField("emergencyRelation");
    setField("emergencyPhone");

    setField("workSchedule");
    setField("weeklyWorkingDays");
    setField("attendanceLocation");
    setField("attendanceMethod");
    setField("attendanceEligibility");
    setField("overtimeEligibility");
    setField("timeZone");

    setField("salaryAmount", (v) => Number(v));
    setField("salaryCurrency");
    setField("payFrequency");
    setField("bankAccountName");
    setField("bankAccountNumber");
    setField("bankName");
    setField("taxIdentifier");
    setField("payrollGroup");

    setField("nationalId");
    setField("createLogin");
    setField("loginEmail");
    setField("systemRole");
    setField("sendInvitation");

    await employee.save();

    return { employee, removedDocumentCount };
}