import os from "os";
import mongoose from "mongoose";
import { ApmMetric } from "../../model/observability/apmMetric.model.js";
import { ApmSnapshot } from "../../model/observability/apmSnapshot.model.js";

class ProprietaryApmService {
    constructor() {
        // Rolling in-memory window for instant zero-IOPS calculations
        this.recentDurations = [];
        this.maxWindowSize = 5000;
        this.requestCountsInWindow = { total: 0, errors: 0 };
        this.endpointStats = new Map(); // endpoint -> { count, totalDuration, method }
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuTime = Date.now();
        this.metricBatchBuffer = [];
        this.snapshotTimer = null;

        this.startPeriodicSnapshot();
    }

    startPeriodicSnapshot() {
        if (this.snapshotTimer) return;
        // Snapshot every 60 seconds
        this.snapshotTimer = setInterval(() => {
            this.recordPeriodicSnapshot().catch(() => {});
        }, 60000);

        if (this.snapshotTimer.unref) {
            this.snapshotTimer.unref();
        }
    }

    /**
     * Records a finished HTTP request. Non-blocking and lightweight.
     */
    recordRequest({ endpoint, method, statusCode, durationMs, dbDurationMs = 0, requestId = null, workspaceId = null }) {
        try {
            const isError = statusCode >= 400;

            // 1. Maintain in-memory percentile window
            this.recentDurations.push(durationMs);
            if (this.recentDurations.length > this.maxWindowSize) {
                this.recentDurations.shift();
            }

            this.requestCountsInWindow.total += 1;
            if (isError) this.requestCountsInWindow.errors += 1;

            // 2. Track endpoint aggregations
            const key = `${method} ${endpoint}`;
            const existing = this.endpointStats.get(key) || { count: 0, totalDuration: 0, method, endpoint };
            existing.count += 1;
            existing.totalDuration += durationMs;
            this.endpointStats.set(key, existing);

            // 3. Batch metrics (sample non-slow successful requests, always record slow or error requests)
            const shouldPersist = isError || durationMs > 300 || Math.random() < 0.2;
            if (shouldPersist) {
                this.metricBatchBuffer.push({
                    endpoint,
                    method,
                    statusCode,
                    durationMs,
                    dbDurationMs,
                    isError,
                    requestId,
                    workspaceId,
                    timestamp: new Date(),
                });

                if (this.metricBatchBuffer.length >= 50) {
                    this.flushMetricBuffer().catch(() => {});
                }
            }
        } catch {
            // Never disrupt request flow
        }
    }

    async flushMetricBuffer() {
        if (this.metricBatchBuffer.length === 0) return;
        const batch = this.metricBatchBuffer.splice(0, this.metricBatchBuffer.length);
        try {
            await ApmMetric.insertMany(batch, { ordered: false });
        } catch {
            // Non-blocking
        }
    }

    /**
     * Calculate percentiles (P50, P95, P99) from sorted duration array.
     */
    calculatePercentiles(durations) {
        if (!durations || durations.length === 0) {
            return { avg: 0, p50: 0, p95: 0, p99: 0 };
        }

        const sorted = [...durations].sort((a, b) => a - b);
        const sum = sorted.reduce((acc, val) => acc + val, 0);
        const avg = Math.round((sum / sorted.length) * 100) / 100;

        const getPercentile = (p) => {
            const index = Math.ceil((p / 100) * sorted.length) - 1;
            return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
        };

        return {
            avg,
            p50: getPercentile(50),
            p95: getPercentile(95),
            p99: getPercentile(99),
        };
    }

    /**
     * Compute current CPU percentage utilization.
     */
    getCpuPercentage() {
        const now = Date.now();
        const timeDiff = (now - this.lastCpuTime) * 1000; // in microseconds
        if (timeDiff <= 0) return 0;

        const currentCpu = process.cpuUsage(this.lastCpuUsage);
        this.lastCpuUsage = process.cpuUsage();
        this.lastCpuTime = now;

        const numCpus = os.cpus().length || 1;
        const totalMicros = currentCpu.user + currentCpu.system;
        const percent = (totalMicros / (timeDiff * numCpus)) * 100;
        return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
    }

    /**
     * Measure active MongoDB ping latency.
     */
    async measureDbPingMs() {
        try {
            if (mongoose.connection?.readyState !== 1) return -1;
            const start = process.hrtime.bigint();
            await mongoose.connection.db.admin().ping();
            const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
            return Math.round(elapsed * 10) / 10;
        } catch {
            return -1;
        }
    }

    /**
     * Record 60-second rollup snapshot.
     */
    async recordPeriodicSnapshot() {
        try {
            const memory = process.memoryUsage();
            const totalSysMem = os.totalmem();
            const freeSysMem = os.freemem();
            const usedSysMem = totalSysMem - freeSysMem;

            const percentiles = this.calculatePercentiles(this.recentDurations);
            const totalReqs = this.requestCountsInWindow.total;
            const errorReqs = this.requestCountsInWindow.errors;
            const errorRate = totalReqs > 0 ? Math.round((errorReqs / totalReqs) * 10000) / 100 : 0;
            const rpm = totalReqs; // 60-second window represents requests per minute

            // Reset 60s window counts
            this.requestCountsInWindow = { total: 0, errors: 0 };

            // Find slowest endpoints
            const slowest = Array.from(this.endpointStats.values())
                .map((ep) => ({
                    endpoint: ep.endpoint,
                    method: ep.method,
                    count: ep.count,
                    avgDurationMs: Math.round(ep.totalDuration / ep.count),
                }))
                .sort((a, b) => b.avgDurationMs - a.avgDurationMs)
                .slice(0, 5);

            this.endpointStats.clear();

            const cpuPercent = this.getCpuPercentage();
            const dbPingMs = await this.measureDbPingMs();

            const snapshot = new ApmSnapshot({
                periodSeconds: 60,
                totalRequests: totalReqs,
                errorRequests: errorReqs,
                errorRatePercent: errorRate,
                rpm,
                avgDurationMs: percentiles.avg,
                p50DurationMs: percentiles.p50,
                p95DurationMs: percentiles.p95,
                p99DurationMs: percentiles.p99,
                system: {
                    cpuPercent,
                    memoryHeapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
                    memoryRssMb: Math.round(memory.rss / (1024 * 1024)),
                    memoryTotalMb: Math.round(totalSysMem / (1024 * 1024)),
                    memoryUsagePercent: Math.round((usedSysMem / totalSysMem) * 100),
                    uptimeSeconds: Math.round(process.uptime()),
                    eventLoopLagMs: 0,
                    dbPingMs,
                },
                slowestEndpoints: slowest,
            });

            await snapshot.save();
        } catch {
            // Fail silently
        }
    }

    /**
     * Get live telemetry for Super Admin dashboard.
     */
    async getRealtimeTelemetry() {
        const memory = process.memoryUsage();
        const totalSysMem = os.totalmem();
        const freeSysMem = os.freemem();
        const usedSysMem = totalSysMem - freeSysMem;

        const percentiles = this.calculatePercentiles(this.recentDurations);
        const cpuPercent = this.getCpuPercentage();
        const dbPingMs = await this.measureDbPingMs();

        // Query last snapshot or calculate instantaneous
        const lastSnapshot = await ApmSnapshot.findOne().sort({ timestamp: -1 }).lean();

        return {
            rpm: lastSnapshot?.rpm ?? this.requestCountsInWindow.total,
            avgLatencyMs: percentiles.avg,
            p50LatencyMs: percentiles.p50,
            p95LatencyMs: percentiles.p95,
            p99LatencyMs: percentiles.p99,
            errorRatePercent: lastSnapshot?.errorRatePercent ?? 0,
            system: {
                cpuPercent,
                heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
                rssMb: Math.round(memory.rss / (1024 * 1024)),
                totalRamMb: Math.round(totalSysMem / (1024 * 1024)),
                ramUsagePercent: Math.round((usedSysMem / totalSysMem) * 100),
                uptimeSeconds: Math.round(process.uptime()),
                dbPingMs,
                dbStatus: mongoose.connection?.readyState === 1 ? "healthy" : "disconnected",
                activeConnections: mongoose.connection?.readyState === 1 ? 1 : 0,
            },
        };
    }

    /**
     * Get historical snapshots over a timeframe (1h, 6h, 24h, 7d).
     */
    async getHistoricalSnapshots(hours = 24) {
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        return ApmSnapshot.find({ timestamp: { $gte: since } })
            .sort({ timestamp: 1 })
            .limit(1440)
            .lean();
    }

    /**
     * Get slowest endpoints ranked from raw metrics or recent snapshots.
     */
    async getSlowestEndpoints(limit = 10) {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const results = await ApmMetric.aggregate([
            { $match: { timestamp: { $gte: oneDayAgo } } },
            {
                $group: {
                    _id: { endpoint: "$endpoint", method: "$method" },
                    avgDurationMs: { $avg: "$durationMs" },
                    p95DurationMs: { $max: "$durationMs" },
                    requestCount: { $sum: 1 },
                    errorCount: { $sum: { $cond: ["$isError", 1, 0] } },
                },
            },
            { $sort: { avgDurationMs: -1 } },
            { $limit: limit },
        ]);

        return results.map((r) => ({
            endpoint: r._id.endpoint,
            method: r._id.method,
            avgDurationMs: Math.round(r.avgDurationMs),
            requestCount: r.requestCount,
            errorCount: r.errorCount,
        }));
    }
}

export const apmService = new ProprietaryApmService();
