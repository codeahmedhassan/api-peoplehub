// src/services/employee/employee.service.js
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Employee } from "../../model/employee/employee.model.js";
import { EmployeeCounter } from "../../model/employee/counter.model.js";
import { EmployeeActivity } from "../../model/employee/activity.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { encryptFile } from "../storage/document-crypto.service.js";
import { uploadEncryptedBlob } from "../storage/s3.service.js";
import { createInviteToken } from "../../utils/inviteToken.js";
import {
    EMPLOYEE_ID_PREFIX,
    EMPLOYEE_ID_START,
    EMPLOYEE_ID_PAD,
    MAX_FILES_PER_EMPLOYEE,
} from "../../constants/employee.js";

/**
 * Resolve an employee by either its Mongo _id or its human employeeId
 * ("EMP-00125"). Scoped to the caller's workspace.
 */
async function findEmployeeForUser(userId, idOrEmployeeId) {
    const workspace = await getWorkspaceOrThrow(userId);

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

export async function nextEmployeeId(workspaceId) {
    // Initialize counter to START - 1 so the first increment gives START
    const counter = await EmployeeCounter.findOneAndUpdate(
        { workspace: workspaceId },
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    let seq = EMPLOYEE_ID_START + counter.sequence - 1;
    let idString = `${EMPLOYEE_ID_PREFIX}-${String(seq).padStart(EMPLOYEE_ID_PAD, "0")}`;

    // Loop to find an unused ID
    let exists = await Employee.findOne({ workspace: workspaceId, employeeId: idString }).lean();

    while (exists) {
        // If it exists, increment and try again
        const nextCounter = await EmployeeCounter.findOneAndUpdate(
            { workspace: workspaceId },
            { $inc: { sequence: 1 } },
            { new: true }
        );
        seq = EMPLOYEE_ID_START + nextCounter.sequence - 1;
        idString = `${EMPLOYEE_ID_PREFIX}-${String(seq).padStart(EMPLOYEE_ID_PAD, "0")}`;
        exists = await Employee.findOne({ workspace: workspaceId, employeeId: idString }).lean();
    }

    return idString;
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
    const workspace = await getWorkspaceOrThrow(userId);

    // -------------------------------------------------------------------
    // Auto-generate employee ID
    // -------------------------------------------------------------------
    let employeeId = body.employeeId?.trim();

    if (employeeId) {
        // The user provided a custom ID. Check if it's already taken.
        const existing = await Employee.findOne({
            workspace: workspace._id,
            employeeId
        }).lean();

        if (existing) {
            throw ApiError.conflict(`Employee ID "${employeeId}" is already in use in this workspace.`);
        }
    } else {
        // No ID provided by the user — generate the next available one.
        employeeId = await nextEmployeeId(workspace._id, true);
    }

    // -------------------------------------------------------------------
    // If a login is requested, provision a User with status "invited"
    // -------------------------------------------------------------------
    let linkedUser = null;
    let inviteToken = null;
    if (body.createLogin && body.loginEmail) {
        const existing = await User.findOne({ email: body.loginEmail });
        if (existing) {
            throw ApiError.conflict(
                `A user with email ${body.loginEmail} already exists.`
            );
        }

        linkedUser = await User.create({
            fullName: `${body.firstName} ${body.lastName}`.trim(),
            email: body.loginEmail,
            password: "!" + crypto.randomBytes(32).toString("hex"),
            company: workspace.companyName,
            companySize: "1-10",
            role: "Other",
            status: "pending", // Will become "active" after invite accepted
            emailVerified: true, // We trust the admin's input for the email
            setupCompletedAt: null, // They'll need to go through setup-workspace
            systemRole: body.systemRole || "Employee", // Store the role
            workspaceId: workspace._id,
        });

        // Generate invite token
        inviteToken = createInviteToken(linkedUser);
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
            // Send invite email if requested
            if (inviteToken && body.sendInvitation) {
                const { sendEmployeeInviteEmail } = await import("../email/email.service.js");
                sendEmployeeInviteEmail(linkedUser, inviteToken).catch((err) => {
                    console.error("Failed to send employee invite:", err.message);
                });
            }
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

    // Log the creation
    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: savedEmployee._id,
        actor: userId,
        type: "created",
        label: `Employee record created`,
    });

    return savedEmployee;
}

export async function listEmployees(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
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

        // Log document uploads
        if (uploadedMeta.length > 0) {
            const docNames = uploadedMeta.map((d) => d.label).join(", ");
            await EmployeeActivity.create({
                workspace: employee.workspace,
                employee: employee._id,
                actor: userId,
                type: "document_added",
                label: `Uploaded document(s): ${docNames}`,
            });
        }

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

    // ---------------------------------------------------------
    // LOG ACTIVITIES
    // ---------------------------------------------------------
    const activitiesToCreate = [];

    // 1. Check field changes
    const fieldsToLog = [
        { key: "designation", label: "Designation" },
        { key: "department", label: "Department" },
        { key: "employmentStatus", label: "Employment Status" },
        { key: "salaryAmount", label: "Salary" },
        { key: "systemRole", label: "System Role" },
    ];

    for (const field of fieldsToLog) {
        // If the patch included this field and the value changed
        if (patch[field.key] !== undefined && patch[field.key] !== employee[field.key]) {
            // Format salary nicely
            const oldVal = field.key === "salaryAmount" ? `${employee.salaryCurrency} ${employee[field.key]}` : employee[field.key];
            const newVal = field.key === "salaryAmount" ? `${employee.salaryCurrency} ${patch[field.key]}` : patch[field.key];

            // Don't show "null" or "undefined"
            const from = oldVal || "—";
            const to = newVal || "—";

            activitiesToCreate.push({
                workspace: employee.workspace,
                employee: employee._id,
                actor: userId,
                type: "updated",
                label: `${field.label} changed from "${from}" to "${to}"`,
            });
        }
    }

    // 2. Check if a login was created
    if (patch.createLogin === true && !employee.isModified("linkedUser")) {
        // (We only log this if it wasn't already true)
        activitiesToCreate.push({
            workspace: employee.workspace,
            employee: employee._id,
            actor: userId,
            type: "login_created",
            label: `System access granted (${patch.systemRole || "Employee"})`,
        });
    }

    // 3. Check removed documents
    if (removedDocumentCount > 0) {
        activitiesToCreate.push({
            workspace: employee.workspace,
            employee: employee._id,
            actor: userId,
            type: "document_removed",
            label: `Removed ${removedDocumentCount} document(s)`,
        });
    }

    // Save activities
    if (activitiesToCreate.length > 0) {
        await EmployeeActivity.insertMany(activitiesToCreate);
    }

    return { employee, removedDocumentCount };
}