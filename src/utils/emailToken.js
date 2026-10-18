import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function createEmailVerifyToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            // "ev" = email verification purpose. Prevents this token
            // from being reused as an access token.
            purpose: "email-verify",
        },
        env.emailVerify.secret,
        { expiresIn: env.emailVerify.expiresIn }
    );
}

export function verifyEmailVerifyToken(token) {
    const decoded = jwt.verify(token, env.emailVerify.secret);
    if (decoded.purpose !== "email-verify") {
        throw new Error("Invalid token purpose");
    }
    return decoded;
}