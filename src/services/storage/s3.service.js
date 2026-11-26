// src/services/storage/s3.service.js
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";

export * from "./s3-paths.service.js";

let client;
function getClient() {
    if (!client) {
        client = new S3Client({
            region: env.s3.region,
            credentials: {
                accessKeyId: env.s3.accessKeyId,
                secretAccessKey: env.s3.secretAccessKey,
            },
        });
    }
    return client;
}

/**
 * Upload an encrypted blob to S3.
 * - No metadata is stored (prevents leaking filename / mime via S3).
 * - `ContentType` is forced to `application/octet-stream` so nothing
 *   can detect the original file type from S3 alone.
 * - Bucket must have Block Public Access enabled — this service never
 *   sets an ACL and never returns a public URL.
 */
export async function uploadEncryptedBlob(key, buffer) {
    await getClient().send(
        new PutObjectCommand({
            Bucket: env.s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: "application/octet-stream",
        })
    );
    return key;
}

export async function uploadBlob(key, buffer, contentType = "application/octet-stream") {
    await getClient().send(
        new PutObjectCommand({
            Bucket: env.s3.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
        })
    );
    return key;
}

export async function copyBlob(sourceKey, targetKey) {
    await getClient().send(
        new CopyObjectCommand({
            Bucket: env.s3.bucket,
            CopySource: `${env.s3.bucket}/${sourceKey}`,
            Key: targetKey,
        })
    );
    return targetKey;
}

export async function deleteEncryptedBlob(key) {
    await getClient().send(
        new DeleteObjectCommand({
            Bucket: env.s3.bucket,
            Key: key,
        })
    );
}

export async function getEncryptedBlob(key) {
    const res = await getClient().send(
        new GetObjectCommand({
            Bucket: env.s3.bucket,
            Key: key,
        })
    );
    const byteArray = await res.Body.transformToByteArray();
    return Buffer.from(byteArray);
}

/**
 * Generate a short-lived signed URL for direct download.
 * Downloads go through S3 → the browser receives ciphertext → the browser
 * CANNOT decrypt it. Real downloads MUST go through our backend
 * (`GET /employees/:id/documents/:fileId/download`) which decrypts server-side.
 * So we don't use this for user-facing downloads — only for internal ops
 * (e.g. a migration script). Kept here for future use.
 */
export async function getInternalSignedUrl(key, expiresIn = 60) {
    return getSignedUrl(
        getClient(),
        new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }),
        { expiresIn }
    );
}

/**
 * Generate a short-lived signed URL for client-side encrypted upload.
 * Client encrypts payload locally, then PUTs the encrypted octet-stream directly to S3.
 * Hackers intercepting S3 or presigned URLs get ONLY encrypted ciphertext.
 */
export async function getPresignedUploadUrl(key, { contentType = "application/octet-stream", expiresIn = 300 } = {}) {
    return getSignedUrl(
        getClient(),
        new PutObjectCommand({
            Bucket: env.s3.bucket,
            Key: key,
            ContentType: contentType,
        }),
        { expiresIn }
    );
}
