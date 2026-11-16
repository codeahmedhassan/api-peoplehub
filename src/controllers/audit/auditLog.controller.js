import { asyncHandler } from "../../utils/asyncHandler.js";
import { ApiResponse } from "../../utils/ApiResponse.js";
import { getWorkspaceAuditLogs } from "../../services/audit/auditLog.service.js";

export const getWorkspaceAuditLogsController = asyncHandler(async (req, res) => {
    const result = await getWorkspaceAuditLogs(req.userId, req.query);
    return res.status(200).json(new ApiResponse(200, result, "Audit logs retrieved successfully"));
});
