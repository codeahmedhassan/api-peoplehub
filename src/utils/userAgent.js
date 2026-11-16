export function parseUserAgent(ua = "") {
    let browser = "Web Browser";
    if (/edg/i.test(ua)) browser = "Microsoft Edge";
    else if (/chrome|crios/i.test(ua) && !/opr|opera/i.test(ua)) browser = "Google Chrome";
    else if (/firefox|fxios/i.test(ua)) browser = "Mozilla Firefox";
    else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = "Apple Safari";
    else if (/opera|opr/i.test(ua)) browser = "Opera";

    let os = "Unknown OS";
    if (/windows nt 10/i.test(ua)) os = "Windows 10/11";
    else if (/windows/i.test(ua)) os = "Windows";
    else if (/macintosh|mac os x/i.test(ua)) os = "macOS";
    else if (/linux/i.test(ua) && !/android/i.test(ua)) os = "Linux";
    else if (/android/i.test(ua)) os = "Android";
    else if (/iphone|ipad|ipod/i.test(ua)) os = "iOS";

    let device = "Desktop";
    if (/tablet|ipad/i.test(ua)) device = "Tablet";
    else if (/mobile|iphone|android/i.test(ua)) device = "Mobile";

    return { browser, os, device };
}

export function parseClientIp(req) {
    const forwarded = req?.headers?.["x-forwarded-for"];
    const ip = forwarded
        ? forwarded.split(",")[0].trim()
        : req?.socket?.remoteAddress || req?.ip || "127.0.0.1";

    let location = "Local Network";
    if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip === "::ffff:127.0.0.1") {
        location = "Localhost (Development)";
    } else {
        location = ip;
    }

    return { ip, location };
}

export function maskEmail(email = "") {
    if (!email || !email.includes("@")) return email;
    const [name, domain] = email.split("@");
    if (name.length <= 2) {
        return `${name[0]}••••@${domain}`;
    }
    return `${name.slice(0, 2)}••••${name.slice(-1)}@${domain}`;
}

/**
 * Upserts an active session by IP and Device/OS.
 * If the user logs in from the same device & IP (e.g. Windows on 127.0.0.1),
 * it updates the existing session entry with the new sessionId and timestamp.
 * If the user logs in from a different device/OS (e.g. Android), a separate
 * session entry is created so both appear.
 */
export function upsertActiveSession(existingSessions = [], newSession) {
    const list = Array.isArray(existingSessions) ? [...existingSessions] : [];

    const normalizeIp = (ip = "") => {
        if (ip === "::1" || ip === "::ffff:127.0.0.1") return "127.0.0.1";
        return ip;
    };

    const targetIp = normalizeIp(newSession.ip);

    const matchIndex = list.findIndex((s) => {
        const sIp = normalizeIp(s.ip);
        const sameIp = sIp === targetIp;
        const sameOs = s.os && newSession.os && s.os.toLowerCase() === newSession.os.toLowerCase();
        const sameDevice = s.device && newSession.device && s.device.toLowerCase() === newSession.device.toLowerCase();
        const sameBrowser = s.browser && newSession.browser && s.browser.toLowerCase() === newSession.browser.toLowerCase();

        return (sameIp && sameOs) || (sameIp && sameDevice && sameBrowser);
    });

    if (matchIndex !== -1) {
        list[matchIndex] = {
            ...list[matchIndex],
            sessionId: newSession.sessionId,
            device: newSession.device || list[matchIndex].device,
            browser: newSession.browser || list[matchIndex].browser,
            os: newSession.os || list[matchIndex].os,
            location: newSession.location || list[matchIndex].location,
            ip: newSession.ip || list[matchIndex].ip,
            lastActiveAt: new Date(),
        };
    } else {
        list.unshift({
            ...newSession,
            lastActiveAt: new Date(),
        });
    }

    return list.slice(0, 10);
}
