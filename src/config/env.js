import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();
if (!process.env.MONGODB_URI) {
    dotenv.config({ path: path.resolve(__dirname, "../../.env") });
}

const required = [
    "MONGODB_URI",
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
    "EMAIL_VERIFY_SECRET",
    "DOCUMENT_KEK",
];

for (const key of required) {
    if (!process.env[key]) {
        throw new Error(`Missing required env variable: ${key}`);
    }
}

export const env = {
    nodeEnv: process.env.NODE_ENV || "development",
    port: Number(process.env.PORT) || 3000,
    isProd: process.env.NODE_ENV === "production",

    mongoUri: process.env.MONGODB_URI,

    jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
        accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
        refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
    },

    emailVerify: {
        secret: process.env.EMAIL_VERIFY_SECRET,
        expiresIn: process.env.EMAIL_VERIFY_EXPIRES_IN || "24h",
    },

    cors: {
        marketingUrl: (process.env.MARKETING_URL || "http://localhost:3001").replace(/\/$/, ""),
        adminUrl: (process.env.ADMIN_URL || "http://localhost:3002").replace(/\/$/, ""),
        superAdminUrl: (process.env.SUPER_ADMIN_URL || "http://localhost:3003").replace(/\/$/, ""),
    },

    cookie: (() => {
        const isProduction = process.env.NODE_ENV === "production";
        const secure = isProduction ? process.env.COOKIE_SECURE !== "false" : false;
        const requestedSameSite = process.env.COOKIE_SAME_SITE || (isProduction ? "none" : "lax");
        // Browsers reject SameSite=None when Secure=false
        const sameSite = !secure && requestedSameSite === "none" ? "lax" : requestedSameSite;
        const rawDomain = (process.env.COOKIE_DOMAIN || "localhost").trim();
        return {
            domain: rawDomain,
            secure,
            sameSite,
        };
    })(),

    smtp: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 465,
        secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM || "CorpiLance <no-reply@corpilance.com>",
    },

    // -------------------------------------------------------------------
    // Document encryption
    // -------------------------------------------------------------------
    documentKek: process.env.DOCUMENT_KEK, // base64, 32 bytes

    // -------------------------------------------------------------------
    // S3
    // -------------------------------------------------------------------
    s3: {
        region: process.env.AWS_REGION || "us-east-1",
        bucket: process.env.AWS_S3_BUCKET || "corpilance",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
};