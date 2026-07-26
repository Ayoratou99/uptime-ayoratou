/*
 * Socket.io-facing wrappers around server/permissions.js.
 *
 * These are kept separate from permissions.js so that the permission rules
 * themselves stay pure and unit-testable without a database.
 *
 * The user row is re-read on each check rather than cached on the socket, so
 * that revoking a permission takes effect immediately instead of at the
 * connected user's next reconnect.
 */
const { R } = require("redbean-node");
const { PERMISSIONS, hasPermission, canActOn } = require("./permissions");

/** Socket.io room that receives events for every monitor, regardless of owner. */
const ROOM_VIEW_ALL_MONITORS = "view-all-monitors";

/**
 * Load the authenticated user behind a socket.
 * @param {Socket} socket Socket.io instance.
 * @returns {Promise<Bean>} The user bean.
 * @throws {Error} If the socket is not authenticated or the user is gone/disabled.
 */
async function getSocketUser(socket) {
    if (!socket.userID) {
        throw new Error("You are not logged in.");
    }
    const user = await R.findOne("user", " id = ? AND active = 1 ", [socket.userID]);
    if (!user) {
        throw new Error("You are not logged in.");
    }
    return user;
}

/**
 * Assert that the socket's user holds a permission.
 * @param {Socket} socket Socket.io instance.
 * @param {string} permission Permission key.
 * @returns {Promise<Bean>} The user bean, for callers that need it.
 * @throws {Error} If the permission is not held.
 */
async function requirePermission(socket, permission) {
    const user = await getSocketUser(socket);
    if (!hasPermission(user, permission)) {
        throw new Error("You do not have permission to perform this action.");
    }
    return user;
}

/**
 * Assert that the socket's user may act on a record they may or may not own.
 * @param {Socket} socket Socket.io instance.
 * @param {string} ownPermission Permission covering records the user owns.
 * @param {string} allPermission Permission covering records owned by anyone.
 * @param {number|string|null} ownerID `user_id` of the record.
 * @returns {Promise<Bean>} The user bean.
 * @throws {Error} If the action is not allowed.
 */
async function requireActOn(socket, ownPermission, allPermission, ownerID) {
    const user = await getSocketUser(socket);
    if (!canActOn(user, ownPermission, allPermission, ownerID)) {
        throw new Error("You do not have permission to perform this action.");
    }
    return user;
}

/**
 * Whether a user sees every monitor rather than only the ones they own.
 * @param {object} user User bean or plain object.
 * @returns {boolean} True if all monitors are visible.
 */
function canViewAllMonitors(user) {
    return hasPermission(user, PERMISSIONS.MONITOR_VIEW_ALL);
}

/**
 * Whether a user sees every status page rather than only the ones they own.
 * @param {object} user User bean or plain object.
 * @returns {boolean} True if all status pages are visible.
 */
function canViewAllStatusPages(user) {
    return hasPermission(user, PERMISSIONS.STATUSPAGE_VIEW_ALL);
}

module.exports = {
    ROOM_VIEW_ALL_MONITORS,
    getSocketUser,
    requirePermission,
    requireActOn,
    canViewAllMonitors,
    canViewAllStatusPages,
};
