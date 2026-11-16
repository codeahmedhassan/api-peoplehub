import { ApiError } from "../../utils/ApiError.js";
import {
    SUPER_ADMIN_COOKIE_NAMES,
    verifySuperAdminAccessToken,
    verifySuperAdminRefreshToken,
    signSuperAdminAccessToken,
    setSuperAdminCookies,
} from "../../services/superAdmin/superAdmin.service.js";
import { SuperAdmin } from "../../model/superAdmin/superAdmin.model.js";

export async function requireSuperAdminAuth(req, res, next) {
    try {
        let token = req.cookies?.[SUPER_ADMIN_COOKIE_NAMES.ACCESS_TOKEN];

        if (!token && req.headers.authorization?.startsWith("Bearer ")) {
            token = req.headers.authorization.split(" ")[1];
        }

        let payload = null;
        if (token) {
            try {
                payload = verifySuperAdminAccessToken(token);
            } catch {
                payload = null;
            }
        }

        // If access token invalid/expired, try silent refresh from session refresh token
        if (!payload) {
            const refreshToken = req.cookies?.[SUPER_ADMIN_COOKIE_NAMES.REFRESH_TOKEN];
            if (refreshToken) {
                try {
                    const refreshPayload = verifySuperAdminRefreshToken(refreshToken);
                    if (refreshPayload.typ === "superadmin_refresh") {
                        const admin = await SuperAdmin.findById(refreshPayload.sub);
                        if (
                            admin &&
                            admin.status === "active" &&
                            !admin.isLocked() &&
                            (refreshPayload.ver ?? 0) === (admin.tokenVersion ?? 0)
                        ) {
                            const newAccessToken = signSuperAdminAccessToken(admin);
                            setSuperAdminCookies(res, { accessToken: newAccessToken });
                            payload = verifySuperAdminAccessToken(newAccessToken);
                        }
                    }
                } catch {
                    payload = null;
                }
            }
        }

        if (!payload) {
            throw ApiError.unauthorized("Super Admin authentication required");
        }

        if (payload.typ !== "superadmin") {
            throw ApiError.forbidden("Access denied: invalid token scope");
        }

        const admin = await SuperAdmin.findById(payload.sub);
        if (!admin) {
            throw ApiError.unauthorized("Super Admin account no longer exists");
        }

        if (admin.status !== "active") {
            throw ApiError.forbidden(`Super Admin account is ${admin.status}`);
        }

        if (admin.isLocked()) {
            throw ApiError.forbidden("Super Admin account is currently locked");
        }

        if ((payload.ver ?? 0) !== (admin.tokenVersion ?? 0)) {
            throw ApiError.unauthorized("Super Admin session has been revoked");
        }

        req.superAdmin = admin;
        req.superAdminId = admin._id;
        next();
    } catch (err) {
        next(err);
    }
}
