/*
 * Role-based access control for Ayoratou.
 *
 * A user has one role, which supplies a baseline set of permissions, plus an
 * optional JSON map of per-permission overrides stored on `user.permissions`.
 * An override of `true` grants a permission the role does not include; `false`
 * revokes one it does. Anything absent from the map falls through to the role.
 *
 * The `admin` role is special: it always holds every permission and cannot be
 * narrowed by overrides, so an installation can never lock itself out.
 */

const ROLE_ADMIN = "admin";
const ROLE_EDITOR = "editor";
const ROLE_VIEWER = "viewer";

const ROLES = [ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER];

/**
 * Every permission the application understands.
 *
 * `*.own` applies to records the user created; `*.all` extends the same action
 * to records created by anyone. A `.all` permission implies the matching
 * `.own` permission -- see {@link hasPermission}.
 */
const PERMISSIONS = {
    MONITOR_VIEW_ALL: "monitor.view.all",
    MONITOR_CREATE: "monitor.create",
    MONITOR_EDIT_OWN: "monitor.edit.own",
    MONITOR_EDIT_ALL: "monitor.edit.all",
    MONITOR_DELETE_OWN: "monitor.delete.own",
    MONITOR_DELETE_ALL: "monitor.delete.all",

    STATUSPAGE_VIEW_ALL: "statuspage.view.all",
    STATUSPAGE_CREATE: "statuspage.create",
    STATUSPAGE_EDIT_OWN: "statuspage.edit.own",
    STATUSPAGE_EDIT_ALL: "statuspage.edit.all",
    STATUSPAGE_DELETE_OWN: "statuspage.delete.own",
    STATUSPAGE_DELETE_ALL: "statuspage.delete.all",

    MAINTENANCE_MANAGE: "maintenance.manage",
    NOTIFICATION_MANAGE: "notification.manage",
    SETTINGS_MANAGE: "settings.manage",
    USER_MANAGE: "user.manage",
};

/** Flat list of every permission key, in display order. */
const PERMISSION_LIST = Object.values(PERMISSIONS);

/**
 * Permissions granted by each role before overrides are applied.
 * `admin` is intentionally absent: it short-circuits to "everything".
 */
const ROLE_PERMISSIONS = {
    [ROLE_EDITOR]: [
        PERMISSIONS.MONITOR_CREATE,
        PERMISSIONS.MONITOR_EDIT_OWN,
        PERMISSIONS.MONITOR_DELETE_OWN,
        PERMISSIONS.STATUSPAGE_CREATE,
        PERMISSIONS.STATUSPAGE_EDIT_OWN,
        PERMISSIONS.STATUSPAGE_DELETE_OWN,
        PERMISSIONS.MAINTENANCE_MANAGE,
        PERMISSIONS.NOTIFICATION_MANAGE,
    ],
    [ROLE_VIEWER]: [],
};

/**
 * Permissions that are implied by holding a broader one, so that granting
 * `monitor.edit.all` does not also require ticking `monitor.edit.own`.
 */
const IMPLIED_BY = {
    [PERMISSIONS.MONITOR_EDIT_OWN]: [PERMISSIONS.MONITOR_EDIT_ALL],
    [PERMISSIONS.MONITOR_DELETE_OWN]: [PERMISSIONS.MONITOR_DELETE_ALL],
    [PERMISSIONS.MONITOR_VIEW_ALL]: [PERMISSIONS.MONITOR_EDIT_ALL, PERMISSIONS.MONITOR_DELETE_ALL],
    [PERMISSIONS.STATUSPAGE_EDIT_OWN]: [PERMISSIONS.STATUSPAGE_EDIT_ALL],
    [PERMISSIONS.STATUSPAGE_DELETE_OWN]: [PERMISSIONS.STATUSPAGE_DELETE_ALL],
    [PERMISSIONS.STATUSPAGE_VIEW_ALL]: [PERMISSIONS.STATUSPAGE_EDIT_ALL, PERMISSIONS.STATUSPAGE_DELETE_ALL],
};

/**
 * Parse the override map stored on a user row.
 * Tolerates null, malformed JSON and non-object payloads, because this value
 * is round-tripped through the database and the admin UI.
 * @param {string|object|null} raw Value of `user.permissions`.
 * @returns {object} Map of permission key to boolean.
 */
function parseOverrides(raw) {
    if (!raw) {
        return {};
    }
    let parsed = raw;
    if (typeof raw === "string") {
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
    }

    const clean = {};
    for (const key of PERMISSION_LIST) {
        if (typeof parsed[key] === "boolean") {
            clean[key] = parsed[key];
        }
    }
    return clean;
}

/**
 * Normalise a role value read from the database.
 * @param {string} role Raw role value.
 * @returns {string} A role from {@link ROLES}, defaulting to viewer.
 */
function normaliseRole(role) {
    return ROLES.includes(role) ? role : ROLE_VIEWER;
}

/**
 * Resolve a user's effective permissions: role baseline, then overrides.
 * @param {object} user User bean or plain object with `role` and `permissions`.
 * @returns {object} Map of every permission key to a boolean.
 */
function getEffectivePermissions(user) {
    const role = normaliseRole(user?.role);
    const result = {};

    if (role === ROLE_ADMIN) {
        for (const key of PERMISSION_LIST) {
            result[key] = true;
        }
        return result;
    }

    const base = new Set(ROLE_PERMISSIONS[role] ?? []);
    const overrides = parseOverrides(user?.permissions);

    for (const key of PERMISSION_LIST) {
        result[key] = key in overrides ? overrides[key] : base.has(key);
    }
    return result;
}

/**
 * Test a single permission, honouring implication (`.all` implies `.own`).
 * @param {object} user User bean or plain object.
 * @param {string} permission Permission key from {@link PERMISSIONS}.
 * @returns {boolean} Whether the user holds the permission.
 */
function hasPermission(user, permission) {
    const effective = getEffectivePermissions(user);
    if (effective[permission]) {
        return true;
    }
    return (IMPLIED_BY[permission] ?? []).some((broader) => effective[broader]);
}

/**
 * Test whether a user may act on a record, taking ownership into account.
 * @param {object} user User bean or plain object.
 * @param {string} ownPermission Permission covering records the user owns.
 * @param {string} allPermission Permission covering records owned by anyone.
 * @param {number|string|null} ownerID `user_id` of the record.
 * @returns {boolean} Whether the action is allowed.
 */
function canActOn(user, ownPermission, allPermission, ownerID) {
    if (hasPermission(user, allPermission)) {
        return true;
    }
    // eslint-disable-next-line eqeqeq
    return hasPermission(user, ownPermission) && ownerID != null && ownerID == user?.id;
}

module.exports = {
    ROLE_ADMIN,
    ROLE_EDITOR,
    ROLE_VIEWER,
    ROLES,
    PERMISSIONS,
    PERMISSION_LIST,
    ROLE_PERMISSIONS,
    IMPLIED_BY,
    parseOverrides,
    normaliseRole,
    getEffectivePermissions,
    hasPermission,
    canActOn,
};
