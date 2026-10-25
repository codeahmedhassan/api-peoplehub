import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";

import routes from "./routes/index.js";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { verifyMailer } from "./config/mailer.js";
import { notFound, errorHandler } from "./middleware/error/error.middleware.js";
import { startAttendanceRollupJob } from "./jobs/attendance-rollup.job.js";

const app = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(
    cors({
        origin: [env.cors.marketingUrl, env.cors.adminUrl],
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());
app.use(morgan(env.isProd ? "combined" : "dev"));

app.use("/api/v1", routes);

app.use(notFound);
app.use(errorHandler);

(async () => {
    await connectDB();
    await verifyMailer();
    startAttendanceRollupJob();
    app.listen(env.port, () => {
        console.log(`🚀 API running at http://localhost:${env.port}`);
    });
})();