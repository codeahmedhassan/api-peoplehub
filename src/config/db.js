import mongoose from "mongoose";
import { env } from "./env.js";

export async function connectDB() {
    try {
        mongoose.set("strictQuery", true);
        await mongoose.connect(env.mongoUri, {
            maxPoolSize: 25,
            minPoolSize: 5,
            serverSelectionTimeoutMS: 5000,
            socketTimeoutMS: 45000,
            heartbeatFrequencyMS: 10000,
        });
        console.log("✅ MongoDB connected");
    } catch (err) {
        console.error("❌ MongoDB connection error:", err.message);
        process.exit(1);
    }
}