import dotenv from "dotenv";

dotenv.config();

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
        marketingUrl: process.env.MARKETING_URL || "http://localhost:3001",
        adminUrl: process.env.ADMIN_URL || "http://localhost:3002",
    },

    cookie: {
        domain: process.env.COOKIE_DOMAIN || "localhost",
        secure: process.env.COOKIE_SECURE === "true",
        sameSite: process.env.COOKIE_SAME_SITE || (process.env.NODE_ENV === "production" ? "none" : "lax"),
    },

    smtp: {
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 465,
        secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
        from: process.env.EMAIL_FROM || "PeopleHub <no-reply@peoplehub.com>",
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
        bucket: process.env.AWS_S3_BUCKET,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
};