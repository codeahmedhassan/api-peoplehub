// src/jobs/attendance-rollup.job.js
import cron from "node-cron";
import { runHourlyRollupSweep } from "../services/attendance/attendance.service.js";
import { ROLLUP_INTERVAL_CRON } from "../constants/attendance.js";

/**
 * Starts the hourly attendance rollup cron.
 * Called once at server boot from src/index.js.
 *
 * Runs at :15 past every hour. For each workspace, checks if its local
 * midnight has passed since last processed. If so, marks absent/weekend/holiday
 * for the last N completed days.
 */
export function startAttendanceRollupJob() {
    const task = cron.schedule(ROLLUP_INTERVAL_CRON, async () => {
        try {
            const result = await runHourlyRollupSweep();
            if (result.workspacesProcessed > 0) {
                console.log(
                    `[attendance-rollup] processed ${result.workspacesProcessed}/${result.totalWorkspaces} workspaces`
                );
            }
        } catch (err) {
            console.error("[attendance-rollup] sweep failed:", err.message);
        }
    });

    console.log(
        `[attendance-rollup] scheduled (${ROLLUP_INTERVAL_CRON})`
    );

    return task;
}