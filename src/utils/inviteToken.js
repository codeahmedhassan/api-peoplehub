import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function createInviteToken(user) {
    return jwt.sign(
        {
            sub: user._id.toString(),
            email: user.email,
            purpose: "employee-invite",
        },
        env.jwt.accessSecret,
        { expiresIn: "7d" } // Invites expire after 7 days
    );
}

export function verifyInviteToken(token) {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    if (decoded.purpose !== "employee-invite") {
        throw new Error("Invalid token purpose");
    }
    return decoded;
}