// src/services/storage/document-crypto.service.js
import crypto from "node:crypto";
import { env } from "../../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const DEK_LENGTH = 32;

function getKek() {
    if (!env.documentKek) throw new Error("DOCUMENT_KEK env is not set");
    const kek = Buffer.from(env.documentKek, "base64");
    if (kek.length !== 32) {
        throw new Error("DOCUMENT_KEK must be 32 bytes (base64-encoded)");
    }
    return kek;
}

// Wrap (encrypt) the DEK with the KEK.
// Returns one base64 blob: iv(12) || authTag(16) || ciphertext(32) = 60 bytes.
function wrapDek(dek, kek) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, kek, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, authTag, ciphertext]);
    return blob.toString("base64");
}

function unwrapDek(blobB64, kek) {
    const blob = Buffer.from(blobB64, "base64");
    if (blob.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error("wrapped DEK blob is too short");
    }
    const iv = blob.subarray(0, IV_LENGTH);
    const authTag = blob.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, kek, iv);
    decipher.setAuthTag(authTag);
    const dek = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (dek.length !== DEK_LENGTH) throw new Error("unwrapped DEK has wrong length");
    return dek;
}

/**
 * Encrypt a buffer with a fresh DEK, wrapped by the KEK.
 * `employeeId` and `fileId` are bound as AAD so ciphertext cannot be
 * relocated to a different employee/file without failing decryption.
 */
export function encryptFile(plaintextBuffer, { employeeId, fileId }) {
    const kek = getKek();
    const dek = crypto.randomBytes(DEK_LENGTH);

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
    const aad = Buffer.from(`emp:${employeeId}|file:${fileId}`, "utf8");
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrappedDek = wrapDek(dek, kek);
    dek.fill(0); // best-effort zero

    return {
        ciphertext,                    // Buffer to upload to S3
        iv: iv.toString("base64"),     // 16 chars base64 (12 bytes)
        authTag: authTag.toString("base64"), // 24 chars base64 (16 bytes)
        wrappedDek,                    // single blob
        kekVersion: 1,
    };
}

/**
 * Decrypt a file previously encrypted with encryptFile().
 * Throws if the AAD / authTag / KEK do not match.
 */
export function decryptFile(
    ciphertextBuffer,
    { iv, authTag, wrappedDek, employeeId, fileId }
) {
    const kek = getKek();
    const dek = unwrapDek(wrappedDek, kek);

    const ivBuf = Buffer.from(iv, "base64");
    const tagBuf = Buffer.from(authTag, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, ivBuf);
    decipher.setAAD(Buffer.from(`emp:${employeeId}|file:${fileId}`, "utf8"));
    decipher.setAuthTag(tagBuf);

    const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
    ]);
    dek.fill(0);
    return plaintext;
}

/**
 * Encrypt chat voice note with fresh DEK wrapped by KEK.
 * Bound to conversationId and messageId via AAD.
 */
export function encryptVoiceBuffer(plaintextBuffer, { conversationId, messageId }) {
    const kek = getKek();
    const dek = crypto.randomBytes(DEK_LENGTH);

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
    const aad = Buffer.from(`chat:${conversationId}|msg:${messageId}`, "utf8");
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrappedDek = wrapDek(dek, kek);
    dek.fill(0);

    return {
        ciphertext,
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        wrappedDek,
        kekVersion: 1,
    };
}

/**
 * Decrypt chat voice note ciphertext.
 */
export function decryptVoiceBuffer(ciphertextBuffer, { iv, authTag, wrappedDek, conversationId, messageId }) {
    const kek = getKek();
    const dek = unwrapDek(wrappedDek, kek);

    const ivBuf = Buffer.from(iv, "base64");
    const tagBuf = Buffer.from(authTag, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, ivBuf);
    decipher.setAAD(Buffer.from(`chat:${conversationId}|msg:${messageId}`, "utf8"));
    decipher.setAuthTag(tagBuf);

    const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
    ]);
    dek.fill(0);
    return plaintext;
}

/**
 * Generate ephemeral client-side encryption params for S3 presigned direct upload.
 * Client encrypts in-browser with WebCrypto AES-GCM before PUTting to S3.
 */
export function createVoiceEncryptionParams({ conversationId, messageId }) {
    const kek = getKek();
    const dek = crypto.randomBytes(DEK_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const wrappedDek = wrapDek(dek, kek);
    const aad = Buffer.from(`chat:${conversationId}|msg:${messageId}`, "utf8");

    const dekRaw = dek.toString("base64");
    dek.fill(0);

    return {
        dekBase64: dekRaw,
        ivBase64: iv.toString("base64"),
        aadBase64: aad.toString("base64"),
        wrappedDek,
        kekVersion: 1,
    };
}

/**
 * Encrypt chat attachment with fresh DEK wrapped by KEK.
 * Bound to conversationId and fileId via AAD.
 */
export function encryptAttachmentBuffer(plaintextBuffer, { conversationId, fileId }) {
    const kek = getKek();
    const dek = crypto.randomBytes(DEK_LENGTH);

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
    const aad = Buffer.from(`chat:${conversationId}|file:${fileId}`, "utf8");
    cipher.setAAD(aad);

    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const wrappedDek = wrapDek(dek, kek);
    dek.fill(0);

    return {
        ciphertext,
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        wrappedDek,
        kekVersion: 1,
    };
}

/**
 * Decrypt chat attachment ciphertext.
 */
export function decryptAttachmentBuffer(ciphertextBuffer, { iv, authTag, wrappedDek, conversationId, fileId }) {
    const kek = getKek();
    const dek = unwrapDek(wrappedDek, kek);

    const ivBuf = Buffer.from(iv, "base64");
    const tagBuf = Buffer.from(authTag, "base64");
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, ivBuf);
    decipher.setAAD(Buffer.from(`chat:${conversationId}|file:${fileId}`, "utf8"));
    decipher.setAuthTag(tagBuf);

    const plaintext = Buffer.concat([
        decipher.update(ciphertextBuffer),
        decipher.final(),
    ]);
    dek.fill(0);
    return plaintext;
}
