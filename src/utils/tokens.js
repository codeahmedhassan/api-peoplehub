import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function createAccessToken(user, sessionId = null) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            // bump-able version → allows "sign out everywhere"
            ver: user.tokenVersion || 0,
            sid: sessionId || null,
            typ: "access",
        },
        env.jwt.accessSecret,
        { expiresIn: env.jwt.accessExpiresIn }
    );
}

export function createRefreshToken(user, sessionId = null, rememberMe = false) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            ver: user.tokenVersion || 0,
            sid: sessionId || null,
            rem: Boolean(rememberMe),
            typ: "refresh",
        },
        env.jwt.refreshSecret,
        { expiresIn: rememberMe ? "30d" : (env.jwt.refreshExpiresIn || "30d") }
    );
}

export function create2FAPendingToken(user, rememberMe = false) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            rememberMe: Boolean(rememberMe),
            typ: "2fa_pending",
        },
        env.jwt.accessSecret,
        { expiresIn: "10m" }
    );
}

export function verify2FAPendingToken(token) {
    const decoded = jwt.verify(token, env.jwt.accessSecret, { algorithms: ["HS256"] });
    if (decoded.typ !== "2fa_pending") throw new Error("Wrong token type");
    return decoded;
}

export function verifyAccessToken(token) {
    const decoded = jwt.verify(token, env.jwt.accessSecret, { algorithms: ["HS256"] });
    if (decoded.typ !== "access") throw new Error("Wrong token type");
    return decoded;
}

export function verifyRefreshToken(token) {
    const decoded = jwt.verify(token, env.jwt.refreshSecret, { algorithms: ["HS256"] });
    if (decoded.typ !== "refresh") throw new Error("Wrong token type");
    return decoded;
}
