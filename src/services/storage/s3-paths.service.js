// src/services/storage/s3-paths.service.js

/**
 * Canonical S3 Storage Tree Architecture
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
 */

function cleanSegment(segment) {
    if (!segment) return "";
    return String(segment).trim().replace(/^[/\\]+|[/\\]+$/g, "");
}

/**
 * USERS PATHS
 * users/{userId}/profile/{filename}
 * users/{userId}/documents/{filename}
 */
export function getUserProfilePath(userId, filename) {
    return `users/${cleanSegment(userId)}/profile/${cleanSegment(filename)}`;
}

export function getUserDocumentPath(userId, filename) {
    return `users/${cleanSegment(userId)}/documents/${cleanSegment(filename)}`;
}

/**
 * EMPLOYEES PATHS
 * employees/{employeeId}/profile/{filename}
 * employees/{employeeId}/documents/{filename}
 * employees/{employeeId}/attachments/{filename}
 */
export function getEmployeeProfilePath(employeeId, filename) {
    return `employees/${cleanSegment(employeeId)}/profile/${cleanSegment(filename)}`;
}

export function getEmployeeDocumentPath(employeeId, filename) {
    return `employees/${cleanSegment(employeeId)}/documents/${cleanSegment(filename)}`;
}

export function getEmployeeAttachmentPath(employeeId, filename) {
    return `employees/${cleanSegment(employeeId)}/attachments/${cleanSegment(filename)}`;
}

/**
 * MESSAGES PATHS
 * messages/{conversationId}/images/{filename}
 * messages/{conversationId}/videos/{filename}
 * messages/{conversationId}/voice/{filename}
 */
export function getMessageImagePath(conversationId, filename) {
    return `messages/${cleanSegment(conversationId)}/images/${cleanSegment(filename)}`;
}

export function getMessageVideoPath(conversationId, filename) {
    return `messages/${cleanSegment(conversationId)}/videos/${cleanSegment(filename)}`;
}

export function getMessageVoicePath(conversationId, filename) {
    return `messages/${cleanSegment(conversationId)}/voice/${cleanSegment(filename)}`;
}

export function getMessageAttachmentPath(conversationId, filename) {
    return `messages/${cleanSegment(conversationId)}/attachments/${cleanSegment(filename)}`;
}

export function getMessageMediaPath(conversationId, mediaType, filename) {
    const valid = ["images", "videos", "voice"];
    const type = valid.includes(mediaType) ? mediaType : "voice";
    return `messages/${cleanSegment(conversationId)}/${type}/${cleanSegment(filename)}`;
}

/**
 * ORGANIZATIONS PATHS
 * organizations/{organizationId}/logos/{filename}
 * organizations/{organizationId}/documents/{filename}
 */
export function getOrganizationLogoPath(organizationId, filename) {
    return `organizations/${cleanSegment(organizationId)}/logos/${cleanSegment(filename)}`;
}

export function getOrganizationDocumentPath(organizationId, filename) {
    return `organizations/${cleanSegment(organizationId)}/documents/${cleanSegment(filename)}`;
}

/**
 * Parse an S3 key into structured tree components
 */
export function parseS3Key(s3Key) {
    if (!s3Key) return null;
    const parts = cleanSegment(s3Key).split("/");
    if (parts.length < 4) {
        return {
            category: parts[0] || "unknown",
            rawKey: s3Key,
        };
    }

    const [category, entityId, subfolder, ...rest] = parts;
    const filename = rest.join("/");

    return {
        category,   // "users" | "employees" | "messages" | "organizations"
        entityId,   // userId | employeeId | conversationId | organizationId
        subfolder,  // "profile" | "documents" | "attachments" | "images" | "videos" | "voice" | "logos"
        filename,
        rawKey: s3Key,
    };
}
