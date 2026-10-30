import crypto from "node:crypto";
import { Device } from "../../model/attendance/device.model.js";
import { DeviceLink } from "../../model/attendance/deviceLink.model.js";
import { Employee } from "../../model/employee/employee.model.js";
import { Workspace } from "../../model/workspace/workspace.model.js";
import { getWorkspaceOrThrow } from "../../services/workspace/workspace.service.js";
import { ApiError } from "../../utils/ApiError.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { asyncHandler } from "../../utils/asyncHandler.js";

// --- Admin: Get all devices ---
export const getDevices = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const devices = await Device.find({ workspace: workspace._id }).sort({ createdAt: -1 });

    return res.status(200).json(new ApiResponse(200, {
        devices: devices.map(d => ({
            id: d._id,
            name: d.name,
            location: d.location,
            status: d.status === "active" ? "Active" : "Revoked",
            lastSeen: d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Never",
            createdAt: d.createdAt.toISOString().slice(0, 10),
            apiKeyPreview: d.apiKeyPrefix,
        }))
    }, "Devices loaded"));
});

// --- Admin: Create device ---
export const createDevice = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { name, location } = req.body;

    const { rawKey, hash, prefix } = Device.generateApiKey();

    const device = await Device.create({
        workspace: workspace._id,
        name,
        location,
        apiKeyHash: hash,
        apiKeyPrefix: prefix + "••••",
    });

    return res.status(201).json(new ApiResponse(201, {
        device: {
            id: device._id,
            name: device.name,
            apiKey: rawKey, // Only sent once
        }
    }, "Device created"));
});

// --- Admin: Revoke device ---
export const revokeDevice = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const device = await Device.findOneAndUpdate(
        { _id: req.params.id, workspace: workspace._id },
        { status: "revoked" },
        { new: true }
    );
    if (!device) throw ApiError.notFound("Device not found");
    return res.status(200).json(new ApiResponse(200, null, "Device revoked"));
});

// --- Admin: Get mappings for a device ---
export const getDeviceLinks = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);

    // Fetch all employees in the workspace
    const employees = await Employee.find({ workspace: workspace._id }).select("_id employeeId firstName lastName avatar").lean();

    // Fetch existing links for this device
    const links = await DeviceLink.find({ workspace: workspace._id, device: req.params.id }).lean();
    const linkMap = new Map(links.map(l => [l.employee.toString(), l.deviceUserId]));

    const result = employees.map(e => ({
        _id: e._id.toString(), // Mongo ID
        employeeId: e.employeeId,
        name: `${e.firstName} ${e.lastName}`.trim(),
        avatar: e.avatar,
        deviceUserId: linkMap.get(e._id.toString()) || "",
    }));

    return res.status(200).json(new ApiResponse(200, { employees: result }, "Links loaded"));
});

// --- Admin: Save mapping ---
export const saveDeviceLink = asyncHandler(async (req, res) => {
    const workspace = await getWorkspaceOrThrow(req.userId);
    const { employeeMongoId, deviceUserId } = req.body;
    const deviceId = req.params.id;

    if (!deviceUserId) {
        // Unlink
        await DeviceLink.findOneAndDelete({
            workspace: workspace._id,
            device: deviceId,
            employee: employeeMongoId,
        });
        return res.status(200).json(new ApiResponse(200, null, "Employee unlinked"));
    }

    // Upsert link
    await DeviceLink.findOneAndUpdate(
        { workspace: workspace._id, device: deviceId, employee: employeeMongoId },
        { deviceUserId: deviceUserId.trim() },
        { upsert: true }
    );

    return res.status(200).json(new ApiResponse(200, null, "Employee linked"));
});

// --- Device: Ingest Punch ---
export const handleDevicePunch = asyncHandler(async (req, res) => {
    const rawApiKey = req.headers["x-device-key"];
    if (!rawApiKey || typeof rawApiKey !== "string") {
        throw ApiError.unauthorized("Missing x-device-key header");
    }

    const hash = crypto.createHash("sha256").update(rawApiKey).digest("hex");

    const device = await Device.findOne({ apiKeyHash: hash, status: "active" });
    if (!device) throw ApiError.unauthorized("Invalid or revoked device key");

    device.lastSeenAt = new Date();
    await device.save();

    const { deviceUserId, timestamp } = req.body;
    if (!deviceUserId || !timestamp) throw ApiError.badRequest("Missing deviceUserId or timestamp");

    const link = await DeviceLink.findOne({ device: device._id, deviceUserId });
    if (!link) throw ApiError.notFound(`No employee linked to device user ID: ${deviceUserId}`);

    const punchTime = new Date(timestamp);
    const dateString = punchTime.toISOString().slice(0, 10);

    let record = await AttendanceRecord.findOne({
        workspace: device.workspace,
        employee: link.employee,
        date: dateString
    });

    if (!record) {
        record = await AttendanceRecord.create({
            workspace: device.workspace,
            employee: link.employee,
            date: dateString,
            status: "present",
            source: "device",
            checkIn: punchTime,
            deviceMarkedPresent: true,
            deviceMarkedAt: punchTime,
            deviceId: device._id.toString()
        });
    } else {
        if (!record.checkIn) {
            record.checkIn = punchTime;
        } else if (!record.checkOut && punchTime > record.checkIn) {
            record.checkOut = punchTime;
        }
        if (["absent", "unmarked", "weekend"].includes(record.status)) {
            record.status = "present";
            record.source = "device";
            record.deviceMarkedPresent = true;
            record.deviceMarkedAt = punchTime;
        }
        await record.save();
    }

    return res.status(200).json(new ApiResponse(200, null, "Punch recorded successfully"));
});