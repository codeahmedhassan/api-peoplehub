// src/services/workspace/workspace.service.js
import { Workspace } from "../../model/workspace/workspace.model.js";
import { User } from "../../model/auth/auth.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { ApiError } from "../../utils/ApiError.js";
import { calculateWorkspaceStorageBytes } from "./plan.service.js";

export async function setupWorkspace(userId, payload) {
    const { company, teamSize, theme } = payload;

    const user = await User.findById(userId);
    if (!user) throw ApiError.unauthorized("User no longer exists");
    if (!user.emailVerified) throw ApiError.forbidden("Email not verified");

    const workspace = await Workspace.findOneAndUpdate(
        { owner: userId },
        {
            $set: {
                owner: userId,
                companyName: company.name,
                industry: company.industry,
                timezone: company.timezone,
                teamSize,
                theme,
                setupCompletedAt: new Date(),
                verificationStatus: "pending",
                rejectionReason: "",
            },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (!user.setupCompletedAt) {
        user.setupCompletedAt = new Date();
        await user.save();
    }

    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});

    return workspace;
}



export async function getWorkspaceForUser(userId) {
    const user = await User.findById(userId);
    if (!user) return null;

    // 1. Check if they own a workspace
    const ownedWorkspace = await Workspace.findOne({ owner: userId });
    if (ownedWorkspace) return ownedWorkspace;

    // 2. Check if they are an employee linked to a workspace
    if (user.workspaceId) {
        return await Workspace.findById(user.workspaceId);
    }

    // 3. Check if user is a member of any workspace
    const memberWorkspace = await Workspace.findOne({ "members.user": userId });
    if (memberWorkspace) return memberWorkspace;

    // 4. Check if employee record belongs to a workspace
    const linkedEmp = await Employee.findOne({
        $or: [{ linkedUser: userId }, { loginEmail: user.email?.toLowerCase() }]
    });
    if (linkedEmp?.workspace) {
        return await Workspace.findById(linkedEmp.workspace);
    }

    return null;
}

async function assertWorkspaceAdminAuthority(userId, workspace, { requireCeo = false } = {}) {
    const user = await User.findById(userId).select("role systemRole email").lean();
    if (!user) throw ApiError.unauthorized("User no longer exists");
    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === userId.toString());
    const roleStr = String(user.role || "").toLowerCase();
    const systemRoleStr = String(user.systemRole || "").toLowerCase();
    let employeeRoleStr = "";
    const emp = await Employee.findOne({
        workspace: workspace._id,
        $or: [
            { linkedUser: user._id },
            { loginEmail: user.email?.toLowerCase() },
            { personalEmail: user.email?.toLowerCase() },
        ],
    }).select("systemRole designation department").lean();
    if (emp?.systemRole) employeeRoleStr = emp.systemRole.toLowerCase();

    const isCEO = Boolean(
        isOwner ||
        ["founder / ceo", "founder", "ceo", "administrator", "admin"].includes(roleStr) ||
        ["admin", "administrator"].includes(systemRoleStr)
    );
    const isHR = Boolean(
        !isCEO &&
        (roleStr === "hr" ||
            systemRoleStr === "hr" ||
            employeeRoleStr === "hr" ||
            /hr|human resource/i.test(emp?.designation || "") ||
            /hr|human resource/i.test(emp?.department || ""))
    );
    if (requireCeo && !isCEO) {
        throw ApiError.forbidden("Only the Founder / CEO can modify this workspace governance setting.");
    }
    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only the Founder / CEO or HR can modify workspace configuration.");
    }
    return { isCEO, isHR };
}

export async function updateCompanyProfile(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    const { isCEO } = await assertWorkspaceAdminAuthority(userId, workspace);

    if (patch.companyName !== undefined) workspace.companyName = String(patch.companyName).trim();
    if (patch.industry !== undefined) workspace.industry = patch.industry;
    if (patch.timezone !== undefined) workspace.timezone = patch.timezone;
    if (patch.logo !== undefined) workspace.logo = patch.logo;
    if (patch.teamSize !== undefined) workspace.teamSize = patch.teamSize;
    if (patch.ceoFullControlWithHr !== undefined) {
        if (!isCEO) {
            throw ApiError.forbidden("Only the Founder / CEO can modify CEO operational override settings.");
        }
        workspace.ceoFullControlWithHr = Boolean(patch.ceoFullControlWithHr);
    }
    if (patch.employmentStatuses !== undefined && Array.isArray(patch.employmentStatuses)) {
        workspace.employmentStatuses = patch.employmentStatuses.map(String).map((s) => s.trim()).filter(Boolean);
    }
    if (patch.employmentTypes !== undefined && Array.isArray(patch.employmentTypes)) {
        workspace.employmentTypes = patch.employmentTypes.map(String).map((s) => s.trim()).filter(Boolean);
    }
    if (patch.currencies !== undefined && Array.isArray(patch.currencies)) {
        const cleaned = patch.currencies.map(String).map((s) => s.trim().toUpperCase()).filter(Boolean);
        workspace.currencies = Array.from(new Set(cleaned));
    }
    if (patch.onboardingDismissed !== undefined) {
        workspace.onboardingDismissed = Boolean(patch.onboardingDismissed);
    }

    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}

export async function checkWorkspaceHasHR(workspaceId, ownerId = null) {
    const hrUser = await User.findOne({
        $or: [
            { workspaceId },
            ...(ownerId ? [{ _id: ownerId }] : []),
        ],
        $or: [
            { role: "HR" },
            { systemRole: "HR" },
        ],
        status: { $ne: "deactivated" },
    }).lean();

    if (hrUser) return true;

    const hrEmp = await Employee.findOne({
        workspace: workspaceId,
        systemRole: "HR",
        status: { $ne: "Terminated" },
    }).lean();

    return Boolean(hrEmp);
}

export async function updateCeoOverrideSetting(userId, enabled) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isCEO =
        user?.role === "Founder / CEO" ||
        user?.role === "Administrator" ||
        (workspace.owner && workspace.owner.toString() === userId.toString());

    if (!isCEO) {
        throw ApiError.forbidden("Only the Founder / CEO can change the CEO operational override setting");
    }

    workspace.ceoFullControlWithHr = Boolean(enabled);
    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}



export async function updateFinancialSettings(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isCEO =
        user?.role === "Founder / CEO" ||
        user?.role === "Administrator" ||
        (workspace.owner && workspace.owner.toString() === userId.toString());
    const isHR = user?.role === "HR" || user?.systemRole === "HR";

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only the Founder / CEO or HR can view or modify financial and payroll settings");
    }

    if (patch.currency !== undefined) {
        if (!isCEO) throw ApiError.forbidden("Only the Founder / CEO can change the base currency");
        workspace.currency = String(patch.currency).trim().toUpperCase();
    }
    if (patch.currencies !== undefined && Array.isArray(patch.currencies)) {
        const cleaned = patch.currencies.map(String).map((s) => s.trim().toUpperCase()).filter(Boolean);
        workspace.currencies = Array.from(new Set(cleaned));
    }
    if (patch.payrollCycle !== undefined) {
        if (!isCEO) throw ApiError.forbidden("Only the Founder / CEO can change the payroll cycle");
        workspace.payrollCycle = String(patch.payrollCycle).trim();
    }
    if (patch.taxId !== undefined) {
        if (!isCEO) throw ApiError.forbidden("Only the Founder / CEO can change the tax ID");
        workspace.taxId = String(patch.taxId).trim();
    }

    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}



export async function updateAttendanceSettings(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === userId.toString());
    const roleStr = (user?.role || "").toLowerCase();
    const systemRoleStr = (user?.systemRole || "").toLowerCase();

    let employeeRoleStr = "";
    if (user) {
        const emp = await Employee.findOne({
            workspace: workspace._id,
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email?.toLowerCase() },
                { personalEmail: user.email?.toLowerCase() },
            ],
        }).select("systemRole").lean();
        if (emp?.systemRole) {
            employeeRoleStr = emp.systemRole.toLowerCase();
        }
    }

    const isCEO = Boolean(
        isOwner ||
        roleStr === "founder / ceo" ||
        roleStr === "founder" ||
        roleStr === "ceo" ||
        roleStr === "administrator" ||
        roleStr === "admin" ||
        systemRoleStr === "admin" ||
        systemRoleStr === "administrator"
    );

    const isHR = Boolean(
        !isCEO && (
            roleStr === "hr" ||
            systemRoleStr === "hr" ||
            employeeRoleStr === "hr"
        )
    );

    if (patch.endOfDayTime !== undefined || patch.autoAbsentTime !== undefined) {
        if (!isCEO && !isHR) {
            throw ApiError.forbidden("Only the Founder / CEO or HR can modify the end of workday time");
        }
        const cutOffTime = String(patch.endOfDayTime || patch.autoAbsentTime || "19:00").trim();
        workspace.attendance.endOfDayTime = cutOffTime;
        workspace.attendance.autoAbsentTime = cutOffTime;
    }

    if (patch.autoMarkAbsent !== undefined) {
        workspace.attendance.autoMarkAbsent = patch.autoMarkAbsent;
    }

    // Detect weekend day changes
    let weekendsChanged = false;
    let newWeekendNames = [];
    const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    if (patch.weekendDays !== undefined && Array.isArray(patch.weekendDays)) {
        const oldWeekends = (workspace.attendance?.weekendDays || []).slice().sort().join(",");
        const newWeekends = patch.weekendDays.slice().sort().join(",");
        if (oldWeekends !== newWeekends) {
            weekendsChanged = true;
            newWeekendNames = patch.weekendDays.map((d) => WEEKDAYS[d]).filter(Boolean);
        }
        workspace.attendance.weekendDays = patch.weekendDays;
    }

    // Detect holiday additions / cancellations
    let holidaysChanged = false;
    let addedHolidays = [];
    let canceledHolidays = [];

    if (patch.holidays !== undefined && Array.isArray(patch.holidays)) {
        const oldHolidays = (workspace.attendance?.holidays || []).map((h) => ({
            name: String(h.name || "").trim(),
            date: String(h.date || "").trim(),
        }));
        const newHolidays = patch.holidays.map((h) => ({
            name: String(h.name || "").trim(),
            date: String(h.date || "").trim(),
        }));

        const oldKeySet = new Set(oldHolidays.map((h) => `${h.date}::${h.name.toLowerCase()}`));
        const newKeySet = new Set(newHolidays.map((h) => `${h.date}::${h.name.toLowerCase()}`));

        addedHolidays = newHolidays.filter((h) => !oldKeySet.has(`${h.date}::${h.name.toLowerCase()}`));
        canceledHolidays = oldHolidays.filter((h) => !newKeySet.has(`${h.date}::${h.name.toLowerCase()}`));

        if (addedHolidays.length > 0 || canceledHolidays.length > 0) {
            holidaysChanged = true;
        }
        workspace.attendance.holidays = patch.holidays;
    }

    if (
        patch.noLeavePolicy !== undefined ||
        patch.leavesPerEmployee !== undefined ||
        patch.timeoffPerEmployee !== undefined ||
        patch.weekendWorkEarnsLeave !== undefined ||
        patch.weekendLeaveExpiry !== undefined ||
        patch.leavePolicyMode !== undefined ||
        patch.leaveTypesConfig !== undefined ||
        patch.timeoffTypesConfig !== undefined ||
        patch.customLeaveTypes !== undefined
    ) {
        if (!isCEO && !isHR) {
            throw ApiError.forbidden("Only the Founder / CEO or HR can modify leave and time-off policy settings");
        }
        if (patch.leavesPerEmployee !== undefined) {
            workspace.attendance.leavesPerEmployee = Number(patch.leavesPerEmployee) >= 0 ? Number(patch.leavesPerEmployee) : 14;
        }
        if (patch.timeoffPerEmployee !== undefined) {
            workspace.attendance.timeoffPerEmployee = Number(patch.timeoffPerEmployee) >= 0 ? Number(patch.timeoffPerEmployee) : 10;
        }
        if (patch.noLeavePolicy !== undefined) {
            workspace.attendance.noLeavePolicy = Boolean(patch.noLeavePolicy);
        }
        if (patch.weekendWorkEarnsLeave !== undefined) {
            workspace.attendance.weekendWorkEarnsLeave = Boolean(patch.weekendWorkEarnsLeave);
        }
        if (patch.weekendLeaveExpiry !== undefined) {
            workspace.attendance.weekendLeaveExpiry = String(patch.weekendLeaveExpiry || "never").trim();
        }
        if (patch.leavePolicyMode !== undefined) {
            workspace.attendance.leavePolicyMode = patch.leavePolicyMode === "unified" ? "unified" : "detailed";
        }
        if (patch.leaveTypesConfig !== undefined && Array.isArray(patch.leaveTypesConfig)) {
            workspace.attendance.leaveTypesConfig = patch.leaveTypesConfig;
        }
        if (patch.timeoffTypesConfig !== undefined && Array.isArray(patch.timeoffTypesConfig)) {
            workspace.attendance.timeoffTypesConfig = patch.timeoffTypesConfig;
        }
        if (patch.customLeaveTypes !== undefined && Array.isArray(patch.customLeaveTypes)) {
            workspace.attendance.customLeaveTypes = patch.customLeaveTypes;
        }
    }

    if (patch.deductShortHours !== undefined) {
        if (!isCEO && !isHR) {
            throw ApiError.forbidden("Only the Founder / CEO or HR can modify work hours and salary deduction rules");
        }
        workspace.attendance.deductShortHours = Boolean(patch.deductShortHours);
    }

    workspace.markModified("attendance");
    await workspace.save();

    // Notify all managers via In-App and Email notifications if weekends or holidays changed
    if (weekendsChanged || holidaysChanged) {
        try {
            const { createNotification } = await import("../notification/notification.service.js");
            const {
                sendWeekendScheduleUpdateEmail,
                sendHolidayAnnouncementEmail,
                sendHolidayCancellationEmail,
            } = await import("../email/email.service.js");

            const managers = await getAllManagersForWorkspace(workspace);

            for (const mgr of managers) {
                if (weekendsChanged) {
                    if (mgr.userId) {
                        await createNotification({
                            workspaceId: workspace._id,
                            recipientId: mgr.userId,
                            title: "Weekend Schedule Updated",
                            message: `Weekend days have been changed to ${newWeekendNames.join(", ") || "None"} by HR.`,
                            type: "attendance_update",
                            link: "/settings/attendance-rules",
                            metadata: {
                                weekendDays: newWeekendNames,
                                updatedBy: user?.fullName || "HR",
                            },
                        });
                    }
                    if (mgr.email) {
                        const weekendPref =
                            mgr.notificationPreferences?.["emp-company-policy-update"] ??
                            mgr.notificationPreferences?.["weekend-update"] ??
                            true;
                        if (weekendPref) {
                            sendWeekendScheduleUpdateEmail({
                                to: mgr.email,
                                managerName: mgr.name || "Manager",
                                weekendDays: newWeekendNames,
                                companyName: workspace.companyName,
                            }).catch(() => {});
                        }
                    }
                }

                if (addedHolidays.length > 0) {
                    const addedNames = addedHolidays.map((h) => `${h.name} (${h.date})`).join(", ");
                    if (mgr.userId) {
                        await createNotification({
                            workspaceId: workspace._id,
                            recipientId: mgr.userId,
                            title: "New Holiday Arriving",
                            message: `New holiday arriving: ${addedNames}. Tell your employees about it.`,
                            type: "holiday_announcement",
                            link: "/settings/attendance-rules",
                            metadata: {
                                holidays: addedHolidays,
                                announcedBy: user?.fullName || "HR",
                            },
                        });
                    }
                    if (mgr.email) {
                        const holidayPref =
                            mgr.notificationPreferences?.["emp-company-announcement"] ??
                            mgr.notificationPreferences?.["holiday-announcement"] ??
                            true;
                        if (holidayPref) {
                            sendHolidayAnnouncementEmail({
                                to: mgr.email,
                                managerName: mgr.name || "Manager",
                                holidays: addedHolidays,
                                companyName: workspace.companyName,
                            }).catch(() => {});
                        }
                    }
                }

                if (canceledHolidays.length > 0) {
                    const canceledNames = canceledHolidays.map((h) => h.name).join(", ");
                    if (mgr.userId) {
                        await createNotification({
                            workspaceId: workspace._id,
                            recipientId: mgr.userId,
                            title: "Holiday Canceled",
                            message: `${canceledNames} holidays are canceled tell your employees about it.`,
                            type: "holiday_announcement",
                            link: "/settings/attendance-rules",
                            metadata: {
                                canceledHolidays,
                                announcedBy: user?.fullName || "HR",
                            },
                        });
                    }
                    if (mgr.email) {
                        const holidayPref =
                            mgr.notificationPreferences?.["emp-company-announcement"] ??
                            mgr.notificationPreferences?.["holiday-announcement"] ??
                            true;
                        if (holidayPref) {
                            sendHolidayCancellationEmail({
                                to: mgr.email,
                                managerName: mgr.name || "Manager",
                                canceledHolidays,
                                companyName: workspace.companyName,
                            }).catch(() => {});
                        }
                    }
                }
            }

            // Fallback: If no dedicated manager accounts were found with user logins, post general in-app alerts
            if (managers.length === 0 || !managers.some((m) => m.userId)) {
                if (weekendsChanged) {
                    await createNotification({
                        workspaceId: workspace._id,
                        recipientId: null,
                        title: "Weekend Schedule Updated",
                        message: `Weekend days have been changed to ${newWeekendNames.join(", ") || "None"} by HR.`,
                        type: "attendance_update",
                        link: "/settings/attendance-rules",
                    });
                }
                if (addedHolidays.length > 0) {
                    await createNotification({
                        workspaceId: workspace._id,
                        recipientId: null,
                        title: "New Holiday Arriving",
                        message: `New holiday arriving: ${addedHolidays.map((h) => h.name).join(", ")}. Tell your employees about it.`,
                        type: "holiday_announcement",
                        link: "/settings/attendance-rules",
                    });
                }
                if (canceledHolidays.length > 0) {
                    await createNotification({
                        workspaceId: workspace._id,
                        recipientId: null,
                        title: "Holiday Canceled",
                        message: `${canceledHolidays.map((h) => h.name).join(", ")} holidays are canceled tell your employees about it.`,
                        type: "holiday_announcement",
                        link: "/settings/attendance-rules",
                    });
                }
            }
        } catch (notifErr) {
            console.error("Non-fatal notification error on attendance settings update:", notifErr.message);
        }
    }

    return workspace;
}



export async function getAllManagersForWorkspace(workspace) {
    const workspaceId = workspace._id;

    // 1. Users with Manager role
    const managerUsers = await User.find({
        $or: [
            { workspaceId: workspaceId },
            { _id: workspace.owner, $or: [{ role: "Manager" }, { systemRole: "Manager" }] },
        ],
        $or: [
            { role: "Manager" },
            { systemRole: "Manager" },
        ],
        status: { $ne: "deactivated" },
    }).lean();

    // 2. Employees designated as Manager
    const managerEmployees = await Employee.find({
        workspace: workspaceId,
        $or: [
            { systemRole: "Manager" },
            { designation: { $regex: /manager/i } },
        ],
        status: { $ne: "Terminated" },
    }).lean();

    // 3. Employees who are reportingManager for others in this workspace
    const reportingValues = await Employee.distinct("reportingManager", {
        workspace: workspaceId,
        reportingManager: { $nin: ["", null, "None", "N/A"] },
    });

    let extraManagerEmployees = [];
    if (reportingValues.length > 0) {
        extraManagerEmployees = await Employee.find({
            workspace: workspaceId,
            $or: [
                { employeeId: { $in: reportingValues } },
                { firstName: { $in: reportingValues.map((v) => v.split(" ")[0]) } },
            ],
            status: { $ne: "Terminated" },
        }).lean();
    }

    const managerMap = new Map();

    const register = (userId, email, name) => {
        if (!email && !userId) return;
        const key = (email || userId.toString()).toLowerCase();
        if (!managerMap.has(key)) {
            managerMap.set(key, {
                userId: userId ? userId.toString() : null,
                email: email ? email.toLowerCase() : null,
                name: name || "Manager",
            });
        } else {
            const existing = managerMap.get(key);
            if (!existing.userId && userId) existing.userId = userId.toString();
            if (!existing.email && email) existing.email = email.toLowerCase();
            if (!existing.name && name) existing.name = name;
        }
    };

    for (const u of managerUsers) {
        register(u._id, u.email, u.fullName || u.name);
    }

    for (const emp of [...managerEmployees, ...extraManagerEmployees]) {
        const empName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name;
        const email = emp.loginEmail || emp.personalEmail || emp.email;
        register(emp.linkedUser, email, empName);
    }

    for (const mgr of managerMap.values()) {
        if (mgr.userId) {
            const u = await User.findById(mgr.userId).select("email fullName notificationPreferences").lean();
            if (u) {
                if (!mgr.email) mgr.email = u.email;
                if (!mgr.name || mgr.name === "Manager") mgr.name = u.fullName;
                mgr.notificationPreferences = u.notificationPreferences || {};
            }
        }
    }

    return Array.from(managerMap.values());
}

export async function updateWorkspaceModules(userId, modules) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isOwner = workspace.owner && workspace.owner.toString() === userId.toString();
    const isFounder = user?.role === "Founder / CEO" || user?.role === "Administrator";

    if (!isOwner && !isFounder) {
        throw ApiError.forbidden("Only the Founder / CEO or workspace creator can modify workspace modules");
    }

    if (!workspace.theme) workspace.theme = {};
    workspace.theme.modules = {
        ...(workspace.theme.modules || {}),
        ...modules,
    };
    workspace.markModified("theme");

    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}



export async function updatePayslipSettings(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    await assertWorkspaceAdminAuthority(userId, workspace);

    workspace.payslipSettings = {
        ...(workspace.payslipSettings || {}),
        ...patch,
    };
    workspace.markModified("payslipSettings");

    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}



export async function updateWorkspaceIntegrations(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    await assertWorkspaceAdminAuthority(userId, workspace);

    workspace.integrations = {
        ...(workspace.integrations || {}),
        ...patch,
    };
    workspace.markModified("integrations");

    await workspace.save();
    calculateWorkspaceStorageBytes(workspace._id).catch(() => {});
    return workspace;
}



export async function getWorkspaceUsers(userId) {
    const workspace = await getWorkspaceOrThrow(userId);

    // Find all users linked to this workspace or owning it
    const users = await User.find({
        $or: [{ _id: workspace.owner }, { workspaceId: workspace._id }],
    }).lean();

    // Also find employees for this workspace
    const employees = await Employee.find({ workspace: workspace._id }).lean();

    const VALID_ROLES = ["Admin", "Manager", "HR", "Employee", "Viewer", "Custom"];

    const mapped = users.map((u) => {
        const isOwner = Boolean(workspace.owner && u._id.toString() === workspace.owner.toString());
        const isCEO = Boolean(isOwner || /ceo|founder|administrator|admin/i.test(u.role || "") || /admin/i.test(u.systemRole || ""));
        let role = u.systemRole || u.role;
        if (!VALID_ROLES.includes(role)) {
            role = isCEO ? "Admin" : (/hr/i.test(u.role || "") ? "HR" : (/manager/i.test(u.role || "") ? "Manager" : "Employee"));
        }

        return {
            id: u._id.toString(),
            name: u.fullName,
            fullName: u.fullName,
            email: u.email,
            role,
            systemRole: u.systemRole || role,
            avatar: u.avatar || "",
            lastActive: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleDateString() : "Active",
            isOwner,
            isCEO,
        };
    });

    const userEmails = new Set(users.map((u) => (u.email || "").toLowerCase()));
    for (const emp of employees) {
        const empEmail = (emp.loginEmail || emp.personalEmail || "").toLowerCase();
        if (empEmail && !userEmails.has(empEmail)) {
            let role = emp.systemRole || "Employee";
            if (!VALID_ROLES.includes(role)) {
                role = "Employee";
            }
            mapped.push({
                id: emp._id.toString(),
                name: `${emp.firstName} ${emp.lastName}`.trim(),
                email: emp.loginEmail || emp.personalEmail,
                role,
                avatar: emp.avatar || "",
                lastActive: "Employee Record",
                isOwner: false,
                isCEO: false,
                isEmployeeOnly: true,
            });
            userEmails.add(empEmail);
        }
    }

    return mapped;
}

export async function updateUserRole(adminUserId, targetUserId, newRole) {
    const workspace = await getWorkspaceOrThrow(adminUserId);
    const caller = await User.findById(adminUserId);
    if (!caller) {
        throw ApiError.unauthorized("User no longer exists");
    }

    const isCallerCEO =
        caller.role === "Founder / CEO" ||
        caller.role === "Administrator" ||
        (workspace.owner && workspace.owner.toString() === adminUserId.toString());
    const isCallerHR = caller.role === "HR" || caller.systemRole === "HR";

    // 1. Restriction: If manager or any other role, cannot change any access
    // "if maganer then he cannot change any access. So only CEO and HR can change the access roles"
    if (!isCallerCEO && !isCallerHR) {
        throw ApiError.forbidden("Managers cannot modify access roles. Only the CEO and HR can change access roles.");
    }

    const VALID_ROLES = ["Admin", "Manager", "HR", "Employee", "Viewer", "Custom"];
    if (!VALID_ROLES.includes(newRole)) {
        throw ApiError.badRequest(`Invalid system role: ${newRole}`);
    }

    // Try finding User
    let user = await User.findById(targetUserId);
    let emp = !user ? await Employee.findById(targetUserId) : null;

    if (!user && !emp) {
        throw ApiError.notFound("User not found");
    }

    // Determine if the target is CEO/Owner
    const isTargetCEO =
        (user && (
            user.role === "Founder / CEO" ||
            user.role === "Administrator" ||
            (workspace.owner && workspace.owner.toString() === user._id.toString())
        )) ||
        (emp && emp.linkedUser && workspace.owner && workspace.owner.toString() === emp.linkedUser.toString());

    // 2. Restriction: HR can change anyone's role EXCEPT CEO and EXCEPT THEMSELVES
    // "On Access & roles the HR can not change its Role because it was set by the CEO but he can change others."
    if (!isCallerCEO && isCallerHR) {
        if (isTargetCEO) {
            throw ApiError.forbidden("HR cannot modify the access role of the CEO / Workspace Owner");
        }
        const isTargetSelf =
            (user && user._id.toString() === adminUserId.toString()) ||
            (emp && emp.linkedUser && emp.linkedUser.toString() === adminUserId.toString());
        if (isTargetSelf) {
            throw ApiError.forbidden("HR cannot modify their own role. Your role can only be changed by the Founder / CEO.");
        }
    }

    if (user) {
        user.role = newRole;
        user.systemRole = newRole;
        await user.save();
        await Employee.updateMany(
            { $or: [{ linkedUser: user._id }, { loginEmail: user.email }] },
            { $set: { systemRole: newRole } }
        );

        // Find department if linked to employee
        const matchingEmp = await Employee.findOne({
            $or: [{ linkedUser: user._id }, { loginEmail: user.email }]
        }).lean();
        const deptStr = matchingEmp?.department ? ` of ${matchingEmp.department}` : "";

        try {
            const { createNotification } = await import("../notification/notification.service.js");
            const { sendRoleUpdateEmail } = await import("../email/email.service.js");

            await createNotification({
                workspaceId: workspace._id,
                recipientId: user._id,
                title: "Role Appointment",
                message: `HR appointed you as ${newRole}${deptStr}. You now have ${newRole} permissions in your workspace.`,
                type: "role_appointment",
                link: "/settings/profile",
                metadata: { role: newRole, department: matchingEmp?.department },
            });

            if (user.email) {
                const pref =
                    user.notificationPreferences?.["emp-manager-assigned"] ??
                    user.notificationPreferences?.["view-access-permissions-updated"] ??
                    user.notificationPreferences?.["role-appointment"] ??
                    true;
                if (pref) {
                    sendRoleUpdateEmail({
                        to: user.email,
                        userName: user.fullName || "Team Member",
                        newRole,
                        department: matchingEmp?.department || "",
                        companyName: workspace.companyName,
                    }).catch(() => {});
                }
            }
        } catch (err) {
            console.error("Notification error on role update:", err.message);
        }

        return { success: true, role: newRole };
    }

    // If employee record
    if (emp) {
        emp.systemRole = newRole;
        await emp.save();
        if (emp.linkedUser) {
            await User.findByIdAndUpdate(emp.linkedUser, { role: newRole, systemRole: newRole });
        }

        const deptStr = emp.department ? ` of ${emp.department}` : "";

        try {
            const { createNotification } = await import("../notification/notification.service.js");
            const { sendRoleUpdateEmail } = await import("../email/email.service.js");

            await createNotification({
                workspaceId: workspace._id,
                recipientId: emp.linkedUser || null,
                title: "Role Appointment",
                message: `HR appointed you as ${newRole}${deptStr}. You now have ${newRole} permissions in your workspace.`,
                type: "role_appointment",
                link: "/settings/profile",
                metadata: { role: newRole, department: emp.department },
            });

            const empEmail = emp.loginEmail || emp.personalEmail;
            if (empEmail) {
                sendRoleUpdateEmail({
                    to: empEmail,
                    userName: `${emp.firstName} ${emp.lastName}`.trim(),
                    newRole,
                    department: emp.department || "",
                    companyName: workspace.companyName,
                }).catch(() => {});
            }
        } catch (err) {
            console.error("Notification error on employee role update:", err.message);
        }

        return { success: true, role: newRole };
    }

    throw ApiError.notFound("User not found");
}

export async function appointCeo(callerUserId, targetUserId) {
    const workspace = await getWorkspaceOrThrow(callerUserId);
    const caller = await User.findById(callerUserId);
    if (!caller) throw ApiError.unauthorized("User no longer exists");

    // Only the actual CEO / Workspace Owner has authority to appoint a CEO
    const isCurrentCeo = Boolean(
        (workspace.owner && workspace.owner.toString() === callerUserId.toString()) ||
        caller.role === "Founder / CEO" ||
        caller.role === "Administrator"
    );

    if (!isCurrentCeo) {
        throw ApiError.forbidden("Only the CEO / Workspace Owner has authority to appoint a CEO.");
    }

    let targetUser = await User.findById(targetUserId);
    if (!targetUser) {
        const emp = await Employee.findById(targetUserId);
        if (emp?.linkedUser) {
            targetUser = await User.findById(emp.linkedUser);
        } else if (emp?.workEmail || emp?.loginEmail) {
            targetUser = await User.findOne({ email: (emp.workEmail || emp.loginEmail).toLowerCase() });
        }
    }
    if (!targetUser) throw ApiError.notFound("Target user account not found. Please ensure the employee has a login account before appointing as CEO.");

    if (targetUser._id.toString() === callerUserId.toString()) {
        throw ApiError.badRequest("You cannot appoint yourself as CEO. You already hold CEO authority.");
    }

    // Appoint targetUser as CEO
    targetUser.role = "Founder / CEO";
    targetUser.systemRole = "Admin";
    await targetUser.save();

    await Employee.updateMany(
        { workspace: workspace._id, $or: [{ linkedUser: targetUser._id }, { loginEmail: targetUser.email }] },
        { $set: { systemRole: "Admin", designation: "Chief Executive Officer (CEO)" } }
    );

    // Set owner of workspace to appointed CEO
    workspace.owner = targetUser._id;
    await workspace.save();

    try {
        const { createNotification } = await import("../notification/notification.service.js");
        await createNotification({
            workspaceId: workspace._id,
            recipientId: targetUser._id,
            title: "Appointed as Chief Executive Officer",
            message: `You have been appointed as Chief Executive Officer (CEO) of ${workspace.companyName}.`,
            type: "role_appointment",
            link: "/settings/roles",
        });
    } catch (e) {
        console.error("Non-fatal notification error on CEO appointment:", e);
    }

    return { success: true, targetUser };
}

export async function transferCeoAndExit(callerUserId, targetEmployeeId) {
    const caller = await User.findById(callerUserId);
    if (!caller) throw ApiError.unauthorized("User not found");

    const workspace = await getWorkspaceForUser(callerUserId);
    if (!workspace) throw ApiError.notFound("Workspace not found");

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === callerUserId.toString());
    const isCeo = Boolean(isOwner || /ceo|founder|admin/i.test(caller.role || "") || caller.systemRole === "Admin");
    if (!isCeo) {
        throw ApiError.forbidden("Only the CEO / Workspace Owner has authority to transfer leadership and exit.");
    }

    const { Employee } = await import("../../model/employee/employee.model.js");
    let targetEmployee = null;
    const mongoose = (await import("mongoose")).default;
    if (mongoose.Types.ObjectId.isValid(targetEmployeeId)) {
        targetEmployee = await Employee.findOne({ workspace: workspace._id, _id: targetEmployeeId });
    }
    if (!targetEmployee) {
        targetEmployee = await Employee.findOne({ workspace: workspace._id, employeeId: targetEmployeeId });
    }
    if (!targetEmployee) {
        throw ApiError.notFound("Successor employee not found in this workspace.");
    }

    if (targetEmployee.linkedUser && targetEmployee.linkedUser.toString() === callerUserId.toString()) {
        throw ApiError.badRequest("You cannot transfer CEO leadership to yourself.");
    }

    // 1. Locate or create successor user account
    let targetUser = null;
    if (targetEmployee.linkedUser) {
        targetUser = await User.findById(targetEmployee.linkedUser);
    }
    if (!targetUser && (targetEmployee.workEmail || targetEmployee.loginEmail || targetEmployee.personalEmail)) {
        const email = (targetEmployee.workEmail || targetEmployee.loginEmail || targetEmployee.personalEmail).toLowerCase().trim();
        targetUser = await User.findOne({ email });
    }

    if (!targetUser) {
        const email = (targetEmployee.workEmail || targetEmployee.loginEmail || targetEmployee.personalEmail || `ceo.${targetEmployee.employeeId.toLowerCase()}@corpilance.com`).toLowerCase().trim();
        const { hashPassword } = await import("../../utils/password.js");
        const defaultPass = await hashPassword("CeoSuccession2026!");
        targetUser = await User.create({
            workspaceId: workspace._id,
            fullName: `${targetEmployee.firstName} ${targetEmployee.lastName}`.trim(),
            email,
            password: defaultPass,
            company: workspace.companyName || "CorpiLance",
            companySize: workspace.teamSize || "small",
            role: "Founder / CEO",
            systemRole: "Admin",
            status: "active",
            verified: true,
        });
    } else {
        targetUser.role = "Founder / CEO";
        targetUser.systemRole = "Admin";
        targetUser.status = "active";
        await targetUser.save();
    }

    // 2. Elevate successor employee profile
    targetEmployee.systemRole = "Admin";
    targetEmployee.designation = "Chief Executive Officer (CEO)";
    targetEmployee.linkedUser = targetUser._id;
    targetEmployee.createLogin = true;
    targetEmployee.loginEmail = targetUser.email;
    targetEmployee.employmentStatus = "Active";
    targetEmployee.isActive = true;
    await targetEmployee.save();

    // 3. Transfer workspace ownership
    workspace.owner = targetUser._id;
    await workspace.save();

    // 4. Record comprehensive audit log
    try {
        const { recordAuditLog } = await import("../audit/auditLog.service.js");
        await recordAuditLog({
            workspaceId: workspace._id,
            actorId: callerUserId,
            actorName: caller.fullName,
            actorRole: "CEO",
            action: "ceo.leadership_transferred_and_exit",
            module: "Settings",
            targetId: targetEmployee.employeeId,
            targetName: `${targetEmployee.firstName} ${targetEmployee.lastName}`.trim(),
            targetType: "Employee",
            description: `CEO leadership transferred from ${caller.fullName} (${caller.email}) to ${targetEmployee.firstName} ${targetEmployee.lastName} (${targetEmployee.employeeId}). Outgoing CEO user account permanently deleted.`,
        });
    } catch {}

    // 5. Update outgoing CEO's employee record if any
    await Employee.updateMany(
        { workspace: workspace._id, linkedUser: callerUserId },
        { $set: { employmentStatus: "Resigned", isActive: false, linkedUser: null } }
    );

    // 6. Permanently delete the outgoing CEO user account
    await User.deleteOne({ _id: callerUserId });

    return {
        success: true,
        message: `CEO authority transferred to ${targetEmployee.firstName} ${targetEmployee.lastName}. Your account has been permanently removed.`,
    };
}

export async function getWorkspaceOrThrow(userId) {
    const workspace = await getWorkspaceForUser(userId);
    if (!workspace) {
        throw ApiError.forbidden("No workspace found");
    }
    return workspace;
}

export async function getEmployeeIdSettings(userId) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === userId.toString());
    const roleStr = (user?.role || "").toLowerCase();
    const systemRoleStr = (user?.systemRole || "").toLowerCase();

    let employeeRoleStr = "";
    if (user) {
        const emp = await Employee.findOne({
            workspace: workspace._id,
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email?.toLowerCase() },
                { personalEmail: user.email?.toLowerCase() },
            ],
        }).select("systemRole").lean();
        if (emp?.systemRole) {
            employeeRoleStr = emp.systemRole.toLowerCase();
        }
    }

    const isCEO = Boolean(
        isOwner ||
        roleStr === "founder / ceo" ||
        roleStr === "founder" ||
        roleStr === "ceo" ||
        roleStr === "administrator" ||
        roleStr === "admin" ||
        systemRoleStr === "admin" ||
        systemRoleStr === "administrator"
    );

    const isHR = Boolean(
        !isCEO && (
            roleStr === "hr" ||
            systemRoleStr === "hr" ||
            employeeRoleStr === "hr"
        )
    );

    const canEdit = isCEO || isHR;

    const { EmployeeCounter } = await import("../../model/employee/counter.model.js");
    const counterDoc = await EmployeeCounter.findOne({ workspace: workspace._id }).lean();
    const currentSequence = counterDoc?.sequence || 0;

    const safeWs = workspace.toSafeJSON();
    const rawConfig = safeWs.employeeIdConfig || {};

    const mergedBranchCodes = {
        ...(rawConfig.branchCodes || {}),
    };

    const mergedDeptCodes = {
        ...(rawConfig.departmentCodes || {}),
    };

    const settings = {
        formatType: rawConfig.formatType || "prefix_number",
        components: Array.isArray(rawConfig.components) && rawConfig.components.length > 0
            ? rawConfig.components
            : ["prefix", "number"],
        prefix: rawConfig.prefix !== undefined ? rawConfig.prefix : "EMP",
        separator: rawConfig.separator !== undefined ? rawConfig.separator : "-",
        yearFormat: rawConfig.yearFormat || "2_digit",
        yearSource: rawConfig.yearSource || "current_year", // default automatic current year
        paddingDigits: typeof rawConfig.paddingDigits === "number" ? rawConfig.paddingDigits : 4,
        startingNumber: typeof rawConfig.startingNumber === "number" ? rawConfig.startingNumber : 1,
        defaultBranchCode: rawConfig.defaultBranchCode || "KOH",
        branchCodes: mergedBranchCodes,
        departmentCodes: mergedDeptCodes,
    };

    return {
        settings,
        currentSequence,
        isCEO,
        isHR,
        canEdit,
    };
}

export async function updateEmployeeIdSettings(userId, patch) {
    const workspace = await getWorkspaceOrThrow(userId);
    const user = await User.findById(userId);

    const isOwner = Boolean(workspace.owner && workspace.owner.toString() === userId.toString());
    const roleStr = (user?.role || "").toLowerCase();
    const systemRoleStr = (user?.systemRole || "").toLowerCase();

    let employeeRoleStr = "";
    if (user) {
        const emp = await Employee.findOne({
            workspace: workspace._id,
            $or: [
                { linkedUser: user._id },
                { loginEmail: user.email?.toLowerCase() },
                { personalEmail: user.email?.toLowerCase() },
            ],
        }).select("systemRole").lean();
        if (emp?.systemRole) {
            employeeRoleStr = emp.systemRole.toLowerCase();
        }
    }

    const isCEO = Boolean(
        isOwner ||
        roleStr === "founder / ceo" ||
        roleStr === "founder" ||
        roleStr === "ceo" ||
        roleStr === "administrator" ||
        roleStr === "admin" ||
        systemRoleStr === "admin" ||
        systemRoleStr === "administrator"
    );

    const isHR = Boolean(
        !isCEO && (
            roleStr === "hr" ||
            systemRoleStr === "hr" ||
            employeeRoleStr === "hr"
        )
    );

    if (!isCEO && !isHR) {
        throw ApiError.forbidden("Only the Founder / CEO or HR can modify Employee ID format settings");
    }

    if (!workspace.employeeIdConfig) {
        workspace.employeeIdConfig = {};
    }

    if (patch.formatType !== undefined) {
        workspace.employeeIdConfig.formatType = String(patch.formatType);
    }
    if (patch.components !== undefined && Array.isArray(patch.components)) {
        workspace.employeeIdConfig.components = patch.components.map(String);
    }
    if (patch.prefix !== undefined) {
        workspace.employeeIdConfig.prefix = String(patch.prefix).trim();
    }
    if (patch.separator !== undefined) {
        workspace.employeeIdConfig.separator = String(patch.separator);
    }
    if (patch.yearFormat !== undefined) {
        workspace.employeeIdConfig.yearFormat = String(patch.yearFormat);
    }
    if (patch.yearSource !== undefined) {
        workspace.employeeIdConfig.yearSource = String(patch.yearSource);
    }
    if (patch.paddingDigits !== undefined) {
        workspace.employeeIdConfig.paddingDigits = Math.max(1, Math.min(8, Number(patch.paddingDigits)));
    }
    if (patch.startingNumber !== undefined) {
        workspace.employeeIdConfig.startingNumber = Math.max(1, Number(patch.startingNumber));
    }
    if (patch.defaultBranchCode !== undefined) {
        workspace.employeeIdConfig.defaultBranchCode = String(patch.defaultBranchCode).trim();
    }
    if (patch.branchCodes !== undefined && typeof patch.branchCodes === "object") {
        workspace.employeeIdConfig.branchCodes = patch.branchCodes;
    }
    if (patch.departmentCodes !== undefined && typeof patch.departmentCodes === "object") {
        workspace.employeeIdConfig.departmentCodes = patch.departmentCodes;
    }

    workspace.markModified("employeeIdConfig");
    await workspace.save();

    return await getEmployeeIdSettings(userId);
}


