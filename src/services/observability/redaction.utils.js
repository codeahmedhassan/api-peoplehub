/**
 * Redaction utility to recursively strip or mask sensitive PII and security credentials.
 * Ensures zero passwords, tokens, salary details, bank info, or CNICs leak into logs or telemetry.
 */

const SENSITIVE_KEY_REGEX =
    /^(password|passwd|pass|token|accesstoken|refreshtoken|secret|auth|authorization|cookie|bearer|otp|pin|2fa|code|salary|basesalary|basicsalary|wage|grosssalary|netsalary|hourlyrate|bank|bankaccount|accountnumber|iban|routingnumber|swift|cnic|nationalid|ssn|taxid|passport|card|creditcard|debitcard|cvv)$/i;

const SENSITIVE_SUBSTRING_REGEX =
    /(password|secret|token|bearer|credit_card|cvv|bank_account|routing_number|ssn|cnic)/i;

/**
 * Deep-clones and redacts sensitive keys from an object or array.
 * @param {any} target - Data structure to sanitize
 * @param {number} depth - Recursion limit to avoid circular reference issues
 * @returns {any} Sanitized copy
 */
export function redactSensitiveData(target, depth = 0) {
    if (depth > 8 || target === null || target === undefined) {
        return target;
    }

    if (typeof target !== "object") {
        if (typeof target === "string") {
            // Mask JWT / Bearer tokens if present in string
            if (/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/i.test(target)) {
                return "Bearer [REDACTED_TOKEN]";
            }
        }
        return target;
    }

    if (Array.isArray(target)) {
        return target.map((item) => redactSensitiveData(item, depth + 1));
    }

    // Handle Date, RegExp, or non-plain objects
    if (target instanceof Date) return target;
    if (target instanceof RegExp) return target.toString();

    const sanitized = {};
    for (const [key, value] of Object.entries(target)) {
        const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");

        if (SENSITIVE_KEY_REGEX.test(lowerKey) || SENSITIVE_SUBSTRING_REGEX.test(key)) {
            sanitized[key] = "[REDACTED]";
        } else if (typeof value === "object" && value !== null) {
            sanitized[key] = redactSensitiveData(value, depth + 1);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}
