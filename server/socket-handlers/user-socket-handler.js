const { R } = require("redbean-node");
const { log } = require("../../src/util");
const passwordHash = require("../password-hash");
const {
    PERMISSIONS,
    ROLES,
    ROLE_ADMIN,
    PERMISSION_LIST,
    parseOverrides,
    getEffectivePermissions,
} = require("../permissions");
const { requirePermission, getSocketUser } = require("../socket-permissions");
const { UptimeKumaServer } = require("../uptime-kuma-server");

/**
 * Force a user's open sessions to reconnect, so a changed role or permission
 * set is recomputed rather than left stale on their sockets.
 *
 * Checks for an existing server instance instead of calling getInstance(),
 * which would construct a whole express/socket.io stack when none is running.
 * @param {number} userID User whose sessions should be dropped.
 * @returns {void}
 */
function disconnectSessions(userID) {
    if (UptimeKumaServer.instance) {
        UptimeKumaServer.instance.disconnectAllSocketClients(userID);
    }
}

/**
 * Shape a user row for the management UI. Never includes the password hash.
 * @param {Bean} user User bean.
 * @returns {object} Safe representation.
 */
function toUserJSON(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        role: user.role,
        active: !!user.active,
        twofaStatus: !!user.twofa_status,
        overrides: parseOverrides(user.permissions),
        effectivePermissions: getEffectivePermissions(user),
    };
}

/**
 * Count how many enabled administrators exist, optionally excluding one user.
 *
 * Used to stop the last administrator being deleted, disabled or demoted,
 * which would leave the installation with nobody able to manage it.
 * @param {number|null} excludeUserID User to leave out of the count.
 * @returns {Promise<number>} Number of remaining active admins.
 */
async function countOtherActiveAdmins(excludeUserID = null) {
    if (excludeUserID == null) {
        return await R.count("user", " role = ? AND active = 1 ", [ROLE_ADMIN]);
    }
    return await R.count("user", " role = ? AND active = 1 AND id != ? ", [ROLE_ADMIN, excludeUserID]);
}

/**
 * Validate and normalise the override map coming from the client.
 * @param {object} raw Override map.
 * @returns {string|null} JSON string to store, or null when empty.
 */
function normaliseOverridesForStorage(raw) {
    const clean = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const key of PERMISSION_LIST) {
            if (typeof raw[key] === "boolean") {
                clean[key] = raw[key];
            }
        }
    }
    return Object.keys(clean).length ? JSON.stringify(clean) : null;
}

/**
 * Send the full user list to a socket.
 * @param {Socket} socket Socket.io instance.
 * @returns {Promise<void>}
 */
async function sendUserList(socket) {
    const users = await R.findAll("user", " ORDER BY username ");
    socket.emit("userList", users.map(toUserJSON));
}

/**
 * Socket handlers for user management.
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
module.exports.userSocketHandler = (socket) => {
    socket.on("getUserList", async (callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.USER_MANAGE);
            await sendUserList(socket);
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("getPermissionCatalog", async (callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.USER_MANAGE);
            callback({
                ok: true,
                roles: ROLES,
                permissions: PERMISSION_LIST,
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("addUser", async (user, callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.USER_MANAGE);

            const username = String(user?.username ?? "").trim();
            if (!username) {
                throw new Error("Please input a username");
            }
            if (!user?.password) {
                throw new Error("Please input a password");
            }
            if (!ROLES.includes(user.role)) {
                throw new Error("Invalid role");
            }

            const existing = await R.findOne("user", " TRIM(username) = ? ", [username]);
            if (existing) {
                throw new Error("This username is already taken");
            }

            const bean = R.dispense("user");
            bean.username = username;
            bean.password = await passwordHash.generate(user.password);
            bean.role = user.role;
            bean.display_name = user.displayName || null;
            bean.email = user.email || null;
            bean.permissions = normaliseOverridesForStorage(user.overrides);
            bean.active = user.active === false ? 0 : 1;
            await R.store(bean);

            log.info("user", `Added user ${bean.id} (${username}) with role ${bean.role}`);

            await sendUserList(socket);
            callback({ ok: true, msg: "successAdded", msgi18n: true, userID: bean.id });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("editUser", async (user, callback) => {
        try {
            const actor = await requirePermission(socket, PERMISSIONS.USER_MANAGE);

            const bean = await R.findOne("user", " id = ? ", [user?.id]);
            if (!bean) {
                throw new Error("User not found");
            }
            if (!ROLES.includes(user.role)) {
                throw new Error("Invalid role");
            }

            const wasActiveAdmin = bean.role === ROLE_ADMIN && !!bean.active;
            const staysActiveAdmin = user.role === ROLE_ADMIN && user.active !== false;

            // Refuse any edit that would remove the final administrator.
            if (wasActiveAdmin && !staysActiveAdmin && (await countOtherActiveAdmins(bean.id)) === 0) {
                throw new Error("Cannot remove the last administrator");
            }

            const username = String(user.username ?? "").trim();
            if (!username) {
                throw new Error("Please input a username");
            }
            const clash = await R.findOne("user", " TRIM(username) = ? AND id != ? ", [username, bean.id]);
            if (clash) {
                throw new Error("This username is already taken");
            }

            bean.username = username;
            bean.role = user.role;
            bean.display_name = user.displayName || null;
            bean.email = user.email || null;
            bean.permissions = normaliseOverridesForStorage(user.overrides);
            bean.active = user.active === false ? 0 : 1;

            if (user.password) {
                bean.password = await passwordHash.generate(user.password);
            }

            await R.store(bean);
            log.info("user", `Edited user ${bean.id} (${username}) role=${bean.role} by user ${actor.id}`);

            // A changed role or override set alters what this user may see, and
            // which socket.io rooms they belong to. Force their sessions to
            // reconnect so visibility is recomputed rather than left stale.
            if (bean.id !== actor.id) {
                disconnectSessions(bean.id);
            }

            await sendUserList(socket);
            callback({ ok: true, msg: "Saved.", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("deleteUser", async (userID, callback) => {
        try {
            const actor = await requirePermission(socket, PERMISSIONS.USER_MANAGE);

            if (Number(userID) === Number(actor.id)) {
                throw new Error("You cannot delete your own account");
            }

            const bean = await R.findOne("user", " id = ? ", [userID]);
            if (!bean) {
                throw new Error("User not found");
            }

            if (bean.role === ROLE_ADMIN && !!bean.active && (await countOtherActiveAdmins(bean.id)) === 0) {
                throw new Error("Cannot remove the last administrator");
            }

            // Monitors and status pages reference the user with ON DELETE SET NULL,
            // so their records survive as unowned rather than disappearing.
            await R.trash(bean);
            log.info("user", `Deleted user ${userID} by user ${actor.id}`);

            disconnectSessions(bean.id);

            await sendUserList(socket);
            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Clearing the secret is what forces re-enrolment: login refuses to create
    // a session while twofa_status is 0, so the user must scan a new QR code.
    socket.on("resetUser2FA", async (userID, callback) => {
        try {
            const actor = await requirePermission(socket, PERMISSIONS.USER_MANAGE);

            const bean = await R.findOne("user", " id = ? ", [userID]);
            if (!bean) {
                throw new Error("User not found");
            }

            await R.exec(
                "UPDATE `user` SET twofa_status = 0, twofa_secret = NULL, twofa_last_token = NULL WHERE id = ? ",
                [bean.id]
            );

            log.info("user", `Reset 2FA for user ${bean.id} (${bean.username}) by user ${actor.id}`);

            // Drop their live sessions too, otherwise an already-open tab keeps
            // working and the reset only takes effect whenever they next log in.
            disconnectSessions(bean.id);

            await sendUserList(socket);
            callback({ ok: true, msg: "twoFAResetDone", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("getMyPermissions", async (callback) => {
        try {
            const user = await getSocketUser(socket);
            callback({
                ok: true,
                role: user.role,
                permissions: getEffectivePermissions(user),
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });
};

module.exports.sendUserList = sendUserList;
module.exports.toUserJSON = toUserJSON;
