import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const SIGNUP_PENDING_TTL = "30m";

export function createSignupPendingToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            purpose: "pending-signup",
        },
        env.jwt.accessSecret, // reuse a secret — fine, purpose field disambiguates
        { expiresIn: SIGNUP_PENDING_TTL }
    );
}

export function verifySignupPendingToken(token) {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    if (decoded.purpose !== "pending-signup") {
        throw new Error("Invalid token purpose");
    }
    return decoded;
}