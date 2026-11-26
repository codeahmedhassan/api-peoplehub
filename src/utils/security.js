// src/utils/security.js

/**
 * Escapes user-supplied text before embedding into a MongoDB / JS RegExp to prevent ReDoS.
 */
export function escapeRegex(value) {
    return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escapes HTML special characters before interpolating user data into email HTML templates.
 */
export function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Mitigates CSV / Spreadsheet Formula Injection (CWE-1236) by neutralising leading trigger characters.
 */
export function sanitizeCsvCell(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" || typeof value === "boolean") return value;
    const str = String(value);
    if (/^[=+\-@\t\r]/.test(str)) {
        return `'${str}`;
    }
    return str;
}

/**
 * Recursively strips MongoDB operator keys ($...) and prototype pollution keys (__proto__, constructor, prototype).
 */
export function sanitizeObjectInPlace(target, depth = 0) {
    if (!target || typeof target !== "object" || depth > 12) return target;
    if (Array.isArray(target)) {
        for (let i = 0; i < target.length; i++) {
            sanitizeObjectInPlace(target[i], depth + 1);
        }
        return target;
    }
    for (const key of Object.keys(target)) {
        if (
            key.startsWith("$") ||
            key.includes(".") && /^\$/.test(key.split(".").pop() || "") ||
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
        ) {
            delete target[key];
        } else {
            sanitizeObjectInPlace(target[key], depth + 1);
        }
    }
    return target;
}

/**
 * Safe recursive-descent arithmetic evaluator supporting +, -, *, /, %, and parentheses.
 * Zero dynamic code evaluation (never uses eval or new Function).
 */
export function evaluateSafeArithmetic(expr) {
    const tokens = [];
    const input = String(expr || "0");
    let i = 0;

    while (i < input.length) {
        const ch = input[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if ((ch >= "0" && ch <= "9") || ch === ".") {
            let numStr = "";
            let dotCount = 0;
            while (i < input.length && ((input[i] >= "0" && input[i] <= "9") || input[i] === ".")) {
                if (input[i] === ".") dotCount++;
                if (dotCount > 1) return 0;
                numStr += input[i++];
            }
            const val = Number(numStr);
            if (!Number.isFinite(val)) return 0;
            tokens.push({ type: "num", value: val });
            continue;
        }
        if ("+-*/%()".includes(ch)) {
            tokens.push({ type: "op", value: ch });
            i++;
            continue;
        }
        return 0;
    }

    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    function parseExpression() {
        let left = parseTerm();
        while (peek()?.type === "op" && (peek().value === "+" || peek().value === "-")) {
            const op = consume().value;
            const right = parseTerm();
            left = op === "+" ? left + right : left - right;
        }
        return left;
    }

    function parseTerm() {
        let left = parseFactor();
        while (peek()?.type === "op" && (peek().value === "*" || peek().value === "/" || peek().value === "%")) {
            const op = consume().value;
            const right = parseFactor();
            if (op === "*") left *= right;
            else if (op === "/") left = right === 0 ? 0 : left / right;
            else left = right === 0 ? 0 : left % right;
        }
        return left;
    }

    function parseFactor() {
        const tok = peek();
        if (!tok) return 0;
        if (tok.type === "op" && (tok.value === "+" || tok.value === "-")) {
            consume();
            const val = parseFactor();
            return tok.value === "-" ? -val : val;
        }
        if (tok.type === "op" && tok.value === "(") {
            consume();
            const val = parseExpression();
            if (peek()?.type === "op" && peek().value === ")") {
                consume();
            }
            return val;
        }
        if (tok.type === "num") {
            consume();
            return tok.value;
        }
        return 0;
    }

    const result = parseExpression();
    if (pos !== tokens.length) return 0;
    return Number.isFinite(result) ? result : 0;
}
