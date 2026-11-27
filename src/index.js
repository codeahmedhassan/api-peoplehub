import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";

import routes from "./routes/index.js";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { verifyMailer } from "./config/mailer.js";
import { notFound, errorHandler } from "./middleware/error/error.middleware.js";
import { startAttendanceRollupJob } from "./jobs/attendance-rollup.job.js";
import { requestTraceMiddleware } from "./middleware/observability/requestTrace.middleware.js";
import { syncAllWorkspacesStorage } from "./services/workspace/plan.service.js";
import { globalApiLimiter } from "./middleware/rateLimit/rateLimit.middleware.js";
import { sanitizeObjectInPlace } from "./utils/security.js";

// Note: Express input sanitization (sanitizeObjectInPlace) already strips incoming `$` operators
// from req.body/query/params at the HTTP boundary without breaking trusted server `$in`/`$ne`/`$gte` queries.

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
    helmet({
        crossOriginResourcePolicy: { policy: "cross-origin" },
        referrerPolicy: { policy: "strict-origin-when-cross-origin" },
        hsts: env.isProd
            ? { maxAge: 31536000, includeSubDomains: true, preload: true }
            : false,
    })
);

const extraOrigins = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const devOrigins = env.isProd
    ? []
    : [
          "http://localhost:3000",
          "http://localhost:3001",
          "http://localhost:3002",
          "http://localhost:3003",
          "http://127.0.0.1:3000",
          "http://127.0.0.1:3001",
          "http://127.0.0.1:3002",
          "http://127.0.0.1:3003",
      ];

const defaultOrigins = [
    ...devOrigins,
    "https://corpilance.com",
    "https://www.corpilance.com",
    "https://admin.corpilance.com",
    "https://superadmin.corpilance.com",
    "https://corpilance.tech",
    "https://www.corpilance.tech",
    "https://admin.corpilance.tech",
    "https://admin.corpilace.tech",
    "https://superadmin.corpilance.tech",
    "https://console.corpilance.tech",
];

const allowedOrigins = new Set(
    [
        env.cors.marketingUrl,
        env.cors.adminUrl,
        env.cors.superAdminUrl,
        ...extraOrigins,
        ...defaultOrigins,
    ]
        .filter(Boolean)
        .map((url) => String(url).replace(/\/$/, ""))
);

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);

        const normalized = origin.replace(/\/$/, "");
        if (allowedOrigins.has(normalized)) {
            return callback(null, true);
        }

        // Allow localhost ports strictly in non-production
        if (!env.isProd && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)) {
            return callback(null, true);
        }

        return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-device-key", "X-Requested-With", "Cache-Control"],
    exposedHeaders: ["Content-Disposition"],
    optionsSuccessStatus: 204,
};

app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(cookieParser());

// Global input sanitizer against NoSQL $ operators & prototype pollution
app.use((req, _res, next) => {
    if (req.body && typeof req.body === "object") sanitizeObjectInPlace(req.body);
    if (req.query && typeof req.query === "object") sanitizeObjectInPlace(req.query);
    if (req.params && typeof req.params === "object") sanitizeObjectInPlace(req.params);
    next();
});

app.use(requestTraceMiddleware);
app.use(morgan(env.isProd ? "combined" : "dev"));

app.use("/api/v1", globalApiLimiter, routes);

app.use(notFound);
app.use(errorHandler);

(async () => {
    await connectDB();
    await verifyMailer();
    startAttendanceRollupJob();
    syncAllWorkspacesStorage().catch((err) => console.error("Initial storage sync warning:", err));
    const server = app.listen(env.port, () => {
        console.log(`API running at port ${env.port} (${env.nodeEnv})`);
    });

    const shutdown = async (signal) => {
        console.log(`[shutdown] Received ${signal}. Closing HTTP server and DB connection...`);
        server.close(async () => {
            try {
                await mongoose.connection.close(false);
            } catch {
                // ignore
            }
            process.exit(0);
        });
        setTimeout(() => process.exit(1), 10000).unref();
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
})();
