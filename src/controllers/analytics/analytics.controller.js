import { eventEngine } from "../../services/observability/eventEngine.service.js";

export async function ingestEventController(req, res) {
    // Keep response non-blocking: return 202 Accepted immediately
    try {
        const clientPayload = req.body || {};
        eventEngine.ingestClientEvent(req, clientPayload).catch(() => {});
        res.status(202).json({ success: true, message: "Event queued for ingestion" });
    } catch (err) {
        // Even on validation failure, do not break client flow
        res.status(200).json({ success: false, message: err.message });
    }
}
