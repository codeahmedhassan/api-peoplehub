// src/services/employee/employee.service.js
import crypto from "node:crypto";
import mongoose from "mongoose";
import { Employee } from "../../model/employee/employee.model.js";
import { EmployeeCounter } from "../../model/employee/counter.model.js";
import { EmployeeActivity } from "../../model/employee/activity.model.js";
import { EmployeeCorrectionRequest } from "../../model/employee/correctionRequest.model.js";
import { getWorkspaceOrThrow } from "../workspace/workspace.service.js";
import { getOrSetRequestCache } from "../../utils/requestContext.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { AttendanceRecord } from "../../model/attendance/attendance.model.js";
import { LeaveRequest } from "../../model/leave/leave.model.js";
import { PerformanceAppraisal } from "../../model/performance/performanceAppraisal.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { getDateInTimezone } from "../../utils/timezone.js";
import { assertEmployeeQuota, assertStorageQuota, resolvePlanConfig } from "../workspace/plan.service.js";
import { escapeRegex as escapeRegexSafe, sanitizeCsvCell } from "../../utils/security.js";
import { encryptFile, decryptFile } from "../storage/document-crypto.service.js";
import { uploadEncryptedBlob, deleteEncryptedBlob, getEncryptedBlob, getEmployeeDocumentPath } from "../storage/s3.service.js";
import { createInviteToken } from "../../utils/inviteToken.js";
import {
    EMPLOYEE_ID_PREFIX,
    EMPLOYEE_ID_START,
    EMPLOYEE_ID_PAD,
    MAX_FILES_PER_EMPLOYEE,
    DOCUMENT_TYPES,
} from "../../constants/employee.js";

/**
 * Safely converts any Date instance, ISO date string, or timestamp into an ISO-8601 string.
 * Returns null or fallback string if value is null/undefined or invalid Date.
 * Never throws "toISOString is not a function".
 */
export function toIsoStringSafe(val) {
    if (!val) return null;
    if (val instanceof Date) {
        return isNaN(val.getTime()) ? null : val.toISOString();
    }
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
        return d.toISOString();
    }
    return typeof val === "string" ? val : null;
}

export function escapeRegex(str) {
    return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Accurately determines if an employee works under a manager.
 * Supports all forms of reportingManager storage:
 * - "Muhammad Maaz (IT Manager)" (with designation in parens)
 * - "Muhammad Maaz"
 * - "EMP-00004"
 * - "EMP-00004 - Muhammad Maaz"
 * - Manager's ObjectId
 * Also allows manager to view/manage their own profile.
 */
export function isEmployeeDirectReport(employee, caller, callerEmployee) {
    if (!employee) return false;

    // A user can always view/access their own employee record
    if (callerEmployee?._id && employee._id && callerEmployee._id.toString() === employee._id.toString()) {
        return true;
    }
    if (caller?._id && employee.linkedUser && caller._id.toString() === employee.linkedUser.toString()) {
        return true;
    }
    if (caller?.email && employee.loginEmail && caller.email.toLowerCase() === employee.loginEmail.toLowerCase()) {
        return true;
    }

    const rawTarget = String(employee.reportingManager || "").trim();
    if (!rawTarget) return false;

    // Common non-manager / executive fallback values
    const nonManagerPatterns = [
        /^none(\b|$)/i,
        /reports to ceo/i,
        /direct to ceo/i,
        /^n\/a$/i,
        /^direct executive/i,
    ];
    if (nonManagerPatterns.some((p) => p.test(rawTarget))) {
        return false;
    }

    // Cleaned target stripping out "(Designation)" or any "(...)"
    const cleanTarget = rawTarget.replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();

    // Candidate manager identifiers
    const empId = callerEmployee?.employeeId ? String(callerEmployee.employeeId).trim().toLowerCase() : null;
    const empFullName = callerEmployee
        ? `${callerEmployee.firstName || ""} ${callerEmployee.lastName || ""}`.trim().toLowerCase()
        : null;
    const callerFullName = caller?.fullName ? String(caller.fullName).trim().toLowerCase() : null;
    const callerId = caller?._id ? caller._id.toString() : null;
    const empMongoId = callerEmployee?._id ? callerEmployee._id.toString() : null;

    // 1. Exact match on clean target
    if (empId && cleanTarget === empId) return true;
    if (empFullName && cleanTarget === empFullName) return true;
    if (callerFullName && cleanTarget === callerFullName) return true;
    if (callerId && cleanTarget === callerId) return true;
    if (empMongoId && cleanTarget === empMongoId) return true;

    // 2. Substring match for distinct identifiers (Employee ID, Mongo ID)
    if (empId && new RegExp(`(^|\\b|\\s|-)${escapeRegex(empId)}(\\b|\\s|-|$)`, "i").test(rawTarget)) {
        return true;
    }
    if (empMongoId && rawTarget.includes(empMongoId)) {
        return true;
    }

    // 3. Match on full names (must be at least 3 characters)
    const namesToTest = [empFullName, callerFullName].filter((n) => Boolean(n && n.length >= 3));
    for (const name of namesToTest) {
        const regex = new RegExp(`(^|\\b|\\s|-)${escapeRegex(name)}(\\b|\\s|-|\\(|$)`, "i");
        if (regex.test(rawTarget)) {
            return true;
        }
    }

    // 4. If target contains manager's first and last name as separate words
    if (callerEmployee?.firstName && callerEmployee?.lastName && callerEmployee.firstName.length >= 2 && callerEmployee.lastName.length >= 2) {
        const first = escapeRegex(callerEmployee.firstName.trim());
        const last = escapeRegex(callerEmployee.lastName.trim());
        if (new RegExp(`\\b${first}\\b`, "i").test(rawTarget) && new RegExp(`\\b${last}\\b`, "i").test(rawTarget)) {
            return true;
        }
    }

    return false;
}

/**
 * Checks if the caller has full system access across all modules (e.g. Workspace Owner, CEO, or Full Administrator).
 * Only users who have access to everything are authorized to grant auditLogs permissions.
 */
export function callerHasFullAccess(callerUser, workspace, callerEmployee = null) {
    if (!callerUser) return false;
    const isOwner = Boolean(workspace && workspace.owner && workspace.owner.toString() === callerUser._id.toString());
    const roleStr = String(callerUser.role || "").toLowerCase().trim();
    const systemRoleStr = String(callerUser.systemRole || callerEmployee?.systemRole || "").toLowerCase().trim();
    const isCEO = Boolean(
        isOwner ||
        /ceo|founder|administrator|admin/.test(roleStr) ||
        systemRoleStr === "admin"
    );
    if (isCEO) return true;

    // Check caller's permissions: must have view access to ALL core modules including auditLogs
    const perms = callerEmployee?.permissions || callerUser.permissions;
    if (!perms || typeof perms !== "object") return false;
    const requiredModules = ["dashboard", "employees", "attendance", "leave", "payroll", "performance", "documents", "auditLogs", "settings"];
    return requiredModules.every((mod) => Boolean(perms[mod]?.view));
}

/**
 * Strips module permissions that are unavailable under the workspace's subscription plan
 * or that the caller lacks authority to grant.
 */
export function sanitizeAssignedPermissions(rawPermissions, { hasFullAccess = false, workspace = null } = {}) {
    if (!rawPermissions || typeof rawPermissions !== "object") return {};
    const sanitized = { ...rawPermissions };
    const planConfig = resolvePlanConfig(workspace?.subscription);
    if (!hasFullAccess || !planConfig.features?.auditLogs) {
        delete sanitized.auditLogs;
    }
    return sanitized;
}

/**
 * Calculates or falls back to actual hours logged for an attendance record.
 */
export function calculateRecordHours(rec, defaultRequiredHours = 8) {
    if (!rec) return 0;

    const status = String(rec.status || "").toLowerCase().trim();
    if (["absent", "on-leave", "holiday", "weekend", "unmarked"].includes(status)) {
        return 0;
    }

    // 1. If hoursWorked is stored and > 0, return it
    if (typeof rec.hoursWorked === "number" && rec.hoursWorked > 0) {
        return Math.round(rec.hoursWorked * 10) / 10;
    }

    // 2. If checkIn and checkOut are available
    if (rec.checkIn && rec.checkOut) {
        const inDate = new Date(rec.checkIn);
        const outDate = new Date(rec.checkOut);
        if (!isNaN(inDate.getTime()) && !isNaN(outDate.getTime())) {
            let durationMs = outDate.getTime() - inDate.getTime();
            if (durationMs < 0) {
                durationMs += 24 * 60 * 60 * 1000; // Overnight shift
            }
            const hrs = durationMs / (1000 * 60 * 60);
            if (hrs > 0) {
                return Math.round(hrs * 10) / 10;
            }
        }
    }

    // 3. Fallback based on attendance status
    const reqHours = Number(rec.requiredHours) || defaultRequiredHours || 8;

    if (status === "present" || status === "remote") {
        return reqHours;
    }
    if (status === "half-day" || status === "half day") {
        return Math.round((reqHours / 2) * 10) / 10;
    }
    if (status === "late") {
        return Math.max(0, Math.round((reqHours - 1) * 10) / 10);
    }

    return 0;
}

/**
 * Builds a Mongo $or filter for direct reports of a manager.
 */
export function buildManagerDirectReportsMongoFilter(workspaceId, caller, callerEmployee, { includeSelf = false } = {}) {
    const rawIdentifiers = [
        callerEmployee?.employeeId,
        callerEmployee ? `${callerEmployee.firstName || ""} ${callerEmployee.lastName || ""}`.trim() : null,
        caller?.fullName ? caller.fullName.trim() : null,
        callerEmployee?._id?.toString(),
        caller?._id?.toString(),
    ].filter(Boolean);

    const regexArray = [];
    for (const id of rawIdentifiers) {
        if (!id || id.length < 2) continue;
        const escaped = escapeRegex(id);
        regexArray.push(new RegExp(`(^|\\b|\\s|-)${escaped}(\\b|\\s|-|\\(|$)`, "i"));
    }

    if (callerEmployee?.firstName && callerEmployee?.lastName && callerEmployee.firstName.length >= 2 && callerEmployee.lastName.length >= 2) {
        const first = escapeRegex(callerEmployee.firstName.trim());
        const last = escapeRegex(callerEmployee.lastName.trim());
        regexArray.push(new RegExp(`\\b${first}\\s+${last}\\b`, "i"));
    }

    const orClauses = [
        { reportingManager: { $in: rawIdentifiers } },
        { reportingManager: { $in: regexArray } },
    ];

    const filter = {
        workspace: workspaceId,
        $or: orClauses,
    };

    if (includeSelf) {
        if (callerEmployee?._id) {
            orClauses.push({ _id: callerEmployee._id });
        }
        if (caller?._id) {
            orClauses.push({ linkedUser: caller._id });
        }
    } else {
        // Explicitly exclude self so manager never sees themselves in employee table or attendance
        if (callerEmployee?._id) {
            filter._id = { $ne: callerEmployee._id };
        }
        if (caller?._id) {
            filter.linkedUser = { $ne: caller._id };
        }
        if (caller?.email) {
            filter.loginEmail = { $ne: caller.email.toLowerCase().trim() };
        }
    }

    return filter;
}

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

/**
 * Filter documents that a manager is allowed to view/access.
 * Allowed: Job Descriptions, Certificates, Work-related certificates, degrees/transcripts.
 * Blocked: Contracts, National IDs/passports, Bank docs, Tax, Medical, Disciplinary, Confidential HR docs.
 */
export function isDocumentAllowedForManager(doc) {
    if (!doc) return false;
    const type = String(doc.type || "").toLowerCase().trim();
    const label = String(doc.label || "").toLowerCase().trim();
    const fileName = String(doc.fileName || "").toLowerCase().trim();
    const combined = `${type} ${label} ${fileName}`;

    // Disallowed keywords (Strict rejection)
    const disallowedRegex = /contract|agreement|offer|national\s*id|cnic|passport|identity|id\s*proof|id\s*card|bank|account|cheque|tax|w[-_]?4|w[-_]?2|payroll|salary|compensation|medical|health|doctor|prescription|disciplinary|warning|inquiry|termination|confidential|vetting|background/i;
    if (disallowedRegex.test(combined)) {
        return false;
    }

    // Allowed categories:
    // - Job Descriptions
    // - Certificates
    // - Work related certificates
    // - Degrees / Diplomas / Transcripts
    const allowedRegex = /job\s*description|jd|certificate|certification|degree|diploma|transcript|training|achievement|course|work\s*related|work/i;
    return allowedRegex.test(combined);
}

export async function getEmployeeDetailBundle(userId, idOrEmployeeId) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const isManagerUser = Boolean(isManager && !isCEO && !isHR);

    if (isManagerUser) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only view details of employees reporting to them.");
        }

        // Persist in DB that this manager has viewed the employee, removing the (New) badge
        await Employee.updateOne(
            { _id: employee._id, "viewedByManagers.managerId": { $ne: userId } },
            { $push: { viewedByManagers: { managerId: userId, viewedAt: new Date() } } }
        );
    }

    let hireDateStr = null;
    if (employee.joiningDate) {
        hireDateStr = toIsoStringSafe(employee.joiningDate)?.slice(0, 10);
    } else if (employee.createdAt) {
        hireDateStr = toIsoStringSafe(employee.createdAt)?.slice(0, 10);
    }

    const attendanceFilter = {
        workspace: workspace._id,
        employee: employee._id,
        ...(hireDateStr ? { date: { $gte: hireDateStr } } : {}),
    };

    const [rawAttendanceRecords, leaveRecords, performanceAppraisals] = await Promise.all([
        AttendanceRecord.find(attendanceFilter)
            .sort({ date: -1 })
            .limit(60)
            .lean(),
        LeaveRequest.find({
            workspace: workspace._id,
            employee: employee._id,
        })
            .sort({ createdAt: -1 })
            .lean(),
        PerformanceAppraisal.find({
            workspace: workspace._id,
            employee: employee._id,
        })
            .sort({ reviewDate: -1 })
            .lean(),
    ]);

    // Filter strictly to records on or after employee's hire date
    const attendanceRecords = rawAttendanceRecords.filter(
        (r) => !hireDateStr || r.date >= hireDateStr
    );

    // Attendance stats
    const empRequiredHours = Number(employee.workingHours) || 8;
    const attendanceStats = {
        present: 0,
        late: 0,
        absent: 0,
        halfDay: 0,
        totalHours: 0,
        totalDays: attendanceRecords.length,
        avgHours: "0.0",
    };
    for (const rec of attendanceRecords) {
        if (rec.status === "present") attendanceStats.present += 1;
        else if (rec.status === "late") attendanceStats.late += 1;
        else if (rec.status === "absent") attendanceStats.absent += 1;
        else if (rec.status === "half-day") attendanceStats.halfDay += 1;
        attendanceStats.totalHours += calculateRecordHours(rec, empRequiredHours);
    }
    const daysWorked = attendanceStats.present + attendanceStats.late + attendanceStats.halfDay;
    if (daysWorked > 0) {
        attendanceStats.avgHours = (attendanceStats.totalHours / daysWorked).toFixed(1);
    }

    // Leave balances calculated dynamically from policy and records
    const { calculateAllLeaveBalances } = await import("../leave/leave.service.js");
    const dynamicLeave = await calculateAllLeaveBalances(workspace, employee._id, leaveRecords);
    const leaveBalances = dynamicLeave.balances;

    const safeEmployee = employee.toSafeJSON();

    let dateOfBirthLimited = null;
    if (safeEmployee.dateOfBirth) {
        const dobDate = new Date(safeEmployee.dateOfBirth);
        if (!isNaN(dobDate.getTime())) {
            const monthNames = [
                "January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"
            ];
            dateOfBirthLimited = `${monthNames[dobDate.getMonth()]} ${dobDate.getDate()}`;
        }
    }

    let safeDocuments = (safeEmployee.documents || []).map((d) => ({
        fileId: d.fileId,
        type: d.type,
        label: d.label,
        fileName: d.fileName,
        fileSize: d.fileSize,
        mimeType: d.mimeType,
        uploadedAt: d.uploadedAt,
    }));
    if (isManagerUser) {
        safeDocuments = safeDocuments.filter(isDocumentAllowedForManager);
    }

    // Default salary history if empty
    let salaryHistory = safeEmployee.salaryHistory || [];
    if (!salaryHistory.length && safeEmployee.salaryAmount) {
        salaryHistory = [
            {
                _id: "initial",
                effectiveDate: employee.joiningDate || employee.createdAt,
                previousSalary: safeEmployee.salaryAmount,
                newSalary: safeEmployee.salaryAmount,
                currency: workspace.currency || "USD",
                changeReason: "Initial Compensation Package",
                changedBy: "HR Department",
                createdAt: employee.createdAt,
            },
        ];
    }

    const vettingChecksResult = (() => {
            const hasIdDoc = (employee.documents || []).some(
                (d) => d.type === "id_proof" || d.type === "passport" || /id|cnic|passport|national/i.test(d.label || "") || /id|cnic|passport|national/i.test(d.fileName || "")
            );
            const idDoc = (employee.documents || []).find(
                (d) => d.type === "id_proof" || d.type === "passport" || /id|cnic|passport|national/i.test(d.label || "") || /id|cnic|passport|national/i.test(d.fileName || "")
            );

            const hasEducationDoc = (employee.documents || []).some(
                (d) => d.type === "degree" || d.type === "certificate" || /degree|transcript|diploma|education/i.test(d.label || "") || /degree|transcript|diploma|education/i.test(d.fileName || "")
            );
            const educationDoc = (employee.documents || []).find(
                (d) => d.type === "degree" || d.type === "certificate" || /degree|transcript|diploma|education/i.test(d.label || "") || /degree|transcript|diploma|education/i.test(d.fileName || "")
            );

            const hasReference = Boolean(
                employee.referenceName ||
                employee.referencePhone ||
                (Array.isArray(employee.employmentHistory) && employee.employmentHistory.length > 0)
            );

            // User requirement:
            // "The thing should be clear/passed if the user did them, else it should not show clear/passed"
            // "For National Identity Document (CNIC/passport): If the user haven't added the document it should show "Pending employee document" and if he have added it then show In progress."
            // "Same for others"
            // "By default nothing will be verified, the user will do it."

            const savedId = employee.vettingChecks?.identity;
            const isIdVerifiedByUser = Boolean(savedId?.verifiedAt);
            let idStatus;
            if (isIdVerifiedByUser && savedId?.status) {
                idStatus = savedId.status;
            } else {
                idStatus = (hasIdDoc || employee.nationalId) ? "In progress" : "Pending employee document";
            }

            const savedEdu = employee.vettingChecks?.education;
            const isEduVerifiedByUser = Boolean(savedEdu?.verifiedAt);
            let eduStatus;
            if (isEduVerifiedByUser && savedEdu?.status) {
                eduStatus = savedEdu.status;
            } else {
                eduStatus = hasEducationDoc ? "In progress" : "Pending employee document";
            }

            const savedEmp = employee.vettingChecks?.employment;
            const isEmpVerifiedByUser = Boolean(savedEmp?.verifiedAt);
            let empStatus;
            if (isEmpVerifiedByUser && savedEmp?.status) {
                empStatus = savedEmp.status;
            } else {
                empStatus = hasReference ? "In progress" : "Pending employee document";
            }

            const savedCrim = employee.vettingChecks?.criminal;
            const isCrimVerifiedByUser = Boolean(savedCrim?.verifiedAt);
            let crimStatus;
            if (isCrimVerifiedByUser && savedCrim?.status) {
                crimStatus = savedCrim.status;
            } else {
                crimStatus = "Pending check";
            }

            return {
                identity: {
                    status: idStatus,
                    verifiedAt: savedId?.verifiedAt || null,
                    verifiedBy: savedId?.verifiedBy || "",
                    notes: savedId?.notes || "",
                    hasDocument: Boolean(hasIdDoc || employee.nationalId),
                    documentFileId: idDoc?.fileId || null,
                    documentFileName: idDoc?.fileName || null,
                    documentLabel: idDoc?.label || (employee.nationalId ? `CNIC: ${employee.nationalId}` : null),
                },
                education: {
                    status: eduStatus,
                    verifiedAt: savedEdu?.verifiedAt || null,
                    verifiedBy: savedEdu?.verifiedBy || "",
                    notes: savedEdu?.notes || "",
                    hasDocument: Boolean(hasEducationDoc),
                    documentFileId: educationDoc?.fileId || null,
                    documentFileName: educationDoc?.fileName || null,
                    documentLabel: educationDoc?.label || null,
                },
                employment: {
                    status: empStatus,
                    verifiedAt: savedEmp?.verifiedAt || null,
                    verifiedBy: savedEmp?.verifiedBy || "",
                    notes: savedEmp?.notes || "",
                    referenceName: employee.referenceName || "",
                    referencePhone: employee.referencePhone || "",
                    referenceRelation: employee.referenceRelation || "",
                },
                criminal: {
                    status: crimStatus,
                    verifiedAt: savedCrim?.verifiedAt || null,
                    verifiedBy: savedCrim?.verifiedBy || "",
                    notes: savedCrim?.notes || "",
                },
            };
        })();

    const isSelf = Boolean(
        (callerEmployee && callerEmployee._id?.toString() === employee._id.toString()) ||
        (caller?._id && employee.user && caller._id.toString() === employee.user.toString()) ||
        (caller?.email && (caller.email.toLowerCase() === (employee.workEmail || "").toLowerCase() || caller.email.toLowerCase() === (employee.personalEmail || "").toLowerCase()))
    );

    // Extract approved leave intervals to accurately reflect on-leave status
    const approvedLeaveIntervals = [];
    for (const lr of leaveRecords) {
        if (lr.status === "approved" && lr.startDate && lr.endDate) {
            let startStr = toIsoStringSafe(lr.startDate)?.slice(0, 10);
            let endStr = toIsoStringSafe(lr.endDate)?.slice(0, 10);
            if (hireDateStr && startStr && startStr < hireDateStr) {
                startStr = hireDateStr;
            }
            if (startStr && endStr && startStr <= endStr && (!hireDateStr || endStr >= hireDateStr)) {
                approvedLeaveIntervals.push({
                    start: startStr,
                    end: endStr,
                    type: lr.leaveType || lr.type || "leave",
                });
            }
        }
    }

    const attendanceRecordsMap = new Map();
    for (const r of attendanceRecords) {
        const rowHours = calculateRecordHours(r, empRequiredHours);
        let status = r.status;
        const matchingLeave = approvedLeaveIntervals.find(
            (rng) => r.date >= rng.start && r.date <= rng.end
        );
        if (matchingLeave && (status === "unmarked" || !status || status === "absent")) {
            status = "on-leave";
        }
        attendanceRecordsMap.set(r.date, {
            id: r._id.toString(),
            date: r.date,
            status,
            source: r.source,
            checkIn: toIsoStringSafe(r.checkIn),
            checkOut: toIsoStringSafe(r.checkOut),
            totalHours: rowHours,
            hoursWorked: rowHours,
            requiredHours: r.requiredHours || empRequiredHours,
            note: r.note || (matchingLeave ? `Approved ${matchingLeave.type} leave` : ""),
            markedBy: r.markedBy || "",
        });
    }

    // Also synthesize dates for approved leaves that don't have an attendance record yet
    for (const lr of approvedLeaveIntervals) {
        let curr = new Date(lr.start + "T00:00:00");
        const stop = new Date(lr.end + "T00:00:00");
        while (curr <= stop) {
            const dateStr = curr.toISOString().slice(0, 10);
            if ((!hireDateStr || dateStr >= hireDateStr) && !attendanceRecordsMap.has(dateStr)) {
                attendanceRecordsMap.set(dateStr, {
                    id: `leave-${dateStr}`,
                    date: dateStr,
                    status: "on-leave",
                    source: "leave",
                    checkIn: null,
                    checkOut: null,
                    totalHours: 0,
                    hoursWorked: 0,
                    requiredHours: empRequiredHours,
                    note: `Approved ${lr.type} leave`,
                    markedBy: "HR",
                });
            }
            curr.setDate(curr.getDate() + 1);
        }
    }

    const mergedAttendanceRecords = Array.from(attendanceRecordsMap.values()).sort(
        (a, b) => b.date.localeCompare(a.date)
    );

    const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
    const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
    const ceoOverride = workspace.ceoFullControlWithHr !== undefined ? Boolean(workspace.ceoFullControlWithHr) : true;
    const canManage = isHR || (isCEO && (!hasHR || ceoOverride));

    const { calculateEmployeePayroll, getComponents } = await import("../payroll/payroll.service.js");
    let activeComps = [];
    try {
        activeComps = await getComponents(workspace._id);
    } catch {}
    const basePay = Number(safeEmployee.basicSalary || safeEmployee.salaryAmount || 0);
    let computedGross = basePay;
    let computedNet = basePay;
    if (activeComps && activeComps.length > 0) {
        try {
            const payrollSim = calculateEmployeePayroll(activeComps, { basicSalary: basePay, employee: safeEmployee });
            computedGross = payrollSim.grossSalary;
            computedNet = payrollSim.netSalary;
        } catch {}
    }
    const empCurrency = (employee.salaryCurrency || employee.currency || safeEmployee.salaryCurrency || safeEmployee.currency || workspace.currency || "USD").toUpperCase();

    return {
        ...safeEmployee,
        isSelf,
        callerRole: {
            isCEO,
            isHR,
            isManager: isManagerUser,
            isSelf,
            canManage,
        },
        documents: safeDocuments,
        dateOfBirthLimited,
        dateOfBirth: isManagerUser ? null : safeEmployee.dateOfBirth,
        nationalId: isManagerUser ? null : safeEmployee.nationalId,
        residentialAddress: isManagerUser ? null : safeEmployee.residentialAddress,
        address: isManagerUser ? null : safeEmployee.address,
        emergencyRelation: isManagerUser ? null : safeEmployee.emergencyRelation,
        referenceName: isManagerUser ? null : safeEmployee.referenceName,
        referencePhone: isManagerUser ? null : safeEmployee.referencePhone,
        referenceRelation: isManagerUser ? null : safeEmployee.referenceRelation,
        referenceAddress: isManagerUser ? null : safeEmployee.referenceAddress,

        salaryAmount: basePay,
        basicSalary: basePay,
        grossSalary: computedGross,
        netSalary: computedNet,
        salaryHistory: salaryHistory,
        bankAccountName: isManagerUser ? null : safeEmployee.bankAccountName,
        bankAccountNumber: isManagerUser ? null : safeEmployee.bankAccountNumber,
        bankName: isManagerUser ? null : safeEmployee.bankName,
        taxIdentifier: isManagerUser ? null : safeEmployee.taxIdentifier,
        payrollGroup: isManagerUser ? null : safeEmployee.payrollGroup,
        payFrequency: isManagerUser ? null : safeEmployee.payFrequency,

        confidentialNotes: isManagerUser ? null : safeEmployee.confidentialNotes,
        disciplinaryRecords: isManagerUser ? [] : (safeEmployee.disciplinaryRecords || []),
        vettingChecks: isManagerUser ? null : vettingChecksResult,

        currency: empCurrency,
        salaryCurrency: empCurrency,
        attendanceRecords: mergedAttendanceRecords,
        attendanceStats,
        leaveRecords: leaveRecords.map((l) => ({
            id: l._id.toString(),
            type: l.leaveType || l.type || "annual",
            category: l.category || "leave",
            isHalfDay: Boolean(l.isHalfDay),
            halfDayPeriod: l.halfDayPeriod || null,
            isShortDay: Boolean(l.isShortDay),
            shortDayHours: l.shortDayHours || null,
            startDate: toIsoStringSafe(l.startDate),
            endDate: toIsoStringSafe(l.endDate),
            totalDays: l.totalDays || 1,
            reason: l.reason || "",
            status: l.status,
            reviewerName: l.reviewerName || "",
            reviewedAt: toIsoStringSafe(l.reviewedAt),
            reviewerComments: l.reviewerComments || "",
            createdAt: toIsoStringSafe(l.createdAt),
        })),
        leaveBalances,
        weekendAccruals: dynamicLeave.weekendAccruals,
        leavePolicyMode: dynamicLeave.leavePolicyMode,
        noLeavePolicy: dynamicLeave.noLeavePolicy,
        weekendWorkEarnsLeave: dynamicLeave.weekendWorkEarnsLeave,
        performanceAppraisals: performanceAppraisals.map((p) => ({
            id: p._id.toString(),
            reviewPeriod: p.reviewPeriod,
            reviewDate: toIsoStringSafe(p.reviewDate),
            nextReviewDate: toIsoStringSafe(p.nextReviewDate),
            managerName: p.managerName,
            overallRating: p.overallRating,
            ratingBand: p.ratingBand,
            categories: p.categories || [],
            keyStrengths: p.keyStrengths || "",
            areasForImprovement: p.areasForImprovement || "",
            goalsAndAchievements: p.goalsAndAchievements || "",
            recommendation: p.recommendation || "",
            status: p.status,
        })),
    };
}

export async function downloadEmployeeDocument(userId, idOrEmployeeId, fileId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const doc = employee.documents.find((d) => d.fileId === fileId);
    if (!doc) {
        throw ApiError.notFound("Document not found");
    }

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only access documents of employees reporting to them.");
        }
        if (!isDocumentAllowedForManager(doc)) {
            throw ApiError.forbidden("Managers are not authorized to view or download confidential employee documents.");
        }
    }

    const ciphertextBuffer = await getEncryptedBlob(doc.s3Key);

    const aadCandidates = [
        employee._id.toString(),
        `draft-${employee.workspace}`,
        employee.employeeId,
    ];

    let plaintextBuffer = null;
    let decryptErr = null;

    for (const candidate of aadCandidates) {
        if (!candidate) continue;
        try {
            plaintextBuffer = decryptFile(ciphertextBuffer, {
                iv: doc.iv,
                authTag: doc.authTag,
                wrappedDek: doc.wrappedDek,
                employeeId: candidate,
                fileId: doc.fileId,
            });
            if (plaintextBuffer) break;
        } catch (err) {
            decryptErr = err;
        }
    }

    if (!plaintextBuffer) {
        console.error(`[downloadEmployeeDocument] Decryption failed for doc ${fileId}:`, decryptErr?.message);
        throw ApiError.internal(`Failed to decrypt document: ${decryptErr?.message || "Authentication failed"}`);
    }

    return {
        buffer: plaintextBuffer,
        fileName: doc.fileName,
        mimeType: doc.mimeType || "application/octet-stream",
        fileSize: doc.fileSize,
        label: doc.label,
    };
}

export async function deleteEmployeeDocument(userId, idOrEmployeeId, fileId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);
    if (isManager && !isCEO && !isHR) {
        throw ApiError.forbidden("Managers cannot directly delete documents. Please submit a document deletion request to HR.");
    }
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const docIndex = employee.documents.findIndex((d) => d.fileId === fileId);
    if (docIndex === -1) {
        throw ApiError.notFound("Document not found");
    }

    const doc = employee.documents[docIndex];

    // Delete from S3
    try {
        await deleteEncryptedBlob(doc.s3Key);
    } catch (err) {
        console.warn(`[deleteEmployeeDocument] S3 deletion warning for ${doc.s3Key}: ${err.message}`);
    }

    // Remove from employee document array
    employee.documents.splice(docIndex, 1);
    await employee.save();

    await EmployeeActivity.create({
        workspace: employee.workspace,
        employee: employee._id,
        actor: userId,
        type: "document_removed",
        label: `Document deleted: "${doc.label}" (${doc.fileName})`,
    });

    return employee;
}

export async function updateVettingCheck(userId, idOrEmployeeId, { category, status, notes }) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, isCEO, isHR } = await getCallerRoleContext(userId, workspace);
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    if (!["identity", "education", "employment", "criminal"].includes(category)) {
        throw ApiError.badRequest("Invalid vetting category");
    }

    if (!employee.vettingChecks) {
        employee.vettingChecks = {};
    }
    if (!employee.vettingChecks[category]) {
        employee.vettingChecks[category] = {};
    }

    employee.vettingChecks[category].status = status;
    employee.vettingChecks[category].verifiedBy = caller?.fullName || "HR Administrator";
    employee.vettingChecks[category].verifiedAt = new Date();
    if (notes !== undefined) {
        employee.vettingChecks[category].notes = notes;
    }

    // Also update backgroundCheckStatus high-level
    const allChecks = ["identity", "education", "employment", "criminal"];
    const statuses = allChecks.map((c) => employee.vettingChecks[c]?.status || "");
    if (statuses.some((s) => s === "Rejected" || s === "Failed")) {
        employee.backgroundCheckStatus = "Failed";
    } else if (statuses.every((s) => s === "Verified" || s === "Clear / Passed")) {
        employee.backgroundCheckStatus = "Verified";
    } else {
        employee.backgroundCheckStatus = "In Progress";
    }

    await employee.save();

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Background vetting updated for ${category}: ${status} by ${caller?.fullName || "HR"}`,
    });

    return employee;
}

export async function addDisciplinaryRecord(userId, idOrEmployeeId, data) {
    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, isCEO, isHR } = await getCallerRoleContext(userId, workspace);
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    if (!data.title || !data.title.trim()) {
        throw ApiError.badRequest("Disciplinary record title is required");
    }

    const record = {
        incidentDate: data.incidentDate ? new Date(data.incidentDate) : new Date(),
        title: data.title.trim(),
        type: data.type || "Written Warning",
        description: data.description ? data.description.trim() : "",
        actionTaken: data.actionTaken ? data.actionTaken.trim() : "",
        status: data.status || "Resolved",
        issuedBy: data.issuedBy ? data.issuedBy.trim() : caller?.fullName || "HR Department",
        notes: data.notes ? data.notes.trim() : "",
        createdAt: new Date(),
    };

    if (!Array.isArray(employee.disciplinaryRecords)) {
        employee.disciplinaryRecords = [];
    }
    employee.disciplinaryRecords.unshift(record);
    await employee.save();

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Disciplinary record filed: "${record.title}" (${record.type})`,
    });

    return employee;
}

export async function nextEmployeeId(workspaceId, options = {}) {
    const opts = typeof options === "boolean" ? { commit: options } : (options || {});
    const workspace = await Workspace.findById(workspaceId).lean();
    const config = workspace?.employeeIdConfig || {};

    const commit = Boolean(opts.commit);
    const startingNum = typeof config.startingNumber === "number" ? config.startingNumber : EMPLOYEE_ID_START;
    const padding = typeof config.paddingDigits === "number" ? config.paddingDigits : EMPLOYEE_ID_PAD;
    const separator = config.separator !== undefined ? config.separator : "-";

    const DEFAULT_BRANCH_CODES = {
        "Kohat": "KOH",
        "Islamabad": "ISB",
        "Lahore": "LHR",
        "Karachi": "KHI",
        "Peshawar": "PEW",
        "Rawalpindi": "RWP",
        "Faisalabad": "FSD",
        "Multan": "MUX",
        "New York": "NYC",
        "London": "LDN",
        "Dubai": "DXB",
        "Berlin": "BER",
        "Headquarters": "HQ",
        "Main Office": "MAIN",
        "Remote": "REM",
    };

    const DEFAULT_DEPT_CODES = {
        "Information Technology": "IT",
        "Engineering": "ENG",
        "Human Resources": "HR",
        "Finance": "FIN",
        "Accounts": "ACC",
        "Marketing": "MKT",
        "Sales": "SLS",
        "Operations": "OPS",
        "Support": "SUP",
        "Customer Support": "CS",
        "Design": "DES",
        "Administration": "ADMIN",
        "Legal": "LGL",
        "Quality Assurance": "QA",
        "Procurement": "PROC",
        "Logistics": "LOG",
    };

    const rawBranchMap = config.branchCodes instanceof Map
        ? Object.fromEntries(config.branchCodes)
        : (config.branchCodes || {});
    const rawDeptMap = config.departmentCodes instanceof Map
        ? Object.fromEntries(config.departmentCodes)
        : (config.departmentCodes || {});

    const branchMap = { ...DEFAULT_BRANCH_CODES, ...rawBranchMap };
    const deptMap = { ...DEFAULT_DEPT_CODES, ...rawDeptMap };

    const useBranchDefault =
        !config.formatExplicitlySet &&
        (!config.formatType || config.formatType === "prefix_number");

    const components = useBranchDefault
        ? ["branch", "number"]
        : Array.isArray(config.components) && config.components.length > 0
        ? config.components
        : ["branch", "number"];

    const buildId = (s) => {
        const parts = [];
        for (const comp of components) {
            switch (comp) {
                case "prefix": {
                    const p = (config.prefix !== undefined ? config.prefix : EMPLOYEE_ID_PREFIX).trim();
                    if (p) parts.push(p);
                    break;
                }
                case "branch": {
                    const loc = (opts.branch || opts.workLocation || "").trim();
                    let bCode = "";
                    if (loc) {
                        bCode = branchMap[loc] || branchMap[loc.toLowerCase()];
                        if (!bCode) {
                            const foundKey = Object.keys(branchMap).find(
                                (k) => k.toLowerCase() === loc.toLowerCase()
                            );
                            if (foundKey) bCode = branchMap[foundKey];
                        }
                        if (!bCode) {
                            bCode = loc.slice(0, 3).toUpperCase();
                        }
                    }
                    if (!bCode) {
                        bCode = (config.defaultBranchCode || "KOH").trim();
                    }
                    if (bCode) parts.push(bCode);
                    break;
                }
                case "department": {
                    const dept = (opts.department || "").trim();
                    let dCode = "";
                    if (dept) {
                        dCode = deptMap[dept] || deptMap[dept.toLowerCase()];
                        if (!dCode) {
                            const foundKey = Object.keys(deptMap).find(
                                (k) => k.toLowerCase() === dept.toLowerCase()
                            );
                            if (foundKey) dCode = deptMap[foundKey];
                        }
                        if (!dCode) {
                            dCode = dept.length <= 4 ? dept.toUpperCase() : dept.slice(0, 3).toUpperCase();
                        }
                    }
                    if (!dCode) {
                        dCode = "IT";
                    }
                    if (dCode) parts.push(dCode);
                    break;
                }
                case "year": {
                    let y;
                    if (config.yearSource === "joining_year" && opts.joiningDate) {
                        y = new Date(opts.joiningDate).getFullYear();
                    }
                    if (!y || isNaN(y)) {
                        y = new Date().getFullYear();
                    }
                    const yStr = config.yearFormat === "4_digit" ? String(y) : String(y).slice(-2);
                    parts.push(yStr);
                    break;
                }
                case "number": {
                    parts.push(String(s).padStart(padding, "0"));
                    break;
                }
                default:
                    break;
            }
        }

        if (!components.includes("number")) {
            parts.push(String(s).padStart(padding, "0"));
        }

        return parts.join(separator);
    };

    // Find all existing employeeIds for this workspace to fill gaps
    const existingEmployees = await Employee.find({ workspace: workspaceId }).select("employeeId").lean();
    const existingIdSet = new Set(
        existingEmployees
            .map((e) => String(e.employeeId || "").trim().toUpperCase())
            .filter(Boolean)
    );

    let s = startingNum;
    let candidateId = buildId(s);
    while (existingIdSet.has(candidateId.toUpperCase())) {
        s++;
        candidateId = buildId(s);
    }

    if (commit) {
        await EmployeeCounter.findOneAndUpdate(
            { workspace: workspaceId },
            { $set: { sequence: s } },
            { upsert: true }
        );
    }

    return candidateId;
}

function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Helper to ensure operational authority when CEO override is disabled and HR exists.
 */
export async function assertOperationalAuthority(userId, workspace, isCEO, isHR) {
    if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }
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
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    if (isManager) {
        throw ApiError.forbidden("Managers cannot create employees. Only HR can create employee records.");
    }

    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    await assertEmployeeQuota(workspace._id);
    if (Array.isArray(files) && files.length > 0) {
        const totalIncomingBytes = files.reduce((acc, f) => acc + (f.size || f.buffer?.length || 0), 0);
        await assertStorageQuota(workspace._id, totalIncomingBytes, files);
    }

    // -------------------------------------------------------------------
    // Auto-generate employee ID
    // -------------------------------------------------------------------
    let employeeId = body.employeeId?.trim();

    if (employeeId) {
        // The user provided or confirmed an ID. Check if it's already taken.
        const existing = await Employee.findOne({
            workspace: workspace._id,
            employeeId
        }).lean();

        if (existing) {
            throw ApiError.conflict(`Employee ID "${employeeId}" is already in use in this workspace.`);
        }
    } else {
        // No ID provided by the user — generate the next available one according to workspace ID policy.
        employeeId = await nextEmployeeId(workspace._id, {
            commit: true,
            department: body.department,
            workLocation: body.branch || body.workLocation,
            branch: body.branch || body.workLocation,
            joiningDate: body.joiningDate,
        });
    }

    // -------------------------------------------------------------------
    // Unique National ID check per workspace (allows same ID in other workspaces)
    // -------------------------------------------------------------------
    const nationalId = body.nationalId?.trim();
    if (nationalId) {
        const existingNationalId = await Employee.findOne({
            workspace: workspace._id,
            nationalId,
        }).lean();
        if (existingNationalId) {
            throw ApiError.conflict(
                `An employee with National ID "${nationalId}" already exists in this workspace.`
            );
        }
    }

    // -------------------------------------------------------------------
    // If a login is requested, provision a User with status "invited"
    // -------------------------------------------------------------------
    // Step 6: Create login account if requested
    // -------------------------------------------------------------------
    const callerUser = await User.findById(userId).lean();
    const hasFullAccess = callerHasFullAccess(callerUser, workspace);
    const assignedPermissions = sanitizeAssignedPermissions(body.permissions, { hasFullAccess, workspace });

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
            permissions: assignedPermissions,
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
        branch: body.branch || body.workLocation || "",
        workLocation: body.branch || body.workLocation || "",
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
        referenceName: body.referenceName || "",
        referenceRelation: body.referenceRelation || "",
        referencePhone: body.referencePhone || "",
        referenceAddress: body.referenceAddress || "",

        workSchedule: body.workSchedule ? (`${parseFloat(body.workSchedule) || 8} ${parseFloat(body.workSchedule) === 1 ? 'hour' : 'hours'}`) : "8 hours",
        workingHours: parseFloat(body.workSchedule) || Number(body.workingHours) || 8,
        workShift: body.workShift || "Morning Shift (09:00 - 18:00)",
        weeklyWorkingDays: body.weeklyWorkingDays || "",
        attendanceLocation: body.attendanceLocation || "",
        attendanceMethod: body.attendanceMethod || "",
        attendanceEligibility: body.attendanceEligibility || "Eligible",
        overtimeEligibility: Boolean(body.overtimeEligibility),
        timeZone: body.timeZone || "",

        salaryAmount: Number(body.salaryAmount),
        salaryCurrency: (body.salaryCurrency || workspace.currency || "USD").trim().toUpperCase(),
        currency: (body.salaryCurrency || workspace.currency || "USD").trim().toUpperCase(),
        payFrequency: body.payFrequency,
        bankAccountName: body.bankAccountName || "",
        bankAccountNumber: body.bankAccountNumber || "",
        bankName: body.bankName || "",
        taxIdentifier: body.taxIdentifier || "",
        payrollGroup: body.payrollGroup || "",

        nationalId: body.nationalId || "",
        documents: (Array.isArray(body.draftDocuments) ? body.draftDocuments : [])
            .filter((d) => d && d.fileId && d.s3Key && d.iv && d.authTag && d.wrappedDek)
            .map((d) => ({
                fileId: d.fileId,
                type: DOCUMENT_TYPES.includes(d.type) ? d.type : "Other",
                label: d.label || d.fileName || "Document",
                fileName: d.fileName || d.label || "document",
                fileSize: Number(d.fileSize) || 1,
                mimeType: d.mimeType || "application/octet-stream",
                s3Key: d.s3Key,
                iv: d.iv,
                authTag: d.authTag,
                wrappedDek: d.wrappedDek,
                kekVersion: d.kekVersion || 1,
                uploadedBy: userId,
                uploadedAt: new Date(),
            })),

        education: Array.isArray(body.education) ? body.education : [],
        experience: Array.isArray(body.experience) ? body.experience : [],
        certificates: Array.isArray(body.certificates) ? body.certificates : [],
        permissions: assignedPermissions,

        createLogin: Boolean(body.createLogin),
        loginEmail: body.createLogin ? (body.loginEmail || "") : "",
        systemRole: body.systemRole || "Employee",
        sendInvitation: Boolean(body.createLogin && body.sendInvitation),
        linkedUser: (body.createLogin && linkedUser) ? linkedUser._id : null,
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

                // Canonical tree: employees/{employeeId}/documents/{filename}
                const s3Key = getEmployeeDocumentPath(savedEmployee._id.toString(), `${f.fileId}.enc`);
                await uploadEncryptedBlob(s3Key, ciphertext);

                uploadedMeta.push({
                    fileId: f.fileId,
                    type: DOCUMENT_TYPES.includes(f.type) ? f.type : "Other",
                    label: f.label || f.originalname || "Document",
                    fileName: f.originalname || "document",
                    fileSize: Number(f.size) || 1, // plaintext size
                    mimeType: f.mimetype || "application/octet-stream",
                    s3Key,
                    iv,
                    authTag,
                    wrappedDek,
                    kekVersion,
                    uploadedBy: userId,
                });
            }

            savedEmployee.documents = [...(savedEmployee.documents || []), ...uploadedMeta];
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

    // Send invite email if requested (irrespective of whether files were uploaded)
    if (inviteToken && body.createLogin && body.sendInvitation && linkedUser) {
        const { sendEmployeeInviteEmail } = await import("../email/email.service.js");
        sendEmployeeInviteEmail(linkedUser, inviteToken).catch((err) => {
            console.error("Failed to send employee invite:", err.message);
        });
    }

    // Log the creation
    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: savedEmployee._id,
        actor: userId,
        type: "created",
        label: `Employee record created`,
    });

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: caller?.fullName,
            actorRole: isCEO ? "CEO" : isHR ? "HR" : "Administrator",
            action: "employee.create",
            module: "Employees",
            targetId: savedEmployee.employeeId,
            targetName: `${savedEmployee.firstName} ${savedEmployee.lastName}`.trim(),
            targetType: "Employee",
            description: `Created new employee profile for ${savedEmployee.firstName} ${savedEmployee.lastName} (${savedEmployee.employeeId}) in ${savedEmployee.department}${savedEmployee.createLogin ? ` with ${savedEmployee.systemRole} account access` : ""}`,
            details: {
                employeeId: savedEmployee.employeeId,
                designation: savedEmployee.designation,
                department: savedEmployee.department,
                createLogin: savedEmployee.createLogin,
                systemRole: savedEmployee.systemRole,
                educationCount: (savedEmployee.education || []).length,
                experienceCount: (savedEmployee.experience || []).length,
                certificatesCount: (savedEmployee.certificates || []).length,
            },
        });
    } catch {}

    // If employee has Remote work arrangement, automatically record remote attendance for today
    if (savedEmployee.workArrangement && /remote/i.test(savedEmployee.workArrangement)) {
        try {
            const { autoMarkRemoteAttendanceForWorkspace } = await import("../attendance/attendance.service.js");
            await autoMarkRemoteAttendanceForWorkspace(workspace._id);
        } catch {}
    }

    // -------------------------------------------------------------------
    // In-App & Email Notifications for New Employee & Reporting Managers
    // (Restricted to Paid Pro Plan; on Basic/Free Plan, no in-app or email notifications are sent)
    // -------------------------------------------------------------------
    const isPaidPlan = resolvePlanConfig(workspace.subscription).isPaid;
    if (isPaidPlan) {
        try {
            const { createNotification } = await import("../notification/notification.service.js");
            const { sendNewEmployeeEmail, sendTeamAssignmentEmail } = await import("../email/email.service.js");

            // 1. In-app notification for Workspace Admins
            await createNotification({
                workspaceId: workspace._id,
                recipientId: null, // Broadcast to workspace admins
                title: "New Employee Added",
                message: `${savedEmployee.firstName} ${savedEmployee.lastName} joined as ${savedEmployee.designation || "Team Member"} in ${savedEmployee.department}.`,
                type: "employee_added",
                link: "/employees",
                metadata: {
                    employeeId: savedEmployee._id,
                    employeeCode: savedEmployee.employeeId,
                    department: savedEmployee.department,
                },
            });

            // Email to Workspace Owner/Admins if enabled
            const ownerUser = await User.findById(workspace.owner);
            if (ownerUser && ownerUser.email) {
                const pref =
                    ownerUser.notificationPreferences?.["ceo-new-employee-hired"] ??
                    ownerUser.notificationPreferences?.["hr-new-employee-added"] ??
                    ownerUser.notificationPreferences?.["new-employee"] ??
                    true;
                if (pref) {
                    sendNewEmployeeEmail({
                        to: ownerUser.email,
                        employee: savedEmployee,
                        companyName: workspace.companyName,
                    }).catch(() => {});
                }
            }

            // 2. If a reporting manager is assigned, find the manager and notify them!
            if (savedEmployee.reportingManager) {
                const managerQuery = savedEmployee.reportingManager.trim();
                const managerEmp = await Employee.findOne({
                    workspace: workspace._id,
                    $or: [
                        { employeeId: managerQuery },
                        { firstName: managerQuery.split(" ")[0] },
                    ],
                });

                const managerUser = managerEmp?.linkedUser
                    ? await User.findById(managerEmp.linkedUser)
                    : await User.findOne({
                        $or: [
                            { fullName: new RegExp("^" + escapeRegexSafe(managerQuery) + "$", "i") },
                            { email: managerQuery.toLowerCase() },
                        ],
                    });

                // In-app notification for the Manager
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: managerUser?._id || (managerEmp ? managerEmp.linkedUser : null),
                    title: "New Team Member Assigned",
                    message: `${savedEmployee.firstName} ${savedEmployee.lastName} has been assigned to your team under ${savedEmployee.department}.`,
                    type: "team_assignment",
                    link: "/employees",
                    metadata: {
                        employeeId: savedEmployee._id,
                        employeeName: `${savedEmployee.firstName} ${savedEmployee.lastName}`,
                        department: savedEmployee.department,
                    },
                });

                const managerEmail = managerUser?.email || managerEmp?.loginEmail || managerEmp?.personalEmail;
                if (managerEmail) {
                    const managerPref =
                        managerUser?.notificationPreferences?.["mgr-new-employee-assigned"] ??
                        managerUser?.notificationPreferences?.["manager-assignment"] ??
                        true;
                    if (managerPref) {
                        sendTeamAssignmentEmail({
                            to: managerEmail,
                            managerName: managerUser?.fullName || managerEmp?.firstName || managerQuery,
                            employee: savedEmployee,
                            companyName: workspace.companyName,
                        }).catch(() => {});
                    }
                }
            }
        } catch (notifErr) {
            console.error("Non-fatal notification error on employee creation:", notifErr.message);
        }
    }

    return savedEmployee;
}

export async function getCallerRoleContext(userId, workspace) {
    const caller = await getOrSetRequestCache(`auth_user_lean:${userId}`, () =>
        User.findById(userId)
            .select("-activeSessions -notificationPreferences -legalAcceptance")
            .lean()
    );
    if (!caller) throw ApiError.unauthorized("User no longer exists");

    const callerEmployee = await getOrSetRequestCache(`caller_emp_lean:${workspace._id}:${userId}`, () =>
        Employee.findOne({
            workspace: workspace._id,
            $or: [{ linkedUser: userId }, { loginEmail: caller.email }],
        }).select("-documents -salaryHistory -disciplinaryRecords -education -experience -certificates -vettingChecks -confidentialNotes -bankAccountNumber -taxIdentifier").lean()
    );

    let isOwner = false;
    if (workspace.owner) {
        isOwner = workspace.owner.toString() === userId.toString();
    }

    const roleStr = String(caller.role || "").toLowerCase().trim();
    const systemRoleStr = String(caller.systemRole || callerEmployee?.systemRole || "").toLowerCase().trim();
    const isHrExplicit = Boolean(
        roleStr === "hr" ||
        systemRoleStr === "hr" ||
        callerEmployee?.systemRole === "HR" ||
        /hr|human resource/i.test(callerEmployee?.designation || "") ||
        /hr|human resource/i.test(callerEmployee?.department || "")
    );

    let isCEO = !isHrExplicit && Boolean(
        isOwner ||
        roleStr === "founder / ceo" ||
        roleStr === "founder" ||
        roleStr === "ceo" ||
        roleStr === "administrator"
    );

    let isHR = Boolean(
        !isCEO && (
            isHrExplicit ||
            Boolean(callerEmployee?.permissions?.employees?.create && callerEmployee?.permissions?.leave?.approve)
        )
    );

    const isManager = Boolean(
        !isCEO && !isHR && (
            roleStr === "manager" ||
            systemRoleStr === "manager" ||
            callerEmployee?.systemRole === "Manager" ||
            /manager|lead|supervisor|head/i.test(callerEmployee?.designation || "")
        )
    );

    return {
        caller,
        callerEmployee,
        isCEO,
        isHR,
        isManager,
    };
}

export async function getOperationalReviewers(workspace, { excludeUserId = null, forceCeo = false } = {}) {
    const hrUsers = await User.find({
        workspaceId: workspace._id,
        $or: [
            { role: { $in: ["HR", "HR Manager", "HR Generalist"] } },
            { systemRole: "HR" },
        ],
        status: { $ne: "inactive" },
    }).lean();

    const ceoUsers = await User.find({
        workspaceId: workspace._id,
        $or: [
            { role: { $in: ["Founder / CEO", "Administrator"] } },
            { systemRole: "Admin" },
            ...(workspace.owner ? [{ _id: workspace.owner }] : []),
        ],
        status: { $ne: "inactive" },
    }).lean();

    if (forceCeo) {
        return ceoUsers.filter((u) => !excludeUserId || u._id.toString() !== excludeUserId.toString());
    }

    // If CEO delegation is disabled (ceoFullControlWithHr === false) AND workspace has HR:
    // Only HR receives notifications and reviews. CEO does NOT receive notifications/emails.
    if (workspace.ceoFullControlWithHr === false && hrUsers.length > 0) {
        return hrUsers.filter((u) => !excludeUserId || u._id.toString() !== excludeUserId.toString());
    }

    // Otherwise (CEO has full control or no HR exists), both HR and CEO are reviewers
    const combined = [...hrUsers, ...ceoUsers];
    const uniqueMap = new Map();
    for (const u of combined) {
        if (!excludeUserId || u._id.toString() !== excludeUserId.toString()) {
            uniqueMap.set(u._id.toString(), u);
        }
    }
    return Array.from(uniqueMap.values());
}

export async function listEmployees(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    let filter = { workspace: workspace._id };

    if (isCEO || isHR) {
        // HR and CEO see ALL employees in the table
        filter = { workspace: workspace._id };
    } else if (isManager) {
        // Manager sees ONLY employees working under them (never themselves)
        filter = buildManagerDirectReportsMongoFilter(workspace._id, caller, callerEmployee, { includeSelf: false });
    } else {
        // Regular employee / viewer only sees themselves
        if (callerEmployee) {
            filter = { workspace: workspace._id, _id: callerEmployee._id };
        } else {
            filter = { workspace: workspace._id, _id: null };
        }
    }

    const employees = await Employee.find(filter)
        .select("-confidentialNotes -salaryHistory -disciplinaryRecords -vettingChecks -bankAccountNumber -taxIdentifier")
        .sort({ firstName: 1, lastName: 1 })
        .lean();

    const { calculateEmployeePayroll, getComponents } = await import("../payroll/payroll.service.js");
    let activeComps = [];
    try {
        activeComps = await getComponents(workspace._id);
    } catch {}

    let mapped = employees.map((e) => {
        const { documents, ...rest } = e;
        const hasViewed = Array.isArray(e.viewedByManagers) && e.viewedByManagers.some(
            (v) => v.managerId && v.managerId.toString() === userId.toString()
        );
        const isNewForManager = isManager ? !hasViewed : false;

        const basePay = Number(e.basicSalary || e.salaryAmount || 0);
        let computedGross = basePay;
        let computedNet = basePay;
        if (activeComps && activeComps.length > 0) {
            try {
                const payrollSim = calculateEmployeePayroll(activeComps, { basicSalary: basePay, employee: e });
                computedGross = payrollSim.grossSalary;
                computedNet = payrollSim.netSalary;
            } catch {}
        }
        const empCurrency = (e.salaryCurrency || e.currency || workspace.currency || "USD").toUpperCase();

        return {
            ...rest,
            id: e._id,
            basicSalary: basePay,
            grossSalary: computedGross,
            netSalary: computedNet,
            currency: empCurrency,
            salaryCurrency: empCurrency,
            documentCount: documents?.length ?? 0,
            isNewForManager,
        };
    });

    if (isManager) {
        // Rank newly assigned direct reports at the top for managers
        mapped.sort((a, b) => {
            if (a.isNewForManager && !b.isNewForManager) return -1;
            if (!a.isNewForManager && b.isNewForManager) return 1;
            return 0;
        });
    }

    return mapped;
}

/**
 * Automatically detects if a resigning/offboarded employee has direct reports.
 * If direct reports exist, dispatches a manager_resignation notification to HR and CEO.
 */
export async function notifyManagerResignationIfNeeded(workspaceId, employee) {
    if (!employee) return;
    try {
        const directReportsFilter = buildManagerDirectReportsMongoFilter(workspaceId, null, employee, { includeSelf: false });
        const directReports = await Employee.find({
            ...directReportsFilter,
            employmentStatus: { $ne: "Terminated" },
        }).select("_id employeeId firstName lastName designation department avatar").lean();

        if (directReports.length > 0) {
            const { createNotification } = await import("../notification/notification.service.js");
            const ws = await Workspace.findById(workspaceId).lean();
            const hrAndCeoUsers = ws
                ? await getOperationalReviewers(ws)
                : await User.find({
                    workspaceId: workspaceId,
                    $or: [
                        { role: { $in: ["Founder / CEO", "HR", "Administrator"] } },
                        { systemRole: { $in: ["Admin", "HR"] } },
                    ]
                }).lean();

            const managerFullName = `${employee.firstName} ${employee.lastName}`.trim();
            const count = directReports.length;

            for (const recipient of hrAndCeoUsers) {
                await createNotification({
                    workspaceId: workspaceId,
                    recipientId: recipient._id,
                    title: `Manager Resignation: ${managerFullName}`,
                    message: `Manager ${managerFullName} has resigned/been offboarded. Action required: Reassign ${count} direct report${count === 1 ? "" : "s"} to another manager.`,
                    type: "manager_resignation",
                    link: `/employees?reassignManager=${employee._id}&reassignName=${encodeURIComponent(managerFullName)}&count=${count}`,
                    metadata: {
                        managerId: employee._id.toString(),
                        managerName: managerFullName,
                        directReportsCount: count,
                    },
                });
            }

            await EmployeeActivity.create({
                workspace: workspaceId,
                employee: employee._id,
                actor: employee.linkedUser || employee._id,
                type: "updated",
                label: `Manager resigned/offboarded with ${count} active direct report(s) requiring reassignment.`,
            });
        }
    } catch (err) {
        console.error("Non-fatal error notifying manager resignation:", err);
    }
}

/**
 * Change: deleteEmployee now accepts either a Mongo _id or an employeeId
 * ("EMP-00125"). Signature is unchanged — the id is just more flexible now.
 *
 * OVERWRITE the existing `deleteEmployee` function with this version.
 */
export async function deleteEmployee(userId, idOrEmployeeId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    if (isManager) {
        throw ApiError.forbidden("Managers cannot delete employees.");
    }

    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    await notifyManagerResignationIfNeeded(workspace._id, employee);

    // Rule: Never delete anything from database (AGENTS.md).
    // Preserve the record and soft-offboard by setting status to Terminated.
    employee.employmentStatus = "Terminated";
    employee.isActive = false;
    await employee.save();

    // Deactivate linked User account so access is revoked without dropping data
    if (employee.linkedUser) {
        try {
            const { User } = await import("../../model/auth/auth.model.js");
            await User.updateOne({ _id: employee.linkedUser }, { $set: { status: "inactive" } });
        } catch (err) {
            console.error(
                `[deleteEmployee] failed to deactivate linked user:`,
                err.message
            );
        }
    }

    try {
        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "status_changed",
            label: `Employee status changed to Terminated (Offboarded) by ${isCEO ? "CEO" : "HR"}`,
        });
    } catch {}

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: isCEO ? "CEO" : "HR",
            actorRole: isCEO ? "CEO" : "HR",
            action: "employee.offboard",
            module: "Employees",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Offboarded employee record for ${employee.firstName} ${employee.lastName} (${employee.employeeId}) to Terminated`,
            details: {
                employeeId: employee.employeeId,
                department: employee.department,
            },
        });
    } catch {}
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

    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);
    if (isManager && !isCEO && !isHR) {
        throw ApiError.forbidden("Managers cannot directly upload documents. Please contact HR.");
    }
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const existingCount = employee.documents?.length ?? 0;
    if (existingCount + files.length > MAX_FILES_PER_EMPLOYEE) {
        throw ApiError.badRequest(
            `This employee already has ${existingCount} document(s). ` +
            `The limit is ${MAX_FILES_PER_EMPLOYEE} per employee.`
        );
    }

    const incomingBytes = files.reduce((acc, f) => acc + (f.size || f.buffer?.length || 0), 0);
    await assertStorageQuota(workspace._id, incomingBytes, files);

    const uploadedMeta = [];
    try {
        for (const f of files) {
            const { ciphertext, iv, authTag, wrappedDek, kekVersion } =
                encryptFile(f.buffer, {
                    employeeId: employee._id.toString(),
                    fileId: f.fileId,
                });

            // Canonical tree: employees/{employeeId}/documents/{filename}
            const s3Key = getEmployeeDocumentPath(employee._id.toString(), `${f.fileId}.enc`);
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
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    // Rule: Details of CEO and Founder cannot be changed by HR
    const isTargetCEO = Boolean(
        (workspace.owner && employee.linkedUser && workspace.owner.toString() === employee.linkedUser.toString()) ||
        employee.systemRole === "Admin" ||
        /ceo|founder/i.test(employee.designation || "")
    );

    if (isTargetCEO && isHR && !isCEO) {
        throw ApiError.forbidden("The details of the CEO and Founder cannot be changed by HR.");
    }

    // Rule: CEO Authority disabled enforcement
    if (isCEO && !isHR) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        const ceoFullControl = workspace.ceoFullControlWithHr !== undefined ? Boolean(workspace.ceoFullControlWithHr) : true;
        if (hasHR && !ceoFullControl) {
            throw ApiError.forbidden("HR exists in the organization and CEO Authority is disabled. Employee modifications are delegated to HR.");
        }
    }

    // Rule: The HR cannot change their own status. It can only be changed by the CEO.
    if (patch.employmentStatus !== undefined && patch.employmentStatus !== employee.employmentStatus) {
        const isSelf = Boolean(
            (employee.linkedUser && employee.linkedUser.toString() === userId.toString()) ||
            (callerEmployee && callerEmployee._id.toString() === employee._id.toString()) ||
            (employee.loginEmail && employee.loginEmail.toLowerCase() === caller.email?.toLowerCase())
        );

        const isTargetHR = Boolean(
            employee.systemRole === "HR" ||
            /hr|human resource/i.test(employee.designation || "") ||
            /hr|human resource/i.test(employee.department || "")
        );

        if (isSelf && !isCEO) {
            throw ApiError.forbidden("You cannot change your own employment status. This can only be changed by the CEO.");
        }

        if (isTargetHR && isHR && !isCEO) {
            throw ApiError.forbidden("HR status cannot be changed by another HR. Only the CEO can change HR status.");
        }
    }

    // Rule: Managers cannot directly modify details of an employee, but create a correction request for HR verification
    if (isManager) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request corrections for employees working under them.");
        }

        const originalValues = {};
        for (const k of Object.keys(patch)) {
            if (k !== "removedDocumentIds") {
                originalValues[k] = employee[k];
            }
        }

        const correctionRequest = await EmployeeCorrectionRequest.create({
            workspace: workspace._id,
            employee: employee._id,
            employeeId: employee.employeeId,
            employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
            requestedBy: userId,
            requestedByName: caller.fullName || `${callerEmployee?.firstName || ""} ${callerEmployee?.lastName || ""}`.trim() || "Manager",
            requestedByRole: "Manager",
            patch,
            originalValues,
            status: "pending",
        });

        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "correction_requested",
            label: `Correction request submitted by Manager (${caller.fullName || "Manager"}) for HR verification`,
        });

        try {
            const { createNotification } = await import("../notification/notification.service.js");
            const hrAndCeoUsers = await getOperationalReviewers(workspace, { excludeUserId: userId });

            for (const recipient of hrAndCeoUsers) {
                if (recipient._id.toString() !== userId.toString()) {
                    await createNotification({
                        workspaceId: workspace._id,
                        recipientId: recipient._id,
                        title: "Employee Correction Request",
                        message: `Manager ${caller.fullName || "Manager"} submitted details correction for ${employee.firstName} ${employee.lastName}. Awaiting your verification.`,
                        type: "employee_update",
                        link: `/employees/${employee.employeeId}`,
                        metadata: { correctionRequestId: correctionRequest._id.toString(), employeeId: employee.employeeId },
                    });
                }
            }
        } catch (notifErr) {
            console.error("Non-fatal notification error:", notifErr);
        }

        return {
            employee,
            isCorrectionRequest: true,
            correctionRequestId: correctionRequest._id,
            message: "Correction request submitted to HR for verification and approval.",
            removedDocumentCount: 0,
        };
    }

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
    const previousEmploymentStatus = employee.employmentStatus;
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
    setField("probationStatus");
    setField("probationEndDate", parseDate);
    setField("contractEndDate", parseDate);
    setField("employeeCategory");

    setField("personalEmail");
    setField("workEmail");
    if (patch.workEmail !== undefined && patch.workEmail.trim()) {
        const cleanWorkEmail = patch.workEmail.trim().toLowerCase();
        employee.workEmail = cleanWorkEmail;
        if (!employee.loginEmail) {
            employee.loginEmail = cleanWorkEmail;
        }
        if (employee.linkedUser) {
            try {
                const { User } = await import("../../model/auth/auth.model.js");
                await User.updateOne({ _id: employee.linkedUser }, { $set: { email: cleanWorkEmail } });
            } catch (err) {
                console.error("Non-fatal error updating linked user email:", err.message);
            }
        }
    }
    setField("dateOfBirth", parseDate);
    setField("residentialAddress");
    setField("city");
    setField("country");
    setField("emergencyName");
    setField("emergencyRelation");
    setField("emergencyPhone");
    setField("referenceName");
    setField("referenceRelation");
    setField("referencePhone");
    setField("referenceAddress");

    if (patch.nationalId !== undefined && patch.nationalId.trim()) {
        const existingNationalId = await Employee.findOne({
            workspace: employee.workspace,
            nationalId: patch.nationalId.trim(),
            _id: { $ne: employee._id },
        }).lean();
        if (existingNationalId) {
            throw ApiError.conflict(
                `An employee with National ID "${patch.nationalId.trim()}" already exists in this workspace.`
            );
        }
    }

    if (patch.workSchedule !== undefined || patch.workingHours !== undefined) {
        const raw = patch.workSchedule !== undefined ? patch.workSchedule : patch.workingHours;
        const pNum = parseFloat(raw) || 8;
        employee.workSchedule = `${pNum} ${pNum === 1 ? 'hour' : 'hours'}`;
        employee.workingHours = pNum;
    }

    setField("workSchedule");
    setField("workShift");
    setField("weeklyWorkingDays");
    setField("attendanceLocation");
    setField("attendanceMethod");
    setField("attendanceEligibility");
    setField("overtimeEligibility");
    setField("timeZone");

    if (patch.salaryAmount !== undefined && Number(patch.salaryAmount) !== Number(employee.salaryAmount)) {
        if (!Array.isArray(employee.salaryHistory)) {
            employee.salaryHistory = [];
        }
        employee.salaryHistory.unshift({
            effectiveDate: new Date(),
            previousSalary: Number(employee.salaryAmount),
            newSalary: Number(patch.salaryAmount),
            currency: workspace.currency || employee.salaryCurrency || "USD",
            changeReason: patch.salaryChangeReason || "Compensation Revision",
            changedBy: caller?.fullName || "HR Department",
            createdAt: new Date(),
        });
    }

    setField("salaryAmount", (v) => Number(v));
    setField("salaryCurrency");
    setField("payFrequency");
    setField("bankAccountName");
    setField("bankAccountNumber");
    setField("bankName");
    setField("taxIdentifier");
    setField("payrollGroup");

    setField("confidentialNotes");
    setField("backgroundCheckStatus");

    setField("nationalId");
    setField("createLogin");
    setField("loginEmail");
    setField("systemRole");
    setField("sendInvitation");

    setField("education");
    setField("experience");
    setField("certificates");
    if (patch.permissions !== undefined) {
        const sanitizedPerms = sanitizeAssignedPermissions(patch.permissions, {
            hasFullAccess: callerHasFullAccess(caller, workspace),
            workspace,
        });
        employee.permissions = sanitizedPerms;
    }

    await employee.save();

    // If work arrangement is or was changed to Remote, automatically ensure remote attendance for today
    if (employee.workArrangement && /remote/i.test(employee.workArrangement)) {
        try {
            const { autoMarkRemoteAttendanceForWorkspace } = await import("../attendance/attendance.service.js");
            await autoMarkRemoteAttendanceForWorkspace(workspace._id);
        } catch {}
    }

    // Sync permissions and system role to linked User if exists
    if (employee.linkedUser && (patch.permissions !== undefined || patch.systemRole !== undefined)) {
        try {
            const userUpdate = {};
            if (patch.permissions !== undefined) userUpdate.permissions = employee.permissions;
            if (patch.systemRole !== undefined) {
                userUpdate.systemRole = patch.systemRole;
                userUpdate.role = patch.systemRole;
            }
            await User.updateOne({ _id: employee.linkedUser }, { $set: userUpdate });
        } catch (syncErr) {
            console.error("Non-fatal error syncing user permissions:", syncErr);
        }
    }

    // Check if status transitioned to Resigned, Terminated, Suspended, or Active
    if (patch.employmentStatus !== undefined && patch.employmentStatus !== previousEmploymentStatus) {
        const isRevoked = ["Terminated", "Resigned", "Suspended"].includes(employee.employmentStatus);
        const isNowActive = employee.employmentStatus === "Active";

        employee.isActive = isNowActive || ["Probation", "On Leave"].includes(employee.employmentStatus);

        try {
            const { User } = await import("../../model/auth/auth.model.js");
            let targetUser = null;
            if (employee.linkedUser) {
                targetUser = await User.findById(employee.linkedUser);
            }
            if (!targetUser && employee.loginEmail) {
                targetUser = await User.findOne({ email: employee.loginEmail.toLowerCase().trim() });
            }
            if (!targetUser && employee.workEmail) {
                targetUser = await User.findOne({ email: employee.workEmail.toLowerCase().trim() });
            }
            if (!targetUser && employee.personalEmail) {
                targetUser = await User.findOne({ email: employee.personalEmail.toLowerCase().trim() });
            }

            if (targetUser) {
                if (!employee.linkedUser) {
                    employee.linkedUser = targetUser._id;
                }

                if (isRevoked) {
                    // Revoke system access: preserve email, remove password, invalidate sessions & tokens
                    await User.updateOne(
                        { _id: targetUser._id },
                        {
                            $set: {
                                status: employee.employmentStatus === "Suspended" ? "suspended" : "inactive",
                                activeSessions: [],
                                tokenVersion: (targetUser.tokenVersion || 0) + 1,
                            },
                            $unset: { password: "" },
                        }
                    );
                } else if (isNowActive) {
                    // Re-hiring / re-activating:
                    // Set user status to 'pending' so resending the invitation allows employee to set password again
                    await User.updateOne(
                        { _id: targetUser._id },
                        {
                            $set: {
                                status: "pending",
                                activeSessions: [],
                                tokenVersion: (targetUser.tokenVersion || 0) + 1,
                            },
                        }
                    );
                    employee.createLogin = true;
                    employee.sendInvitation = false;
                }
            }
        } catch (userErr) {
            console.error("Non-fatal user status sync error:", userErr);
        }

        await employee.save();

        if (
            ["Resigned", "Terminated", "Inactive", "Suspended"].includes(employee.employmentStatus) &&
            !["Resigned", "Terminated", "Inactive", "Suspended"].includes(previousEmploymentStatus)
        ) {
            await notifyManagerResignationIfNeeded(workspace._id, employee);
        }

        // Automatic payroll adjustment when employee status changes
        try {
            const { PayrollBatch } = await import("../../model/payroll/payrollBatch.model.js");
            const draftBatches = await PayrollBatch.find({
                workspace: workspace._id,
                status: "draft",
            });
            for (const batch of draftBatches) {
                if (["Terminated", "Resigned", "Inactive", "Suspended"].includes(employee.employmentStatus)) {
                    batch.entries = batch.entries.filter(
                        (entry) => entry.employee?.toString() !== employee._id.toString() &&
                                   entry.employeeId !== employee.employeeId
                    );
                    batch.totalEmployees = batch.entries.length;
                    batch.totalGross = batch.entries.reduce((acc, curr) => acc + (curr.grossPay || 0), 0);
                    batch.totalNet = batch.entries.reduce((acc, curr) => acc + (curr.netPay || 0), 0);
                    batch.totalDeductions = batch.entries.reduce((acc, curr) => acc + (curr.totalDeductions || 0), 0);
                    await batch.save();
                } else if (["Active", "Probation", "On Leave"].includes(employee.employmentStatus)) {
                    const { generatePayrollBatch } = await import("../payroll/payroll.service.js");
                    await generatePayrollBatch(userId, {
                        month: batch.month,
                        payFrequency: batch.payFrequency || "Monthly",
                    }).catch(() => {});
                }
            }
        } catch (payrollSyncErr) {
            console.error("Non-fatal payroll sync error on status change:", payrollSyncErr.message);
        }
    }

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

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: caller?.fullName,
            actorRole: isCEO ? "CEO" : "HR",
            action: "employee.update",
            module: "Employees",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Updated profile details for ${employee.firstName} ${employee.lastName} (${employee.employeeId})`,
            details: {
                fieldsModified: Object.keys(patch).filter((k) => k !== "removedDocumentIds"),
            },
        });
    } catch {}

    return { employee, removedDocumentCount };
}

export async function listCorrectionRequests(userId, options = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    let filter = { workspace: workspace._id };
    if (options.status && options.status !== "all") {
        filter.status = options.status;
    }
    if (options.requestType && options.requestType !== "all") {
        filter.requestType = options.requestType;
    }
    if (isManager && !isCEO && !isHR) {
        filter.requestedBy = userId;
    }

    const requests = await EmployeeCorrectionRequest.find(filter)
        .sort({ createdAt: -1 })
        .lean();

    return requests.map((r) => ({
        ...r,
        id: r._id.toString(),
        createdAt: toIsoStringSafe(r.createdAt),
        updatedAt: toIsoStringSafe(r.updatedAt),
        reviewedAt: toIsoStringSafe(r.reviewedAt),
    }));
}

export async function requestAttendanceUpdate(userId, idOrEmployeeId, data = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const isSelf = Boolean(
        (callerEmployee && callerEmployee._id?.toString() === employee._id.toString()) ||
        (caller?._id && employee.user && caller._id.toString() === employee.user.toString()) ||
        (caller?.email && (caller.email.toLowerCase() === (employee.workEmail || "").toLowerCase() || caller.email.toLowerCase() === (employee.personalEmail || "").toLowerCase()))
    );

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request attendance updates for employees reporting to them.");
        }
    }

    if (isHR && !isCEO) {
        if (!isSelf) {
            throw ApiError.forbidden("HR can only request attendance corrections for themselves to the CEO. For other employees, HR has administrative authority to directly mark attendance.");
        }
    }

    if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(data.date).trim())) {
        throw ApiError.badRequest("Valid date (YYYY-MM-DD) is required.");
    }
    const date = String(data.date).trim();

    const todayStr = getDateInTimezone(new Date(), workspace.timezone);
    if (date > todayStr) {
        throw ApiError.badRequest(`Cannot request attendance updates for upcoming or future dates (today is ${todayStr}).`);
    }

    const allowedStatuses = ["present", "late", "half-day", "absent", "remote", "on-leave"];
    const status = String(data.status || "present").toLowerCase().trim();
    if (!allowedStatuses.includes(status)) {
        throw ApiError.badRequest(`Invalid status. Allowed values: ${allowedStatuses.join(", ")}`);
    }

    if (!data.reason || !String(data.reason).trim()) {
        throw ApiError.badRequest("Please provide a reason / justification for the attendance update request.");
    }
    const reason = String(data.reason).trim();

    // Look for existing attendance record for this date
    const existingRecord = await AttendanceRecord.findOne({
        workspace: workspace._id,
        employee: employee._id,
        date,
    }).lean();

    const patch = {
        date,
        status,
        checkIn: data.checkIn ? new Date(data.checkIn) : null,
        checkOut: data.checkOut ? new Date(data.checkOut) : null,
        reason,
    };

    const originalValues = {
        date,
        status: existingRecord?.status || "unmarked",
        checkIn: existingRecord?.checkIn || null,
        checkOut: existingRecord?.checkOut || null,
        hoursWorked: existingRecord?.hoursWorked || 0,
    };

    const request = await EmployeeCorrectionRequest.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        requestedBy: userId,
        requestedByName: caller.fullName || `${callerEmployee?.firstName || ""} ${callerEmployee?.lastName || ""}`.trim() || "Manager",
        requestedByRole: isManager ? "Manager" : (isHR ? "HR" : "CEO"),
        requestType: "attendance_update",
        patch,
        originalValues,
        reason,
        status: "pending",
    });

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "attendance_update_requested",
        label: `Attendance update for ${date} (${status}) requested by ${caller.fullName || "Manager"}: ${reason}`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const targetRecipients = isHR && !isCEO
            ? await getOperationalReviewers(workspace, { excludeUserId: userId, forceCeo: true })
            : await getOperationalReviewers(workspace, { excludeUserId: userId });

        for (const recipient of targetRecipients) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Attendance Update Request",
                    message: isHR && !isCEO
                        ? `${caller.fullName || "HR"} requested attendance update for themselves on ${date} (Status: ${status}). Awaiting review by CEO.`
                        : `${caller.fullName || "Manager"} requested attendance update for ${employee.firstName} ${employee.lastName} on ${date} (Status: ${status}). Reason: ${reason}`,
                    type: "attendance_update",
                    link: `/employees/${employee.employeeId}`,
                    metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
                });
            }
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error:", notifErr);
    }

    return { success: true, request };
}

export async function requestEmployeePromotion(userId, idOrEmployeeId, data) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request promotions for employees reporting to them.");
        }
    }

    if (!data.designation && !data.salaryAmount && !data.department) {
        throw ApiError.badRequest("Please specify at least a new designation, department, or proposed salary amount.");
    }

    const patch = {
        designation: data.designation ? data.designation.trim() : employee.designation,
        department: data.department ? data.department.trim() : employee.department,
        salaryAmount: data.salaryAmount !== undefined && data.salaryAmount !== null && data.salaryAmount !== ""
            ? Number(data.salaryAmount)
            : employee.salaryAmount,
        effectiveDate: data.effectiveDate ? new Date(data.effectiveDate) : new Date(),
        reason: data.reason ? data.reason.trim() : "",
    };

    const originalValues = {
        designation: employee.designation,
        department: employee.department,
        salaryAmount: employee.salaryAmount,
    };

    const request = await EmployeeCorrectionRequest.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        requestedBy: userId,
        requestedByName: caller.fullName || "Manager",
        requestedByRole: isManager ? "Manager" : "HR",
        requestType: "promotion_increment",
        patch,
        originalValues,
        reason: data.reason || "",
        status: "pending",
    });

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "promotion_requested",
        label: `Promotion and salary increment requested by ${caller.fullName || "Manager"}: Proposed ${patch.designation} (${patch.department})`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const hrAndCeoUsers = await getOperationalReviewers(workspace, { excludeUserId: userId });

        for (const recipient of hrAndCeoUsers) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Promotion & Increment Request",
                    message: `${caller.fullName || "Manager"} submitted a promotion and increment request for ${employee.firstName} ${employee.lastName} (Proposed: ${patch.designation}).`,
                    type: "employee_update",
                    link: `/employees/${employee.employeeId}`,
                    metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
                });
            }
        }
    } catch (e) {
        console.error("Non-fatal notification error:", e);
    }

    return { success: true, request };
}

export async function requestDocumentDeletion(userId, idOrEmployeeId, fileId, reason = "") {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);
    const doc = (employee.documents || []).find((d) => d.fileId === fileId);
    if (!doc) {
        throw ApiError.notFound("Document not found");
    }

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request document deletion for employees reporting to them.");
        }
        if (!isDocumentAllowedForManager(doc)) {
            throw ApiError.forbidden("Managers cannot request deletion of confidential documents.");
        }
    }

    const request = await EmployeeCorrectionRequest.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        requestedBy: userId,
        requestedByName: caller.fullName || "Manager",
        requestedByRole: "Manager",
        requestType: "document_deletion",
        patch: {
            fileId: doc.fileId,
            fileName: doc.fileName,
            label: doc.label,
            reason: reason ? reason.trim() : "",
        },
        originalValues: {
            fileName: doc.fileName,
            label: doc.label,
        },
        reason: reason ? reason.trim() : "",
        status: "pending",
    });

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "doc_deletion_requested",
        label: `Document deletion requested by ${caller.fullName || "Manager"}: "${doc.label}" (${reason || "No reason given"})`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const hrAndCeoUsers = await getOperationalReviewers(workspace, { excludeUserId: userId });

        for (const recipient of hrAndCeoUsers) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Document Deletion Request",
                    message: `${caller.fullName || "Manager"} requested deletion of document "${doc.label}" for ${employee.firstName} ${employee.lastName}.`,
                    type: "employee_update",
                    link: `/employees/${employee.employeeId}`,
                    metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
                });
            }
        }
    } catch (e) {
        console.error("Non-fatal notification error:", e);
    }

    return { success: true, request };
}

export async function requestEmployeeDeletion(userId, idOrEmployeeId, data = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    if (isManager && !isCEO && !isHR) {
        if (!isEmployeeDirectReport(employee, caller, callerEmployee)) {
            throw ApiError.forbidden("Managers can only request deletion of employees reporting to them.");
        }
    }

    const request = await EmployeeCorrectionRequest.create({
        workspace: workspace._id,
        employee: employee._id,
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`.trim(),
        requestedBy: userId,
        requestedByName: caller.fullName || "Manager",
        requestedByRole: "Manager",
        requestType: "employee_deletion",
        patch: {
            reason: data.reason ? data.reason.trim() : "Offboarding requested",
            lastWorkingDate: data.lastWorkingDate ? new Date(data.lastWorkingDate) : null,
            notes: data.notes ? data.notes.trim() : "",
        },
        originalValues: {
            employmentStatus: employee.employmentStatus,
        },
        reason: data.reason ? data.reason.trim() : "Offboarding requested",
        status: "pending",
    });

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "deletion_requested",
        label: `Employee deletion / offboard requested by ${caller.fullName || "Manager"}: ${data.reason || "Offboarding"}`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const hrAndCeoUsers = await getOperationalReviewers(workspace, { excludeUserId: userId });

        for (const recipient of hrAndCeoUsers) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Employee Deletion Request",
                    message: `${caller.fullName || "Manager"} requested deletion / offboarding for ${employee.firstName} ${employee.lastName}.`,
                    type: "employee_update",
                    link: `/employees/${employee.employeeId}`,
                    metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
                });
            }
        }
    } catch (e) {
        console.error("Non-fatal notification error:", e);
    }

    return { success: true, request };
}

export async function approveCorrectionRequest(userId, requestId, options = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, isCEO, isHR } = await getCallerRoleContext(userId, workspace);

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR and CEO can verify and approve employee requests.");
    }

    if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }

    const request = await EmployeeCorrectionRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!request) throw ApiError.notFound("Correction request not found");
    if (request.status !== "pending") {
        throw ApiError.badRequest(`This correction request is already ${request.status}`);
    }

    if (request.requestedByRole === "HR" && !isCEO) {
        throw ApiError.forbidden("HR attendance requests can only be verified and approved by the CEO.");
    }

    const employee = await Employee.findOne({
        _id: request.employee,
        workspace: workspace._id,
    });
    if (!employee && request.requestType !== "employee_deletion") {
        throw ApiError.notFound("Employee not found");
    }

    const selectedFields = Array.isArray(options.selectedFields) && options.selectedFields.length > 0
        ? options.selectedFields
        : null;

    // 0. Handle attendance update request
    if (request.requestType === "attendance_update") {
        const patch = request.patch || {};
        const targetDate = patch.date;
        const todayStr = getDateInTimezone(new Date(), workspace.timezone);
        if (targetDate && targetDate > todayStr) {
            throw ApiError.badRequest(`Cannot approve attendance update for upcoming or future dates (target date is ${targetDate}, today is ${todayStr}).`);
        }
        const targetStatus = patch.status || "present";
        const reqHours = Number(employee.workingHours) || 8;
        const isAbsentLike = ["absent", "on-leave", "holiday", "weekend", "unmarked"].includes(String(targetStatus).toLowerCase().trim());

        let checkInDate = (!isAbsentLike && patch.checkIn) ? new Date(patch.checkIn) : null;
        let checkOutDate = (!isAbsentLike && patch.checkOut) ? new Date(patch.checkOut) : null;
        if (checkInDate && isNaN(checkInDate.getTime())) checkInDate = null;
        if (checkOutDate && isNaN(checkOutDate.getTime())) checkOutDate = null;

        const dummyRec = {
            status: targetStatus,
            checkIn: checkInDate,
            checkOut: checkOutDate,
            requiredHours: reqHours,
            hoursWorked: 0,
        };
        const hoursWorked = isAbsentLike ? 0 : calculateRecordHours(dummyRec, reqHours);

        let rec = await AttendanceRecord.findOne({
            workspace: workspace._id,
            employee: employee._id,
            date: targetDate,
        });

        if (!rec) {
            rec = new AttendanceRecord({
                workspace: workspace._id,
                employee: employee._id,
                date: targetDate,
                status: targetStatus,
                source: "manual",
                markedBy: userId,
                checkIn: checkInDate,
                checkOut: checkOutDate,
                requiredHours: reqHours,
                hoursWorked,
                shortHours: 0,
                deductionAmount: 0,
                earnedSalary: 0,
                note: `Approved manager request by ${request.requestedByName}${request.reason ? `: ${request.reason}` : ""}`.trim(),
            });
        } else {
            rec.status = targetStatus;
            rec.source = "manual";
            rec.markedBy = userId;
            rec.checkIn = checkInDate;
            rec.checkOut = checkOutDate;
            rec.requiredHours = reqHours;
            rec.hoursWorked = hoursWorked;
            if (isAbsentLike) {
                rec.shortHours = 0;
                rec.deductionAmount = 0;
                rec.earnedSalary = 0;
            }
            rec.note = `Approved manager request by ${request.requestedByName}${request.reason ? `: ${request.reason}` : ""}`.trim();
        }

        await rec.save();

        request.status = "approved";
        request.approvedFields = ["status", "hoursWorked", "source"];
        request.reviewedBy = userId;
        request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
        request.reviewedAt = new Date();
        await request.save();

        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "attendance_update_approved",
            label: `Attendance update for ${targetDate} (${targetStatus}) requested by ${request.requestedByName} was approved by ${isCEO ? "CEO" : "HR"}.`,
        });

        try {
            const { createNotification } = await import("../notification/notification.service.js");
            await createNotification({
                workspaceId: workspace._id,
                recipientId: request.requestedBy,
                title: "Attendance Update Approved",
                message: `${isCEO ? "CEO" : "HR"} (${caller.fullName || "HR"}) approved your attendance update for ${employee.firstName} ${employee.lastName} on ${targetDate} (${targetStatus}).`,
                type: "attendance_update",
                link: `/employees/${employee.employeeId}`,
                metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
            });
        } catch (e) {
            console.error("Non-fatal notification error:", e);
        }

        return { success: true, employee, attendanceRecord: rec };
    }

    // 0.5 Handle leave cancellation request
    if (request.requestType === "leave_cancellation") {
        const { leaveId, reason, selectedDates, cancelAll } = request.patch || {};
        const { cancelApprovedLeaveInternal } = await import("../leave/leave.service.js");
        const { LeaveRequest } = await import("../../model/leave/leave.model.js");

        let leave = null;
        if (leaveId) {
            leave = await LeaveRequest.findOne({ _id: leaveId, workspace: workspace._id });
            if (leave && leave.status === "approved") {
                await cancelApprovedLeaveInternal(workspace, leave, caller, {
                    reason: reason || request.reason,
                    selectedDates,
                    cancelAll,
                });
            }
        }

        request.status = "approved";
        request.reviewedBy = userId;
        request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
        request.reviewedAt = new Date();
        await request.save();

        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "leave_cancellation_approved",
            label: `Leave cancellation requested by ${request.requestedByName} was approved by ${isCEO ? "CEO" : "HR"}. Days refunded.`,
        });

        try {
            const { createNotification } = await import("../notification/notification.service.js");
            await createNotification({
                workspaceId: workspace._id,
                recipientId: request.requestedBy,
                title: "Leave Cancellation Approved",
                message: `${isCEO ? "CEO" : "HR"} approved your leave cancellation request for ${employee.firstName} ${employee.lastName}. Days have been refunded to leave balance.`,
                type: "leave_status",
                link: `/employees/${employee.employeeId}`,
                metadata: { correctionRequestId: request._id.toString(), employeeId: employee.employeeId },
            });
        } catch (e) {
            console.error("Non-fatal notification error:", e);
        }

        return { success: true, employee, leave };
    }

    // 1. Handle document deletion request
    if (request.requestType === "document_deletion") {
        const docIndex = (employee.documents || []).findIndex((d) => d.fileId === request.patch.fileId);
        if (docIndex !== -1) {
            const doc = employee.documents[docIndex];
            const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
            try {
                await deleteEncryptedBlob(doc.s3Key);
            } catch (err) {
                console.warn(`[approveCorrectionRequest] S3 blob deletion warning: ${err.message}`);
            }
            employee.documents.splice(docIndex, 1);
            await employee.save();
        }

        request.status = "approved";
        request.reviewedBy = userId;
        request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
        request.reviewedAt = new Date();
        await request.save();

        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "document_removed",
            label: `Document deletion requested by ${request.requestedByName} was approved and deleted by ${isCEO ? "CEO" : "HR"}: "${request.patch.label}"`,
        });

        return { success: true, employee };
    }

    // 2. Handle employee deletion request
    if (request.requestType === "employee_deletion") {
        if (employee) {
            await notifyManagerResignationIfNeeded(workspace._id, employee);
            const { deleteEncryptedBlob } = await import("../storage/s3.service.js");
            for (const doc of employee.documents || []) {
                try {
                    await deleteEncryptedBlob(doc.s3Key);
                } catch {}
            }
            if (employee.linkedUser) {
                try {
                    const { User } = await import("../../model/auth/auth.model.js");
                    await User.deleteOne({ _id: employee.linkedUser });
                } catch {}
            }
            await Employee.deleteOne({ _id: employee._id });

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: isCEO ? "CEO" : "HR",
            actorRole: isCEO ? "CEO" : "HR",
            action: "employee.delete",
            module: "Employees",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Permanently deleted employee record for ${employee.firstName} ${employee.lastName} (${employee.employeeId})`,
            details: {
                employeeId: employee.employeeId,
                department: employee.department,
            },
        });
    } catch {}
        }

        request.status = "approved";
        request.reviewedBy = userId;
        request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
        request.reviewedAt = new Date();
        await request.save();

        return { success: true, deleted: true };
    }

    // 3. Handle promotion & increment request
    if (request.requestType === "promotion_increment") {
        const patch = request.patch || {};
        const shouldApply = (field) => !selectedFields || selectedFields.includes(field);

        const appliedFields = [];

        if (patch.designation && shouldApply("designation")) {
            employee.designation = patch.designation;
            appliedFields.push("designation");
        }
        if (patch.department && shouldApply("department")) {
            employee.department = patch.department;
            appliedFields.push("department");
        }
        if (patch.salaryAmount !== undefined && patch.salaryAmount !== null && shouldApply("salaryAmount")) {
            const prevSal = employee.salaryAmount || 0;
            employee.salaryAmount = Number(patch.salaryAmount);
            if (!Array.isArray(employee.salaryHistory)) employee.salaryHistory = [];
            employee.salaryHistory.push({
                effectiveDate: patch.effectiveDate ? new Date(patch.effectiveDate) : new Date(),
                previousSalary: prevSal,
                newSalary: Number(patch.salaryAmount),
                currency: employee.salaryCurrency || workspace.currency || "USD",
                changeReason: `Promotion to ${patch.designation || employee.designation}: ${patch.reason || "Approved manager promotion request"}`,
                changedBy: caller.fullName || (isCEO ? "CEO" : "HR"),
                createdAt: new Date(),
            });
            appliedFields.push("salaryAmount");
        }

        await employee.save();

        request.status = "approved";
        request.approvedFields = appliedFields;
        request.reviewedBy = userId;
        request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
        request.reviewedAt = new Date();
        await request.save();

        await EmployeeActivity.create({
            workspace: workspace._id,
            employee: employee._id,
            actor: userId,
            type: "promotion_approved",
            label: `Promotion & increment requested by ${request.requestedByName} was approved by ${isCEO ? "CEO" : "HR"} (${appliedFields.join(", ")})`,
        });

        return { success: true, employee, approvedFields: appliedFields };
    }

    // 4. Default: details_update request (with Granular field selection!)
    const patch = request.patch || {};
    const parseDate = (v) => {
        if (!v) return null;
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
    };

    const appliedFields = [];
    const setField = (key, transform) => {
        if (patch[key] === undefined) return;
        if (selectedFields && !selectedFields.includes(key)) return;
        const value = transform ? transform(patch[key]) : patch[key];
        employee[key] = value;
        appliedFields.push(key);
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
    setField("probationStatus");
    setField("probationEndDate", parseDate);
    setField("contractEndDate", parseDate);
    setField("employeeCategory");

    setField("personalEmail");
    setField("workEmail");
    if (patch.workEmail !== undefined && patch.workEmail.trim()) {
        const cleanWorkEmail = patch.workEmail.trim().toLowerCase();
        employee.workEmail = cleanWorkEmail;
        if (!employee.loginEmail) {
            employee.loginEmail = cleanWorkEmail;
        }
        if (employee.linkedUser) {
            try {
                const { User } = await import("../../model/auth/auth.model.js");
                await User.updateOne({ _id: employee.linkedUser }, { $set: { email: cleanWorkEmail } });
            } catch (err) {
                console.error("Non-fatal error updating linked user email:", err.message);
            }
        }
    }
    setField("dateOfBirth", parseDate);
    setField("residentialAddress");
    setField("city");
    setField("country");
    setField("emergencyName");
    setField("emergencyRelation");
    setField("emergencyPhone");
    setField("referenceName");
    setField("referenceRelation");
    setField("referencePhone");
    setField("referenceAddress");

    if (patch.nationalId !== undefined && patch.nationalId.trim() && (!selectedFields || selectedFields.includes("nationalId"))) {
        const existingNationalId = await Employee.findOne({
            workspace: employee.workspace,
            nationalId: patch.nationalId.trim(),
            _id: { $ne: employee._id },
        }).lean();
        if (existingNationalId) {
            throw ApiError.conflict(
                `An employee with National ID "${patch.nationalId.trim()}" already exists in this workspace.`
            );
        }
        employee.nationalId = patch.nationalId.trim();
        appliedFields.push("nationalId");
    }

    if ((patch.workSchedule !== undefined || patch.workingHours !== undefined) && (!selectedFields || selectedFields.includes("workSchedule") || selectedFields.includes("workingHours"))) {
        const raw = patch.workSchedule !== undefined ? patch.workSchedule : patch.workingHours;
        const pNum = parseFloat(raw) || 8;
        employee.workSchedule = `${pNum} ${pNum === 1 ? 'hour' : 'hours'}`;
        employee.workingHours = pNum;
        appliedFields.push("workingHours");
    }

    setField("workShift");
    setField("weeklyWorkingDays");
    setField("attendanceLocation");
    setField("attendanceMethod");
    setField("attendanceEligibility");
    setField("overtimeEligibility");

    setField("salaryAmount", (v) => Number(v));
    setField("salaryCurrency");
    setField("payFrequency");
    setField("bankAccountName");
    setField("bankAccountNumber");
    setField("bankName");
    setField("taxIdentifier");
    setField("payrollGroup");

    await employee.save();

    // Check if status transitioned to Resigned, Terminated, or Inactive
    if (
        appliedFields.includes("employmentStatus") &&
        ["Resigned", "Terminated", "Inactive"].includes(employee.employmentStatus)
    ) {
        await notifyManagerResignationIfNeeded(workspace._id, employee);
    }

    request.status = "approved";
    request.approvedFields = appliedFields;
    request.reviewedBy = userId;
    request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
    request.reviewedAt = new Date();
    await request.save();

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "correction_approved",
        label: `Details correction requested by ${request.requestedByName} was approved by ${isCEO ? "CEO" : "HR"} (${appliedFields.length} field(s) applied: ${appliedFields.join(", ")})`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        await createNotification({
            workspaceId: workspace._id,
            recipientId: request.requestedBy,
            title: "Employee Correction Approved",
            message: `${isCEO ? "CEO" : "HR"} (${caller.fullName || "HR"}) approved your details correction for ${employee.firstName} ${employee.lastName}. (${appliedFields.length} field(s) updated).`,
            type: "employee_update",
            link: `/employees/${employee.employeeId}`,
        });
    } catch (e) {
        console.error("Non-fatal notification error:", e);
    }

    return { success: true, employee, approvedFields: appliedFields };
}

export async function rejectCorrectionRequest(userId, requestId, reason = "") {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, isCEO, isHR } = await getCallerRoleContext(userId, workspace);

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR and CEO can reject employee corrections.");
    }

    if (isCEO && !isHR && workspace.ceoFullControlWithHr === false) {
        const { checkWorkspaceHasHR } = await import("../workspace/workspace.service.js");
        const hasHR = await checkWorkspaceHasHR(workspace._id, workspace.owner);
        if (hasHR) {
            throw ApiError.forbidden("HR delegation is active and CEO operational override is disabled. Operational actions are managed by HR.");
        }
    }

    const request = await EmployeeCorrectionRequest.findOne({
        _id: requestId,
        workspace: workspace._id,
    });
    if (!request) throw ApiError.notFound("Correction request not found");
    if (request.status !== "pending") {
        throw ApiError.badRequest(`This correction request is already ${request.status}`);
    }

    if (request.requestedByRole === "HR" && !isCEO) {
        throw ApiError.forbidden("HR attendance requests can only be verified and approved by the CEO.");
    }

    request.status = "rejected";
    request.reviewedBy = userId;
    request.reviewedByName = caller.fullName || (isCEO ? "CEO" : "HR");
    request.reviewedAt = new Date();
    request.rejectionReason = reason;
    await request.save();

    const reqTypeLabel =
        request.requestType === "attendance_update"
            ? "Attendance update"
            : request.requestType === "leave_cancellation"
            ? "Leave cancellation"
            : "Details correction";
    const activityType =
        request.requestType === "attendance_update"
            ? "attendance_update_rejected"
            : request.requestType === "leave_cancellation"
            ? "leave_cancellation_rejected"
            : "correction_rejected";

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: request.employee,
        actor: userId,
        type: activityType,
        label: `${reqTypeLabel} requested by ${request.requestedByName} was rejected by ${isCEO ? "CEO" : "HR"}: ${reason || "No reason given"}`,
    });

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        const notifTitle =
            request.requestType === "attendance_update"
                ? "Attendance Update Rejected"
                : request.requestType === "leave_cancellation"
                ? "Leave Cancellation Rejected"
                : "Employee Correction Rejected";
        const notifType =
            request.requestType === "attendance_update"
                ? "attendance_update"
                : request.requestType === "leave_cancellation"
                ? "leave_status"
                : "employee_update";

        await createNotification({
            workspaceId: workspace._id,
            recipientId: request.requestedBy,
            title: notifTitle,
            message: `${isCEO ? "CEO" : "HR"} (${caller.fullName || "HR"}) rejected your ${reqTypeLabel.toLowerCase()} for ${request.employeeName}.${reason ? ` Reason: ${reason}` : ""}`,
            type: notifType,
            link: `/employees/${request.employeeId}`,
        });
    } catch (e) {
        console.error("Non-fatal notification error:", e);
    }

    return { success: true, request };
}

/**
 * Bulk import employees from XLSX, CSV, or JSON without altering schema.
 */
export async function bulkImportEmployees(userId, { fileBuffer, fileMime, fileName, rawRecords }) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);
    if (isManager) {
        throw ApiError.forbidden("Managers cannot import employees. Only HR can perform bulk employee imports.");
    }
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    let records = [];

    if (Array.isArray(rawRecords) && rawRecords.length > 0) {
        records = rawRecords;
    } else if (fileBuffer) {
        const isJson = (fileMime && fileMime.includes("json")) || (fileName && fileName.endsWith(".json"));
        if (isJson) {
            try {
                const parsed = JSON.parse(fileBuffer.toString("utf8"));
                records = Array.isArray(parsed) ? parsed : (parsed.employees || [parsed]);
            } catch (err) {
                throw ApiError.badRequest("Invalid JSON format in uploaded file: " + err.message);
            }
        } else {
            // Excel (.xlsx, .xls) or CSV
            const xlsx = await import("xlsx");
            const workbook = xlsx.read(fileBuffer, { type: "buffer" });
            const sheetName = workbook.SheetNames[0];
            if (!sheetName) throw ApiError.badRequest("No sheets found in uploaded spreadsheet.");
            const sheet = workbook.Sheets[sheetName];
            records = xlsx.utils.sheet_to_json(sheet);
        }
    }

    if (!Array.isArray(records) || records.length === 0) {
        throw ApiError.badRequest("No employee records found to import.");
    }

    // Enforce plan-specific employee headcount ceiling across single and bulk imports
    await assertEmployeeQuota(workspace._id, records.length);

    const createdEmployees = [];
    const errors = [];

    for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const rowNum = i + 1;
        try {
            const rawFirstName = row.firstName || row["First Name"] || row["First name"] || row.name?.split(" ")[0];
            const rawLastName = row.lastName || row["Last Name"] || row["Last name"] || row.name?.split(" ").slice(1).join(" ") || "";
            const firstName = (rawFirstName ? String(rawFirstName) : `Staff_${rowNum}`).trim();
            const lastName = (rawLastName ? String(rawLastName) : "").trim();
            const phone = String(row.phone || row["Phone"] || row["Phone Number"] || row.phoneNumber || "000-000-0000").trim();
            const personalEmail = String(row.personalEmail || row.email || row["Email"] || row["Personal Email"] || row["Work Email"] || row.workEmail || "").trim().toLowerCase();
            const department = String(row.department || row["Department"] || "General").trim();
            const designation = String(row.designation || row["Designation"] || row["Job Title"] || row["Job title"] || row.title || "Employee").trim();
            const branch = String(row.branch || row["Branch"] || row.workLocation || row["Work Location"] || "Main Office").trim();
            const reportingManager = String(row.reportingManager || row["Reporting Manager"] || "").trim();
            const systemRole = String(row.systemRole || row["System Role"] || row["System role"] || row["Role"] || row["Role in Organization"] || "Employee").trim();
            const salaryAmount = Number(row.salaryAmount || row.basicSalary || row["Basic Salary"] || row.salary || row["Salary"] || 50000);
            const empCurrency = String(row.salaryCurrency || row.currency || row["Salary Currency"] || row["Currency"] || workspace.currency || "USD").trim().toUpperCase();
            const payFrequency = String(row.payFrequency || row["Pay Frequency"] || "Monthly").trim();
            const rawNationalId = row.nationalId || row["National ID"] || row["CNIC"] || row["National Id"] || row.cnic || "";
            const nationalId = String(rawNationalId === "HIDDEN" ? "" : rawNationalId).trim();

            let employeeId = String(row.employeeId || row["Employee ID"] || "").trim();
            if (employeeId) {
                const existing = await Employee.findOne({ workspace: workspace._id, employeeId }).lean();
                if (existing) {
                    employeeId = await nextEmployeeId(workspace._id, { commit: true, department, branch });
                }
            } else {
                employeeId = await nextEmployeeId(workspace._id, { commit: true, department, branch });
            }

            const rawJoiningDate = row.joiningDate || row["Joining Date"] || row["Joining date"];
            const joiningDate = rawJoiningDate ? (parseDate(rawJoiningDate) || new Date()) : new Date();

            const emp = new Employee({
                workspace: workspace._id,
                employeeId,
                firstName,
                lastName,
                phone,
                preferredName: String(row.preferredName || "").trim(),
                gender: String(row.gender || "").trim(),
                employmentStatus: String(row.employmentStatus || row["Employment Status"] || row.status || row["Status"] || "Active").trim(),
                employmentType: String(row.employmentType || row["Employment Type"] || row.type || row["Type"] || "Full Time").trim(),
                designation,
                department,
                branch,
                workLocation: branch,
                reportingManager,
                joiningDate,
                personalEmail,
                workingHours: Number(row.workingHours || row["Working Hours"] || 8),
                salaryAmount: isNaN(salaryAmount) ? 50000 : salaryAmount,
                salaryCurrency: empCurrency,
                currency: empCurrency,
                payFrequency: ["Monthly", "Semi-Monthly", "Bi-Weekly", "Weekly"].includes(payFrequency) ? payFrequency : "Monthly",
                systemRole: ["Admin", "Manager", "HR", "Employee", "Viewer", "Custom"].includes(systemRole) ? systemRole : "Employee",
                nationalId,
            });

            await emp.save();
            createdEmployees.push({ id: emp._id, employeeId: emp.employeeId, name: `${emp.firstName} ${emp.lastName}`.trim() });
        } catch (err) {
            errors.push({ row: rowNum, error: err.message });
        }
    }

    return {
        successCount: createdEmployees.length,
        failedCount: errors.length,
        totalProcessed: records.length,
        createdEmployees,
        errors,
    };
}

/**
 * Export employees to CSV, XLSX, or JSON.
 */
export async function exportEmployees(userId, { format = "csv", department, branch, status, q } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { caller, callerEmployee, isCEO, isHR, isManager } = await getCallerRoleContext(userId, workspace);

    const baseFilter = {
        workspace: workspace._id,
        isDeleted: { $ne: true },
    };

    if (isManager && !isCEO && !isHR) {
        const teamFilter = buildManagerDirectReportsMongoFilter(workspace._id, caller, callerEmployee, { includeSelf: false });
        Object.assign(baseFilter, teamFilter);
    }

    if (status) {
        baseFilter.employmentStatus = status;
    }
    if (department) {
        baseFilter.department = department;
    }
    if (branch) {
        baseFilter.branch = branch;
    }
    if (q) {
        const regex = new RegExp(escapeRegexSafe(q.trim()), "i");
        baseFilter.$or = [
            { firstName: regex },
            { lastName: regex },
            { employeeId: regex },
            { loginEmail: regex },
            { personalEmail: regex },
        ];
    }

    const employees = await Employee.find(baseFilter).sort({ createdAt: -1 }).lean();
    const isManagerUser = Boolean(isManager && !isCEO && !isHR);

    const data = employees.map((emp) => {
        const basic = Number(emp.salaryAmount) || 0;
        const empCurrency = (emp.salaryCurrency || emp.currency || workspace.currency || "USD").toUpperCase();
        const joiningDateStr = emp.joiningDate
            ? (emp.joiningDate instanceof Date ? emp.joiningDate.toISOString().slice(0, 10) : String(emp.joiningDate).slice(0, 10))
            : "";

        return {
            "Employee ID": emp.employeeId || "",
            "First Name": emp.firstName || "",
            "Last Name": emp.lastName || "",
            "Email": emp.loginEmail || emp.personalEmail || "",
            "Phone Number": emp.phone || "",
            "Department": emp.department || "",
            "Designation": emp.designation || "",
            "Branch": emp.branch || emp.workLocation || "",
            "Employment Status": emp.employmentStatus || "Active",
            "Employment Type": emp.employmentType || "Full Time",
            "Reporting Manager": emp.reportingManager || "",
            "System Role": emp.systemRole || "Employee",
            "Basic Salary": basic,
            "Gross Salary": Number(emp.grossSalary ?? basic) || basic,
            "Net Salary": Number(emp.netSalary ?? basic) || basic,
            "Currency": empCurrency,
            "Pay Frequency": emp.payFrequency || "Monthly",
            "Joining Date": joiningDateStr,
            "National ID": isManagerUser ? "HIDDEN" : (emp.nationalId || ""),
        };
    });

    const fmt = String(format).toLowerCase();

    if (fmt === "json") {
        return {
            buffer: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
            contentType: "application/json; charset=utf-8",
            filename: `employees-export-${new Date().toISOString().slice(0, 10)}.json`,
        };
    }

    const XLSX = (await import("xlsx")).default || (await import("xlsx"));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Employees");

    if (fmt === "xlsx") {
        const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        return {
            buffer,
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename: `employees-export-${new Date().toISOString().slice(0, 10)}.xlsx`,
        };
    }

    // Default to CSV
    const rawCsv = XLSX.utils.sheet_to_csv(ws);
    // Neutralize formula injection triggers on exported cells when opened in Excel/Sheets
    const csvString = rawCsv
        .split(/\r?\n/)
        .map((line) =>
            line
                .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
                .map((cell) => {
                    const stripped = cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
                    const safe = String(sanitizeCsvCell(stripped));
                    return safe.includes(",") || safe.includes('"') || safe.includes("\n")
                        ? `"${safe.replace(/"/g, '""')}"`
                        : safe;
                })
                .join(",")
        )
        .join("\n");
    return {
        buffer: Buffer.from(csvString, "utf8"),
        contentType: "text/csv; charset=utf-8",
        filename: `employees-export-${new Date().toISOString().slice(0, 10)}.csv`,
    };
}

/**
 * Retrieves all eligible managers in the workspace, along with their active direct reports,
 * direct report counts, and unassigned/orphaned employee counts.
 */
export async function getWorkspaceManagers(userId) {
    const workspace = await getWorkspaceOrThrow(userId);

    const allEmployees = await Employee.find({
        workspace: workspace._id,
        employmentStatus: { $ne: "Terminated" },
    }).select("_id employeeId firstName lastName designation department avatar systemRole employmentStatus reportingManager linkedUser loginEmail personalEmail").lean();

    // 1. Resolve CEO User (from workspace.owner or userId)
    let ceoUser = null;
    if (workspace.owner) {
        ceoUser = await User.findById(workspace.owner).select("_id fullName email role systemRole avatar").lean();
    }
    if (!ceoUser) {
        ceoUser = await User.findById(userId).select("_id fullName email role systemRole avatar").lean();
    }

    const isLeader = (emp) => {
        if (!emp) return false;
        const role = String(emp.systemRole || "").toLowerCase();
        const desig = String(emp.designation || "").toLowerCase();
        const isCEO = /ceo|founder|chief executive|administrator|admin/.test(role) || /ceo|founder|chief executive/.test(desig);
        const isHR = /hr/.test(role) || /hr|human resource/.test(desig);
        const isMgr = /manager/.test(role) || /manager|lead|director|head|supervisor|vp|president/.test(desig);
        return isCEO || isHR || isMgr;
    };

    const candidateManagers = [];
    const candidateIds = new Set();
    const managerReportsMap = new Map();

    // 2. Add CEO to candidates if not already present as an employee
    let syntheticCeoManager = null;
    if (ceoUser) {
        const ceoInEmps = allEmployees.find((e) =>
            (e.linkedUser && e.linkedUser.toString() === ceoUser._id.toString()) ||
            (ceoUser.email && ((e.loginEmail || "").toLowerCase() === ceoUser.email.toLowerCase() || (e.personalEmail || "").toLowerCase() === ceoUser.email.toLowerCase())) ||
            (ceoUser.fullName && `${e.firstName} ${e.lastName}`.trim().toLowerCase() === ceoUser.fullName.trim().toLowerCase())
        );

        if (!ceoInEmps) {
            syntheticCeoManager = {
                _id: `user-${ceoUser._id}`,
                employeeId: "CEO",
                firstName: (ceoUser.fullName || "CEO").split(" ")[0] || "CEO",
                lastName: (ceoUser.fullName || "").split(" ").slice(1).join(" ") || "",
                designation: "CEO",
                department: "Executive",
                avatar: ceoUser.avatar || "",
                systemRole: "Admin",
                employmentStatus: "Active",
                isCEO: true,
            };
            candidateManagers.push(syntheticCeoManager);
            candidateIds.add(syntheticCeoManager._id.toString());
            managerReportsMap.set(syntheticCeoManager._id.toString(), []);
        }
    }

    // 3. Add eligible leader employees (strictly Managers, HR, and CEO)
    for (const emp of allEmployees) {
        if (isLeader(emp)) {
            candidateManagers.push(emp);
            candidateIds.add(emp._id.toString());
            managerReportsMap.set(emp._id.toString(), []);
        }
    }

    let unassignedCount = 0;
    const unassignedEmployees = [];

    for (const emp of allEmployees) {
        // Exclude CEO or workspace owner from needing a manager
        const isExec = /ceo|founder|chief executive/i.test(emp.designation || "") || (workspace.owner && emp.linkedUser && workspace.owner.toString() === emp.linkedUser.toString());
        if (isExec) continue;

        const rep = (emp.reportingManager || "").trim();
        if (!rep) {
            unassignedCount++;
            unassignedEmployees.push({
                _id: emp._id,
                employeeId: emp.employeeId,
                name: `${emp.firstName} ${emp.lastName}`.trim(),
                designation: emp.designation,
                department: emp.department,
                avatar: emp.avatar,
                employmentStatus: emp.employmentStatus,
                reportingManager: "Unassigned",
            });
            continue;
        }

        const isReportingToCeo = /none|reports to ceo|direct to ceo/i.test(rep) || (ceoUser?.fullName && rep.toLowerCase().includes(ceoUser.fullName.toLowerCase())) || /ceo/i.test(rep);

        if (isReportingToCeo && syntheticCeoManager) {
            const reports = managerReportsMap.get(syntheticCeoManager._id.toString()) || [];
            reports.push({
                _id: emp._id,
                employeeId: emp.employeeId,
                name: `${emp.firstName} ${emp.lastName}`.trim(),
                designation: emp.designation,
                department: emp.department,
                avatar: emp.avatar,
                employmentStatus: emp.employmentStatus,
            });
            managerReportsMap.set(syntheticCeoManager._id.toString(), reports);
            continue;
        }

        let assignedToAny = false;
        for (const cand of allEmployees) {
            if (cand._id.toString() === emp._id.toString()) continue;
            if (!isLeader(cand)) continue; // STRICTLY ONLY MANAGERS, HR, AND CEO
            if (isEmployeeDirectReport(emp, null, cand)) {
                assignedToAny = true;
                if (!candidateIds.has(cand._id.toString())) {
                    candidateIds.add(cand._id.toString());
                    candidateManagers.push(cand);
                    managerReportsMap.set(cand._id.toString(), []);
                }
                const reports = managerReportsMap.get(cand._id.toString()) || [];
                reports.push({
                    _id: emp._id,
                    employeeId: emp.employeeId,
                    name: `${emp.firstName} ${emp.lastName}`.trim(),
                    designation: emp.designation,
                    department: emp.department,
                    avatar: emp.avatar,
                    employmentStatus: emp.employmentStatus,
                });
                managerReportsMap.set(cand._id.toString(), reports);
                break;
            }
        }

        if (!assignedToAny) {
            unassignedCount++;
            unassignedEmployees.push({
                _id: emp._id,
                employeeId: emp.employeeId,
                name: `${emp.firstName} ${emp.lastName}`.trim(),
                designation: emp.designation,
                department: emp.department,
                avatar: emp.avatar,
                employmentStatus: emp.employmentStatus,
                reportingManager: emp.reportingManager,
            });
        }
    }

    const managers = candidateManagers.map((mgr) => {
        const reports = managerReportsMap.get(mgr._id.toString()) || [];
        const isCeo = Boolean(mgr.isCEO || /ceo|founder/i.test(mgr.designation || "") || (workspace.owner && mgr.linkedUser && workspace.owner.toString() === mgr.linkedUser.toString()));
        const isHR = Boolean(!isCeo && (/hr/i.test(mgr.systemRole || "") || /hr|human resource/i.test(mgr.designation || "")));
        const defaultRole = isCeo ? "CEO" : (isHR ? "HR" : "Manager");
        const formattedLabel = `${mgr.firstName} ${mgr.lastName}`.trim() + (mgr.designation ? ` (${mgr.designation})` : ` (${defaultRole})`);

        return {
            _id: mgr._id,
            employeeId: mgr.employeeId,
            name: `${mgr.firstName} ${mgr.lastName}`.trim(),
            firstName: mgr.firstName,
            lastName: mgr.lastName,
            designation: mgr.designation || defaultRole,
            department: mgr.department,
            avatar: mgr.avatar,
            systemRole: mgr.systemRole,
            employmentStatus: mgr.employmentStatus,
            directReportsCount: reports.length,
            directReports: reports,
            formattedLabel,
            isCEO: isCeo,
        };
    });

    managers.sort((a, b) => {
        if (a.isCEO && !b.isCEO) return -1;
        if (!a.isCEO && b.isCEO) return 1;
        return b.directReportsCount - a.directReportsCount || a.name.localeCompare(b.name);
    });

    return {
        managers,
        orphanedCount: unassignedCount,
        orphanedEmployees: unassignedEmployees,
        totalEmployees: allEmployees.length,
    };
}

/**
 * Replaces a manager in bulk, transferring direct reports to a replacement manager or to the CEO.
 */
export async function replaceManager(userId, { currentManagerId, newManagerId, newManagerName, employeeIds, reason } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR } = await getCallerRoleContext(userId, workspace);

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR and CEO can replace managers or transfer teams.");
    }
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    if (!currentManagerId) {
        throw ApiError.badRequest("Current manager ID is required.");
    }

    const currentManager = await findEmployeeForUser(userId, currentManagerId);
    const currentManagerName = `${currentManager.firstName} ${currentManager.lastName}`.trim();

    let newReportingManagerString = "None (Reports to CEO)";
    let incomingManager = null;
    let incomingUser = null;

    if (newManagerId && newManagerId !== "DIRECT_TO_CEO") {
        if (newManagerId.toString() === currentManager._id.toString() || newManagerId === currentManager.employeeId) {
            throw ApiError.badRequest("Incoming replacement manager cannot be the outgoing manager.");
        }
        incomingManager = await findEmployeeForUser(userId, newManagerId);
        newReportingManagerString = `${incomingManager.firstName} ${incomingManager.lastName}`.trim() +
            (incomingManager.designation ? ` (${incomingManager.designation})` : " (Manager)");
        if (incomingManager.linkedUser) {
            incomingUser = await User.findById(incomingManager.linkedUser).lean();
        }
    } else if (newManagerName) {
        newReportingManagerString = newManagerName.trim();
    }

    let targetReports = [];
    if (Array.isArray(employeeIds) && employeeIds.length > 0) {
        targetReports = await Employee.find({
            _id: { $in: employeeIds },
            workspace: workspace._id,
        });
    } else {
        const filter = buildManagerDirectReportsMongoFilter(workspace._id, null, currentManager, { includeSelf: false });
        targetReports = await Employee.find(filter);
    }

    if (targetReports.length === 0) {
        return {
            success: true,
            count: 0,
            message: `No direct reports found under ${currentManagerName}.`,
            fromManager: currentManagerName,
            toManager: newReportingManagerString,
            transferredEmployees: [],
        };
    }

    const reportIds = targetReports.map((r) => r._id);

    await Employee.updateMany(
        { _id: { $in: reportIds } },
        { $set: { reportingManager: newReportingManagerString } }
    );

    const activityPromises = targetReports.map((emp) =>
        EmployeeActivity.create({
            workspace: workspace._id,
            employee: emp._id,
            actor: userId,
            type: "updated",
            label: `Reporting manager transferred from ${currentManagerName} to ${newReportingManagerString}${reason ? ` (${reason})` : ""}`,
        })
    );

    activityPromises.push(
        EmployeeActivity.create({
            workspace: workspace._id,
            employee: currentManager._id,
            actor: userId,
            type: "updated",
            label: `Transferred ${targetReports.length} direct report(s) to ${newReportingManagerString}${reason ? ` (${reason})` : ""}`,
        })
    );

    if (incomingManager) {
        activityPromises.push(
            EmployeeActivity.create({
                workspace: workspace._id,
                employee: incomingManager._id,
                actor: userId,
                type: "updated",
                label: `Received ${targetReports.length} direct report(s) from ${currentManagerName}${reason ? ` (${reason})` : ""}`,
            })
        );
    }

    await Promise.allSettled(activityPromises);

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        if (incomingUser) {
            await createNotification({
                workspaceId: workspace._id,
                recipientId: incomingUser._id,
                title: "New Team Assignment",
                message: `You have been assigned ${targetReports.length} direct report(s) previously reporting to ${currentManagerName}.`,
                type: "team_assignment",
                link: `/employees`,
                metadata: {
                    transferredCount: targetReports.length,
                    fromManager: currentManagerName,
                },
            });
        }

        const hrAndCeoUsers = await User.find({
            workspaceId: workspace._id,
            $or: [
                { role: { $in: ["Founder / CEO", "HR", "Administrator"] } },
                { systemRole: { $in: ["Admin", "HR"] } },
                ...(workspace.owner ? [{ _id: workspace.owner }] : [])
            ]
        }).lean();

        for (const recipient of hrAndCeoUsers) {
            if (recipient._id.toString() !== userId.toString()) {
                await createNotification({
                    workspaceId: workspace._id,
                    recipientId: recipient._id,
                    title: "Manager Handover Completed",
                    message: `${targetReports.length} direct report(s) successfully reassigned from ${currentManagerName} to ${newReportingManagerString}.`,
                    type: "manager_transfer",
                    link: `/employees`,
                    metadata: {
                        transferredCount: targetReports.length,
                        fromManager: currentManagerName,
                        toManager: newReportingManagerString,
                    },
                });
            }
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error in replaceManager:", notifErr);
    }

    return {
        success: true,
        count: targetReports.length,
        fromManager: currentManagerName,
        toManager: newReportingManagerString,
        transferredEmployees: targetReports.map((t) => ({
            _id: t._id,
            employeeId: t.employeeId,
            name: `${t.firstName} ${t.lastName}`.trim(),
            designation: t.designation,
            department: t.department,
        })),
    };
}

/**
 * Assigns a reporting manager to multiple selected employees in bulk.
 */
export async function bulkAssignManager(userId, { employeeIds, managerId, managerName } = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO, isHR } = await getCallerRoleContext(userId, workspace);

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only HR and CEO can assign managers to employees.");
    }
    await assertOperationalAuthority(userId, workspace, isCEO, isHR);

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
        throw ApiError.badRequest("At least one employee must be selected.");
    }

    let targetManagerString = "None (Reports to CEO)";
    let incomingManager = null;
    let incomingUser = null;

    if (managerId && managerId !== "DIRECT_TO_CEO") {
        incomingManager = await findEmployeeForUser(userId, managerId);
        targetManagerString = `${incomingManager.firstName} ${incomingManager.lastName}`.trim() +
            (incomingManager.designation ? ` (${incomingManager.designation})` : " (Manager)");
        if (incomingManager.linkedUser) {
            incomingUser = await User.findById(incomingManager.linkedUser).lean();
        }
    } else if (managerName) {
        targetManagerString = managerName.trim();
    }

    const employees = await Employee.find({
        _id: { $in: employeeIds },
        workspace: workspace._id,
    });

    const eligible = employees.filter((e) => {
        if (incomingManager && e._id.toString() === incomingManager._id.toString()) return false;
        return true;
    });

    if (eligible.length === 0) {
        throw ApiError.badRequest("No eligible employees selected (an employee cannot report to themselves).");
    }

    const eligibleIds = eligible.map((e) => e._id);

    await Employee.updateMany(
        { _id: { $in: eligibleIds } },
        { $set: { reportingManager: targetManagerString } }
    );

    const logPromises = eligible.map((emp) =>
        EmployeeActivity.create({
            workspace: workspace._id,
            employee: emp._id,
            actor: userId,
            type: "updated",
            label: `Reporting manager assigned to ${targetManagerString}`,
        })
    );

    if (incomingManager) {
        logPromises.push(
            EmployeeActivity.create({
                workspace: workspace._id,
                employee: incomingManager._id,
                actor: userId,
                type: "updated",
                label: `Assigned ${eligible.length} direct report(s)`,
            })
        );
    }

    await Promise.allSettled(logPromises);

    try {
        if (incomingUser) {
            const { createNotification } = await import("../notification/notification.service.js");
            await createNotification({
                workspaceId: workspace._id,
                recipientId: incomingUser._id,
                title: "New Team Assignment",
                message: `You have been assigned ${eligible.length} new direct report(s).`,
                type: "team_assignment",
                link: `/employees`,
                metadata: {
                    transferredCount: eligible.length,
                },
            });
        }
    } catch (notifErr) {
        console.error("Non-fatal notification error in bulkAssignManager:", notifErr);
    }

    return {
        success: true,
        count: eligible.length,
        reportingManager: targetManagerString,
    };
}

/**
 * Create a login account for an existing employee who was previously created without one.
 */
export async function createEmployeeLoginAccount(userId, idOrEmployeeId, body = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const caller = await User.findById(userId);
    if (!caller) throw ApiError.unauthorized("Caller not found");

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === caller._id.toString());
    const roleStr = String(caller.role || "").toLowerCase().trim();
    const systemRoleStr = String(caller.systemRole || "").toLowerCase().trim();
    const isCEO = isOwner || /ceo|founder|director|administrator|admin/.test(roleStr) || systemRoleStr === "admin";
    const isHR = !isCEO && (/hr/.test(roleStr) || systemRoleStr === "hr");
    const hasPerm = Boolean(caller.permissions?.employees?.manageAccess);

    if (!isCEO && !isHR && !hasPerm) {
        throw ApiError.forbidden("You do not have permission to create login accounts for employees.");
    }

    if (employee.linkedUser) {
        const existingLinked = await User.findById(employee.linkedUser);
        if (existingLinked) {
            throw ApiError.conflict(`Employee already has a linked login account (${existingLinked.email}).`);
        }
    }

    const emailToUse = (body.loginEmail || employee.workEmail || employee.personalEmail || "").trim().toLowerCase();
    if (!emailToUse) {
        throw ApiError.badRequest("A valid login email is required.");
    }

    const emailCollision = await User.findOne({ email: emailToUse });
    if (emailCollision) {
        throw ApiError.conflict(`A user account with email "${emailToUse}" already exists.`);
    }

    const targetRole = body.systemRole || employee.systemRole || "Employee";
    const hasFullAccess = callerHasFullAccess(caller, workspace);
    const perms = sanitizeAssignedPermissions(
        body.permissions || employee.permissions || {},
        { hasFullAccess, workspace }
    );

    const newUser = await User.create({
        fullName: `${employee.firstName} ${employee.lastName}`.trim(),
        email: emailToUse,
        password: "!" + crypto.randomBytes(32).toString("hex"),
        company: workspace.companyName,
        companySize: "1-10",
        role: targetRole,
        systemRole: targetRole,
        permissions: perms,
        status: "pending",
        emailVerified: true,
        setupCompletedAt: null,
        workspaceId: workspace._id,
    });

    const inviteToken = createInviteToken(newUser);

    employee.createLogin = true;
    employee.loginEmail = emailToUse;
    employee.systemRole = targetRole;
    employee.permissions = perms;
    employee.linkedUser = newUser._id;
    employee.sendInvitation = Boolean(body.sendInvitation);
    await employee.save();

    if (body.sendInvitation) {
        try {
            const { sendEmployeeInviteEmail } = await import("../email/email.service.js");
            sendEmployeeInviteEmail(newUser, inviteToken).catch((err) => {
                console.error("Failed to send employee invite email:", err.message);
            });
        } catch (inviteErr) {
            console.error("Failed to import or send employee invite email:", inviteErr);
        }
    }

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Login account provisioned (${emailToUse}) with ${targetRole} role`,
    });

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: caller.fullName,
            actorRole: isCEO ? "CEO" : isHR ? "HR" : "Administrator",
            action: "employee.create_login",
            module: "Access & Roles",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Provisioned login account for ${employee.firstName} ${employee.lastName} with role "${targetRole}" and email "${emailToUse}"${body.sendInvitation ? " (invitation sent)" : ""}`,
            details: {
                employeeId: employee.employeeId,
                loginEmail: emailToUse,
                systemRole: targetRole,
                sendInvitation: Boolean(body.sendInvitation),
                permissions: perms,
            },
        });
    } catch (auditErr) {
        console.error("Non-fatal audit logging error in createEmployeeLoginAccount:", auditErr);
    }

    return {
        success: true,
        message: `Login account created for ${employee.firstName} ${employee.lastName}`,
        employee: employee.toSafeJSON(),
        user: newUser.toSafeJSON(),
    };
}

/**
 * Resend the invitation email to an employee's linked user account.
 */
export async function resendEmployeeInvitation(userId, idOrEmployeeId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const caller = await User.findById(userId);
    if (!caller) throw ApiError.unauthorized("Caller not found");

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === caller._id.toString());
    const roleStr = String(caller.role || "").toLowerCase().trim();
    const systemRoleStr = String(caller.systemRole || "").toLowerCase().trim();
    const isCEO = isOwner || /ceo|founder|director|administrator|admin/.test(roleStr) || systemRoleStr === "admin";
    const isHR = !isCEO && (/hr/.test(roleStr) || systemRoleStr === "hr");
    const hasPerm = Boolean(caller.permissions?.employees?.manageAccess);

    if (!isCEO && !isHR && !hasPerm) {
        throw ApiError.forbidden("You do not have permission to resend invitations.");
    }

    if (["Terminated", "Resigned", "Suspended"].includes(employee.employmentStatus)) {
        throw ApiError.badRequest(`Cannot send login invitation to an employee who is currently ${employee.employmentStatus}. Please update employee status to Active first.`);
    }

    let linkedUser = null;
    if (employee.linkedUser) {
        linkedUser = await User.findById(employee.linkedUser);
    }
    if (!linkedUser && employee.loginEmail) {
        linkedUser = await User.findOne({ email: employee.loginEmail.toLowerCase().trim() });
    }
    if (!linkedUser && employee.workEmail) {
        linkedUser = await User.findOne({ email: employee.workEmail.toLowerCase().trim() });
    }
    if (!linkedUser && employee.personalEmail) {
        linkedUser = await User.findOne({ email: employee.personalEmail.toLowerCase().trim() });
    }

    if (!linkedUser) {
        throw ApiError.badRequest("No login account exists for this employee. Please create a login account first.");
    }

    if (!employee.linkedUser) {
        employee.linkedUser = linkedUser._id;
    }

    // Set user status to pending so acceptInvite will allow setting new password
    linkedUser.status = "pending";
    await linkedUser.save();

    const inviteToken = createInviteToken(linkedUser);
    const { sendEmployeeInviteEmail } = await import("../email/email.service.js");
    await sendEmployeeInviteEmail(linkedUser, inviteToken);

    employee.sendInvitation = true;
    await employee.save();

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Invitation email resent to ${linkedUser.email}`,
    });

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: caller.fullName,
            actorRole: isCEO ? "CEO" : isHR ? "HR" : "Administrator",
            action: "employee.invite_resend",
            module: "Access & Roles",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Resent login invitation email to ${linkedUser.email} for employee ${employee.firstName} ${employee.lastName}`,
            details: {
                employeeId: employee.employeeId,
                email: linkedUser.email,
                userStatus: linkedUser.status,
            },
        });
    } catch (auditErr) {
        console.error("Non-fatal audit logging error in resendEmployeeInvitation:", auditErr);
    }

    return {
        success: true,
        message: `Invitation email has been sent to ${linkedUser.email}`,
    };
}

/**
 * Update an employee's system role and granular permissions.
 */
export async function updateEmployeePermissions(userId, idOrEmployeeId, body = {}) {
    const workspace = await getWorkspaceOrThrow(userId);
    const caller = await User.findById(userId);
    if (!caller) throw ApiError.unauthorized("Caller not found");

    const employee = await findEmployeeForUser(userId, idOrEmployeeId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === caller._id.toString());
    const roleStr = String(caller.role || "").toLowerCase().trim();
    const systemRoleStr = String(caller.systemRole || "").toLowerCase().trim();
    const isCEO = isOwner || /ceo|founder|director|administrator|admin/.test(roleStr) || systemRoleStr === "admin";
    const isHR = !isCEO && (/hr/.test(roleStr) || systemRoleStr === "hr");
    const hasPerm = Boolean(caller.permissions?.employees?.manageAccess);

    if (!isCEO && !isHR && !hasPerm) {
        throw ApiError.forbidden("You do not have permission to update employee permissions.");
    }

    const hasFullAccess = callerHasFullAccess(caller, workspace);

    if (body.systemRole !== undefined) {
        employee.systemRole = body.systemRole;
    }
    if (body.permissions !== undefined) {
        employee.permissions = sanitizeAssignedPermissions(body.permissions, { hasFullAccess, workspace });
    }
    await employee.save();

    // If employee is linked to a User account, keep User in sync
    let linkedUser = null;
    if (employee.linkedUser) {
        linkedUser = await User.findById(employee.linkedUser);
    } else if (employee.loginEmail) {
        linkedUser = await User.findOne({ email: employee.loginEmail, workspaceId: workspace._id });
    }

    if (linkedUser) {
        if (body.systemRole !== undefined) {
            linkedUser.systemRole = body.systemRole;
            linkedUser.role = body.systemRole;
        }
        if (body.permissions !== undefined) {
            linkedUser.permissions = employee.permissions;
        }
        await linkedUser.save();
    }

    await EmployeeActivity.create({
        workspace: workspace._id,
        employee: employee._id,
        actor: userId,
        type: "updated",
        label: `Role and access permissions updated (${employee.systemRole})`,
    });

    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: userId,
            actorName: caller.fullName,
            actorRole: isCEO ? "CEO" : isHR ? "HR" : "Administrator",
            action: "employee.permissions_update",
            module: "Access & Roles",
            targetId: employee.employeeId,
            targetName: `${employee.firstName} ${employee.lastName}`.trim(),
            targetType: "Employee",
            description: `Updated role to "${employee.systemRole}" and modified permissions for ${employee.firstName} ${employee.lastName}`,
            details: {
                employeeId: employee.employeeId,
                systemRole: employee.systemRole,
                permissions: employee.permissions,
            },
        });
    } catch (auditErr) {
        console.error("Non-fatal audit logging error in updateEmployeePermissions:", auditErr);
    }

    return {
        success: true,
        message: "Permissions updated successfully",
        employee: employee.toSafeJSON(),
    };
}
