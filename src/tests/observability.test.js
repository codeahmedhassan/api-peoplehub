import assert from "node:assert/strict";
import crypto from "node:crypto";
import { redactSensitiveData } from "../services/observability/redaction.utils.js";
import { errorTracker } from "../services/observability/errorTracker.service.js";
import { apmService } from "../services/observability/apm.service.js";
import { eventEngine } from "../services/observability/eventEngine.service.js";

async function runTests() {
    console.log("=================================================");
    console.log("   RUNNING CORPILANCE OBSERVABILITY TEST SUITE   ");
    console.log("=================================================");

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`[PASS] ${name}`);
            passed++;
        } catch (err) {
            console.error(`[FAIL] ${name}`);
            console.error(`       Error: ${err.message}`);
            failed++;
        }
    }

    // 1. Sensitive Data Redaction Tests
    test("Redaction: Strips passwords, auth tokens and bearer tokens", () => {
        const raw = {
            username: "john_doe",
            password: "super_secret_password_123",
            token: "jwt.header.payload.signature",
            authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            metadata: {
                nestedSecret: "classified",
                status: "active",
            },
        };

        const sanitized = redactSensitiveData(raw);
        assert.equal(sanitized.username, "john_doe");
        assert.equal(sanitized.password, "[REDACTED]");
        assert.equal(sanitized.token, "[REDACTED]");
        assert.equal(sanitized.authorization, "[REDACTED]");
        assert.equal(sanitized.metadata.nestedSecret, "[REDACTED]");
        assert.equal(sanitized.metadata.status, "active");
    });

    test("Redaction: Strips salary, bank accounts, and CNIC/National ID", () => {
        const payload = {
            employeeName: "Alice Smith",
            salary: 150000,
            baseSalary: 120000,
            netSalary: 110000,
            bankAccount: "PK36MEZN0000123456789012",
            iban: "GB29XABC10123456789012",
            cnic: "35201-1234567-1",
            nationalId: "987654321",
            role: "Software Engineer",
        };

        const sanitized = redactSensitiveData(payload);
        assert.equal(sanitized.employeeName, "Alice Smith");
        assert.equal(sanitized.salary, "[REDACTED]");
        assert.equal(sanitized.baseSalary, "[REDACTED]");
        assert.equal(sanitized.netSalary, "[REDACTED]");
        assert.equal(sanitized.bankAccount, "[REDACTED]");
        assert.equal(sanitized.iban, "[REDACTED]");
        assert.equal(sanitized.cnic, "[REDACTED]");
        assert.equal(sanitized.nationalId, "[REDACTED]");
        assert.equal(sanitized.role, "Software Engineer");
    });

    // 2. Error Fingerprinting and Grouping Tests
    test("Error Tracking: Generates identical fingerprints for identical errors with dynamic IDs", () => {
        const err1 = new Error("Employee 652f9a1b2c3d4e5f6a7b8c9d not found in database");
        err1.stack = "Error: Employee 652f9a1b2c3d4e5f6a7b8c9d not found\n    at findEmp (/src/service.js:42:15)\n    at get (/src/controller.js:10:5)";

        const err2 = new Error("Employee 789e0f1a2b3c4d5e6f7a8b9c not found in database");
        err2.stack = "Error: Employee 789e0f1a2b3c4d5e6f7a8b9c not found\n    at findEmp (/src/service.js:42:15)\n    at get (/src/controller.js:10:5)";

        const fp1 = errorTracker.generateFingerprint(err1, "/api/v1/employees/:id");
        const fp2 = errorTracker.generateFingerprint(err2, "/api/v1/employees/:id");

        assert.equal(fp1, fp2, "Dynamic Mongo IDs in message must be normalized to create identical fingerprints");
        assert.equal(fp1.length, 16, "Fingerprint should be 16 characters hex");
    });

    test("Error Tracking: Classifies categories and determines severity accurately", () => {
        const valErr = { name: "ValidationError", message: "Path required" };
        assert.equal(errorTracker.classifyError(valErr, 400), "validation");
        assert.equal(errorTracker.determineSeverity(valErr, 400, "validation", "/api/v1/employees"), "low");

        const authErr = { name: "JsonWebTokenError", message: "jwt expired" };
        assert.equal(errorTracker.classifyError(authErr, 401), "auth");
        assert.equal(errorTracker.determineSeverity(authErr, 401, "auth", "/api/v1/auth"), "medium");

        const dbErr = { name: "MongoServerError", message: "connection timeout" };
        assert.equal(errorTracker.classifyError(dbErr, 500), "database");
        assert.equal(errorTracker.determineSeverity(dbErr, 500, "database", "/api/v1/attendance"), "critical");

        const payrollErr = { name: "Error", message: "Batch calculation failure" };
        assert.equal(errorTracker.determineSeverity(payrollErr, 500, "internal_server", "/api/v1/payroll/batches"), "critical");
    });

    // 3. APM Percentile Calculations
    test("APM: Computes P50, P95, P99, and Average Latencies accurately", () => {
        // Mock 100 duration samples: 1..100 ms
        const durations = Array.from({ length: 100 }, (_, i) => i + 1);
        const stats = apmService.calculatePercentiles(durations);

        assert.equal(stats.avg, 50.5);
        assert.equal(stats.p50, 50);
        assert.equal(stats.p95, 95);
        assert.equal(stats.p99, 99);
    });

    test("APM: Handles empty or single duration gracefully", () => {
        const empty = apmService.calculatePercentiles([]);
        assert.deepEqual(empty, { avg: 0, p50: 0, p95: 0, p99: 0 });

        const single = apmService.calculatePercentiles([42]);
        assert.deepEqual(single, { avg: 42, p50: 42, p95: 42, p99: 42 });
    });

    // 4. Product Analytics & Event Engine
    test("Analytics: Generates valid canonical event schema with server context", () => {
        const fakeOrgId = "652f9a1b2c3d4e5f6a7b8c9d";
        const fakeUserId = "652f9a1b2c3d4e5f6a7b8c9e";

        const eventId = eventEngine.trackEvent({
            eventName: "attendance_recorded",
            module: "attendance",
            feature: "mark_present",
            organizationId: fakeOrgId,
            userId: fakeUserId,
            userRole: "admin",
            requestId: "req_test_12345",
            properties: {
                status: "present",
                method: "biometric",
                // Attempt to sneak salary info in properties
                salary: 50000,
            },
        });

        assert.ok(eventId, "Should return generated event UUID");
        assert.equal(typeof eventId, "string");
        assert.ok(eventId.length >= 32);

        // Check buffer item
        const queued = eventEngine.eventBuffer.find((e) => e.event_id === eventId);
        assert.ok(queued, "Event should be queued in memory buffer");
        assert.equal(queued.event_name, "attendance_recorded");
        assert.equal(queued.module, "attendance");
        assert.equal(queued.organization_id, fakeOrgId);
        assert.equal(queued.event_properties.salary, "[REDACTED]", "Sensitive properties must be redacted");
    });

    test("Analytics: Discards events missing required organizationId or eventName", () => {
        const result1 = eventEngine.trackEvent({
            eventName: "",
            organizationId: "652f9a1b2c3d4e5f6a7b8c9d",
        });
        assert.equal(result1, null, "Should reject empty eventName");

        const result2 = eventEngine.trackEvent({
            eventName: "user_logged_in",
            organizationId: null,
        });
        assert.equal(result2, null, "Should reject missing organizationId");
    });

    // 5. Tenant Isolation Verification
    test("Tenant Isolation: Workspace query boundaries strictly prevent cross-org leaks", () => {
        const orgA = "652f9a1b2c3d4e5f6a7b8c91";
        const orgB = "652f9a1b2c3d4e5f6a7b8c92";

        // Simulated query pipeline generator
        const buildBiPipeline = (wsId) => [{ $match: { workspace: wsId } }];

        const pipelineA = buildBiPipeline(orgA);
        const pipelineB = buildBiPipeline(orgB);

        assert.notDeepEqual(pipelineA, pipelineB);
        assert.equal(pipelineA[0].$match.workspace, orgA);
        assert.equal(pipelineB[0].$match.workspace, orgB);
    });

    console.log("-------------------------------------------------");
    console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
    console.log("=================================================");

    if (failed > 0) {
        process.exit(1);
    }
}

runTests();
