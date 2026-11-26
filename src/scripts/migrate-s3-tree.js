// src/scripts/migrate-s3-tree.js
/**
 * Migration Script: Migrate existing S3 keys to canonical tree structure:
 *
 * corpilance/
 * │
 * ├── users/
 * │   └── user-id/
 * │       ├── profile/
 * │       └── documents/
 * │
 * ├── employees/
 * │   └── employee-id/
 * │       ├── profile/
 * │       ├── documents/
 * │       └── attachments/
 * │
 * ├── messages/
 * │   └── conversation-id/
 * │       ├── images/
 * │       ├── videos/
 * │       └── voice/
 * │
 * └── organizations/
 *     └── organization-id/
 *         ├── logos/
 *         └── documents/
 *
 * Usage:
 *   node --env-file=api/.env api/src/scripts/migrate-s3-tree.js [--dry-run]
 */

import mongoose from "mongoose";
import { S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Employee } from "../model/employee/employee.model.js";
import { ChatMessage } from "../model/chat/message.model.js";
import { env } from "../config/env.js";
import { getEmployeeDocumentPath, getMessageVoicePath } from "../services/storage/s3-paths.service.js";

const isDryRun = process.argv.includes("--dry-run");

async function checkS3ObjectExists(client, bucket, key) {
    try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
}

async function run() {
    console.log(`[Migration] Starting S3 tree migration. Dry Run: ${isDryRun}`);
    console.log(`[Migration] Target Bucket: ${env.s3.bucket}`);

    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/hr_database");
    console.log("[Migration] Connected to MongoDB");

    const s3 = new S3Client({
        region: env.s3.region,
        credentials: {
            accessKeyId: env.s3.accessKeyId,
            secretAccessKey: env.s3.secretAccessKey,
        },
    });

    let migratedDocsCount = 0;
    let migratedVoicesCount = 0;

    // 1. Migrate Employee Documents
    const employees = await Employee.find({ "documents.0": { $exists: true } });
    console.log(`[Migration] Checking documents across ${employees.length} employees...`);

    for (const emp of employees) {
        let changed = false;
        for (const doc of emp.documents || []) {
            if (!doc.s3Key) continue;

            const canonicalKey = getEmployeeDocumentPath(emp._id.toString(), `${doc.fileId}.enc`);
            if (doc.s3Key !== canonicalKey) {
                console.log(`[Employee Doc] Found legacy key:\n  FROM: ${doc.s3Key}\n    TO: ${canonicalKey}`);
                if (!isDryRun) {
                    const exists = await checkS3ObjectExists(s3, env.s3.bucket, doc.s3Key);
                    if (exists) {
                        // Copy object to new canonical key
                        await s3.send(new CopyObjectCommand({
                            Bucket: env.s3.bucket,
                            CopySource: `${env.s3.bucket}/${doc.s3Key}`,
                            Key: canonicalKey,
                        }));
                        // Delete old object
                        await s3.send(new DeleteObjectCommand({
                            Bucket: env.s3.bucket,
                            Key: doc.s3Key,
                        }));
                    }
                    doc.s3Key = canonicalKey;
                    changed = true;
                }
                migratedDocsCount++;
            }
        }
        if (changed && !isDryRun) {
            await emp.save();
        }
    }

    // 2. Migrate Chat Voice Messages
    const voiceMessages = await ChatMessage.find({ "voice.s3Key": { $exists: true } });
    console.log(`[Migration] Checking ${voiceMessages.length} chat voice messages...`);

    for (const msg of voiceMessages) {
        if (!msg.voice?.s3Key) continue;

        const canonicalKey = getMessageVoicePath(msg.conversation.toString(), `${msg._id.toString()}.enc`);
        if (msg.voice.s3Key !== canonicalKey) {
            console.log(`[Voice Msg] Found legacy key:\n  FROM: ${msg.voice.s3Key}\n    TO: ${canonicalKey}`);
            if (!isDryRun) {
                const exists = await checkS3ObjectExists(s3, env.s3.bucket, msg.voice.s3Key);
                if (exists) {
                    await s3.send(new CopyObjectCommand({
                        Bucket: env.s3.bucket,
                        CopySource: `${env.s3.bucket}/${msg.voice.s3Key}`,
                        Key: canonicalKey,
                    }));
                    await s3.send(new DeleteObjectCommand({
                        Bucket: env.s3.bucket,
                        Key: msg.voice.s3Key,
                    }));
                }
                msg.voice.s3Key = canonicalKey;
                await msg.save();
            }
            migratedVoicesCount++;
        }
    }

    console.log("--------------------------------------------------");
    console.log(`[Migration Complete] Total employee docs identified: ${migratedDocsCount}`);
    console.log(`[Migration Complete] Total voice messages identified: ${migratedVoicesCount}`);
    if (isDryRun) {
        console.log("[Migration Notice] Dry run only. No changes were made to S3 or DB.");
    } else {
        console.log("[Migration Success] All existing files and database pointers updated.");
    }

    await mongoose.disconnect();
}

run().catch((err) => {
    console.error("[Migration Error]", err);
    process.exit(1);
});
