import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function createAccessToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            // bump-able version → allows "sign out everywhere"
            ver: user.tokenVersion || 0,
            typ: "access",
        },
        env.jwt.accessSecret,
        { expiresIn: env.jwt.accessExpiresIn }
    );
}

export function createRefreshToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            ver: user.tokenVersion || 0,
            typ: "refresh",
        },
        env.jwt.refreshSecret,
        { expiresIn: env.jwt.refreshExpiresIn }
    );
}

export function verifyAccessToken(token) {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    if (decoded.typ !== "access") throw new Error("Wrong token type");
    return decoded;
}

export function verifyRefreshToken(token) {
    const decoded = jwt.verify(token, env.jwt.refreshSecret);
    if (decoded.typ !== "refresh") throw new Error("Wrong token type");
    return decoded;
}