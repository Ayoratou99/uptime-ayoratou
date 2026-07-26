const { describe, test } = require("node:test");
const assert = require("node:assert");
const {
    ROLE_ADMIN,
    ROLE_EDITOR,
    ROLE_VIEWER,
    PERMISSIONS,
    PERMISSION_LIST,
    parseOverrides,
    normaliseRole,
    getEffectivePermissions,
    hasPermission,
    canActOn,
} = require("../../server/permissions.js");

/**
 * Build a user-like object for the tests.
 * @param {string} role Role name.
 * @param {object|string|null} permissions Override map or raw JSON string.
 * @param {number} id User id.
 * @returns {object} User stub.
 */
function user(role, permissions = null, id = 1) {
    return {
        id,
        role,
        permissions: typeof permissions === "string" ? permissions : permissions && JSON.stringify(permissions),
    };
}

describe("Permissions: roles", () => {
    test("admin holds every permission", () => {
        const effective = getEffectivePermissions(user(ROLE_ADMIN));
        for (const key of PERMISSION_LIST) {
            assert.strictEqual(effective[key], true, `admin should hold ${key}`);
        }
    });

    test("admin cannot be narrowed by overrides", () => {
        const u = user(ROLE_ADMIN, {
            [PERMISSIONS.SETTINGS_MANAGE]: false,
            [PERMISSIONS.USER_MANAGE]: false,
        });
        assert.strictEqual(hasPermission(u, PERMISSIONS.SETTINGS_MANAGE), true);
        assert.strictEqual(hasPermission(u, PERMISSIONS.USER_MANAGE), true);
    });

    test("editor gets the create/own baseline but not the all/admin permissions", () => {
        const u = user(ROLE_EDITOR);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_CREATE), true);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_EDIT_OWN), true);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MAINTENANCE_MANAGE), true);

        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_EDIT_ALL), false);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_VIEW_ALL), false);
        assert.strictEqual(hasPermission(u, PERMISSIONS.SETTINGS_MANAGE), false);
        assert.strictEqual(hasPermission(u, PERMISSIONS.USER_MANAGE), false);
    });

    test("viewer holds nothing by default", () => {
        const effective = getEffectivePermissions(user(ROLE_VIEWER));
        for (const key of PERMISSION_LIST) {
            assert.strictEqual(effective[key], false, `viewer should not hold ${key}`);
        }
    });

    test("an unknown role is treated as viewer, not as admin", () => {
        assert.strictEqual(normaliseRole("superuser"), ROLE_VIEWER);
        assert.strictEqual(normaliseRole(undefined), ROLE_VIEWER);
        assert.strictEqual(hasPermission(user("superuser"), PERMISSIONS.MONITOR_CREATE), false);
    });
});

describe("Permissions: overrides", () => {
    test("an override can grant a permission above the role baseline", () => {
        const u = user(ROLE_EDITOR, { [PERMISSIONS.STATUSPAGE_EDIT_ALL]: true });
        assert.strictEqual(hasPermission(u, PERMISSIONS.STATUSPAGE_EDIT_ALL), true);
        // unrelated permissions are untouched
        assert.strictEqual(hasPermission(u, PERMISSIONS.SETTINGS_MANAGE), false);
    });

    test("an override can revoke a permission the role grants", () => {
        const u = user(ROLE_EDITOR, { [PERMISSIONS.MONITOR_CREATE]: false });
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_CREATE), false);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_EDIT_OWN), true);
    });

    test("malformed override payloads fall back to the role baseline", () => {
        for (const bad of ["not json", "[]", '"a string"', "null", "", null, undefined]) {
            const u = user(ROLE_EDITOR, bad);
            assert.strictEqual(
                hasPermission(u, PERMISSIONS.MONITOR_CREATE),
                true,
                `expected baseline for payload ${JSON.stringify(bad)}`
            );
        }
    });

    test("non-boolean and unknown override keys are ignored", () => {
        const parsed = parseOverrides(
            JSON.stringify({
                [PERMISSIONS.MONITOR_CREATE]: "yes",
                "monitor.launch.missiles": true,
                [PERMISSIONS.USER_MANAGE]: true,
            })
        );
        assert.deepStrictEqual(parsed, { [PERMISSIONS.USER_MANAGE]: true });
    });
});

describe("Permissions: implication", () => {
    test("edit.all implies edit.own", () => {
        const u = user(ROLE_VIEWER, { [PERMISSIONS.MONITOR_EDIT_ALL]: true });
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_EDIT_OWN), true);
    });

    test("edit.all implies being able to view all monitors", () => {
        const u = user(ROLE_VIEWER, { [PERMISSIONS.MONITOR_EDIT_ALL]: true });
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_VIEW_ALL), true);
    });

    test("edit.own does not imply edit.all", () => {
        const u = user(ROLE_VIEWER, { [PERMISSIONS.MONITOR_EDIT_OWN]: true });
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_EDIT_ALL), false);
        assert.strictEqual(hasPermission(u, PERMISSIONS.MONITOR_VIEW_ALL), false);
    });
});

describe("Permissions: ownership", () => {
    const own = PERMISSIONS.MONITOR_EDIT_OWN;
    const all = PERMISSIONS.MONITOR_EDIT_ALL;

    test("an editor may act on their own record", () => {
        assert.strictEqual(canActOn(user(ROLE_EDITOR, null, 7), own, all, 7), true);
    });

    test("an editor may not act on someone else's record", () => {
        assert.strictEqual(canActOn(user(ROLE_EDITOR, null, 7), own, all, 8), false);
    });

    test("edit.all lets a user act on someone else's record", () => {
        const u = user(ROLE_EDITOR, { [all]: true }, 7);
        assert.strictEqual(canActOn(u, own, all, 8), true);
    });

    test("an orphaned record (null owner) is not editable via the own permission", () => {
        assert.strictEqual(canActOn(user(ROLE_EDITOR, null, 7), own, all, null), false);
    });

    test("an orphaned record is still editable with the all permission", () => {
        const u = user(ROLE_EDITOR, { [all]: true }, 7);
        assert.strictEqual(canActOn(u, own, all, null), true);
    });

    test("string and number owner ids compare equal across the socket boundary", () => {
        assert.strictEqual(canActOn(user(ROLE_EDITOR, null, 7), own, all, "7"), true);
        assert.strictEqual(canActOn(user(ROLE_EDITOR, null, "7"), own, all, 7), true);
    });

    test("a viewer may not act on their own record", () => {
        assert.strictEqual(canActOn(user(ROLE_VIEWER, null, 7), own, all, 7), false);
    });
});
