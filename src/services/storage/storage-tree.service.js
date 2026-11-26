// src/services/storage/storage-tree.service.js
import { uploadBlob, uploadEncryptedBlob, deleteEncryptedBlob, getEncryptedBlob, copyBlob, getPresignedUploadUrl } from "./s3.service.js";
import {
    getUserProfilePath,
    getUserDocumentPath,
    getEmployeeProfilePath,
    getEmployeeDocumentPath,
    getEmployeeAttachmentPath,
    getMessageImagePath,
    getMessageVideoPath,
    getMessageVoicePath,
    getMessageMediaPath,
    getOrganizationLogoPath,
    getOrganizationDocumentPath,
    parseS3Key,
} from "./s3-paths.service.js";
import { encryptFile, decryptFile } from "./document-crypto.service.js";

/**
 * High-Level Storage Tree Service for corpilance
 *
 * Tree Structure:
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
 */

// -----------------------------------------------------------------------------
// 1. USERS
// -----------------------------------------------------------------------------
export async function uploadUserProfilePhoto(userId, buffer, fileName, contentType = "image/png") {
    const s3Key = getUserProfilePath(userId, fileName);
    await uploadBlob(s3Key, buffer, contentType);
    return { s3Key, url: s3Key };
}

export async function uploadUserDocument(userId, buffer, fileId, meta = {}) {
    const { ciphertext, iv, authTag, wrappedDek, kekVersion } = encryptFile(buffer, {
        userId: userId.toString(),
        fileId: fileId.toString(),
    });
    const s3Key = getUserDocumentPath(userId, `${fileId}.enc`);
    await uploadEncryptedBlob(s3Key, ciphertext);
    return { s3Key, iv, authTag, wrappedDek, kekVersion };
}

// -----------------------------------------------------------------------------
// 2. EMPLOYEES
// -----------------------------------------------------------------------------
export async function uploadEmployeeProfilePhoto(employeeId, buffer, fileName, contentType = "image/png") {
    const s3Key = getEmployeeProfilePath(employeeId, fileName);
    await uploadBlob(s3Key, buffer, contentType);
    return { s3Key, url: s3Key };
}

export async function uploadEmployeeDocument(employeeId, buffer, fileId) {
    const { ciphertext, iv, authTag, wrappedDek, kekVersion } = encryptFile(buffer, {
        employeeId: employeeId.toString(),
        fileId: fileId.toString(),
    });
    const s3Key = getEmployeeDocumentPath(employeeId, `${fileId}.enc`);
    await uploadEncryptedBlob(s3Key, ciphertext);
    return { s3Key, iv, authTag, wrappedDek, kekVersion };
}

export async function uploadEmployeeAttachment(employeeId, buffer, fileId) {
    const { ciphertext, iv, authTag, wrappedDek, kekVersion } = encryptFile(buffer, {
        employeeId: employeeId.toString(),
        fileId: fileId.toString(),
    });
    const s3Key = getEmployeeAttachmentPath(employeeId, `${fileId}.enc`);
    await uploadEncryptedBlob(s3Key, ciphertext);
    return { s3Key, iv, authTag, wrappedDek, kekVersion };
}

// -----------------------------------------------------------------------------
// 3. MESSAGES
// -----------------------------------------------------------------------------
export async function uploadMessageVoice(conversationId, buffer, messageId) {
    const s3Key = getMessageVoicePath(conversationId, `${messageId}.enc`);
    await uploadEncryptedBlob(s3Key, buffer);
    return { s3Key };
}

export async function uploadMessageImage(conversationId, buffer, messageId, contentType = "image/jpeg") {
    const s3Key = getMessageImagePath(conversationId, `${messageId}.enc`);
    await uploadEncryptedBlob(s3Key, buffer);
    return { s3Key };
}

export async function uploadMessageVideo(conversationId, buffer, messageId, contentType = "video/mp4") {
    const s3Key = getMessageVideoPath(conversationId, `${messageId}.enc`);
    await uploadEncryptedBlob(s3Key, buffer);
    return { s3Key };
}

export async function getMessagePresignedUpload(conversationId, mediaType, messageId, { expiresIn = 300 } = {}) {
    const s3Key = getMessageMediaPath(conversationId, mediaType, `${messageId}.enc`);
    const presignedUrl = await getPresignedUploadUrl(s3Key, {
        contentType: "application/octet-stream",
        expiresIn,
    });
    return { s3Key, presignedUrl };
}

// -----------------------------------------------------------------------------
// 4. ORGANIZATIONS
// -----------------------------------------------------------------------------
export async function uploadOrganizationLogo(organizationId, buffer, fileName, contentType = "image/png") {
    const s3Key = getOrganizationLogoPath(organizationId, fileName);
    await uploadBlob(s3Key, buffer, contentType);
    return { s3Key, url: s3Key };
}

export async function uploadOrganizationDocument(organizationId, buffer, fileId) {
    const { ciphertext, iv, authTag, wrappedDek, kekVersion } = encryptFile(buffer, {
        organizationId: organizationId.toString(),
        fileId: fileId.toString(),
    });
    const s3Key = getOrganizationDocumentPath(organizationId, `${fileId}.enc`);
    await uploadEncryptedBlob(s3Key, ciphertext);
    return { s3Key, iv, authTag, wrappedDek, kekVersion };
}

export {
    uploadBlob,
    uploadEncryptedBlob,
    deleteEncryptedBlob,
    getEncryptedBlob,
    copyBlob,
    getPresignedUploadUrl,
    getUserProfilePath,
    getUserDocumentPath,
    getEmployeeProfilePath,
    getEmployeeDocumentPath,
    getEmployeeAttachmentPath,
    getMessageImagePath,
    getMessageVideoPath,
    getMessageVoicePath,
    getMessageMediaPath,
    getOrganizationLogoPath,
    getOrganizationDocumentPath,
    parseS3Key,
};
