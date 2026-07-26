const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const knexLib = require("knex");
const { R } = require("redbean-node");

const sqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
sqliteDialect.prototype._driver = () => require("@louislam/sqlite3");

const { ROLE_ADMIN, ROLE_EDITOR, ROLE_VIEWER, PERMISSIONS } = require("../../server/permissions");
const { userSocketHandler } = require("../../server/socket-handlers/user-socket-handler");

const REPO = path.join(__dirname, "..", "..");

let knex;
let tmpDir;

/**
 * A stand-in for a socket.io socket.
 *
 * Records registered handlers so tests can invoke them directly, and captures
 * emitted events for assertions.
 */
class FakeSocket {
    handlers = {};
    emitted = [];

    /**
     * @param {number|null} userID Authenticated user, or null for anonymous.
     */
    constructor(userID) {
        this.userID = userID;
    }

    /**
     * Register a handler, mirroring socket.on.
     * @param {string} event Event name.
     * @param {Function} fn Handler.
     * @returns {void}
     */
    on(event, fn) {
        this.handlers[event] = fn;
    }

    /**
     * Record an emitted event.
     * @param {string} event Event name.
     * @param {any} payload Payload.
     * @returns {void}
     */
    emit(event, payload) {
        this.emitted.push({ event, payload });
    }

    /**
     * Invoke a registered handler and resolve with its callback result.
     * @param {string} event Event name.
     * @param {...any} args Arguments before the callback.
     * @returns {Promise<object>} The callback payload.
     */
    call(event, ...args) {
        return new Promise((resolve, reject) => {
            const fn = this.handlers[event];
            if (!fn) {
                reject(new Error(`no handler registered for ${event}`));
                return;
            }
            Promise.resolve(fn(...args, resolve)).catch(reject);
        });
    }

    /**
     * Last payload emitted for an event.
     * @param {string} event Event name.
     * @returns {any} Payload, or undefined.
     */
    lastEmit(event) {
        const hits = this.emitted.filter((e) => e.event === event);
        return hits.length ? hits[hits.length - 1].payload : undefined;
    }
}

/**
 * Create a user row directly.
 * @param {string} username Username.
 * @param {string} role Role.
 * @param {object} extra Extra columns.
 * @returns {Promise<number>} New user id.
 */
async function makeUser(username, role, extra = {}) {
    const [id] = await knex("user").insert({
        username,
        password: "x",
        role,
        active: 1,
        ...extra,
    });
    return id;
}

/**
 * Build a socket with the user handlers attached.
 * @param {number} userID Acting user.
 * @returns {FakeSocket} Ready socket.
 */
function socketFor(userID) {
    const socket = new FakeSocket(userID);
    userSocketHandler(socket);
    return socket;
}

describe("User management", () => {
    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ayoratou-users-"));
        knex = knexLib({
            client: sqliteDialect,
            connection: { filename: path.join(tmpDir, "test.db") },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        R.setup(knex);
        R.freeze(true);

        const { createTables } = require(path.join(REPO, "db/knex_init_db"));
        await createTables();
        // Migrations run with foreign keys off (as Database.patch does), then
        // back on -- the app enables them per connection in initSQLite, so
        // ON DELETE SET NULL must be active for these tests to be faithful.
        await knex.raw("PRAGMA foreign_keys = OFF");
        await knex.migrate.latest({ directory: path.join(REPO, "db/knex_migrations") });
        await knex.raw("PRAGMA foreign_keys = ON");
    });

    after(async () => {
        await knex.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await knex("user").del();
    });

    describe("authorisation", () => {
        test("an editor cannot list users", async () => {
            const editor = await makeUser("editor", ROLE_EDITOR);
            const res = await socketFor(editor).call("getUserList");
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /do not have permission/);
        });

        test("an editor cannot create users", async () => {
            const editor = await makeUser("editor", ROLE_EDITOR);
            const res = await socketFor(editor).call("addUser", {
                username: "sneaky",
                password: "pw",
                role: ROLE_ADMIN,
            });
            assert.strictEqual(res.ok, false);
            assert.strictEqual(await knex("user").where({ username: "sneaky" }).first(), undefined);
        });

        test("an unauthenticated socket cannot list users", async () => {
            const res = await socketFor(null).call("getUserList");
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /not logged in/);
        });

        test("a viewer granted user.manage can list users", async () => {
            const viewer = await makeUser("viewer", ROLE_VIEWER, {
                permissions: JSON.stringify({ [PERMISSIONS.USER_MANAGE]: true }),
            });
            const res = await socketFor(viewer).call("getUserList");
            assert.strictEqual(res.ok, true);
        });

        test("a deactivated admin is treated as logged out", async () => {
            const admin = await makeUser("ghost", ROLE_ADMIN, { active: 0 });
            const res = await socketFor(admin).call("getUserList");
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /not logged in/);
        });
    });

    describe("creating users", () => {
        test("an admin creates a user and the password is hashed", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const res = await socketFor(admin).call("addUser", {
                username: "alice",
                password: "s3cret",
                role: ROLE_EDITOR,
                email: "alice@example.com",
            });

            assert.strictEqual(res.ok, true);
            const row = await knex("user").where({ username: "alice" }).first();
            assert.strictEqual(row.role, ROLE_EDITOR);
            assert.notStrictEqual(row.password, "s3cret", "password must not be stored in plain text");
        });

        test("duplicate usernames are rejected", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            await makeUser("alice", ROLE_EDITOR);

            const res = await socketFor(admin).call("addUser", {
                username: "alice",
                password: "pw",
                role: ROLE_EDITOR,
            });
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /already taken/);
        });

        test("an unknown role is rejected rather than silently defaulted", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const res = await socketFor(admin).call("addUser", {
                username: "bob",
                password: "pw",
                role: "superuser",
            });
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /Invalid role/);
        });

        test("unknown override keys are discarded before storage", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            await socketFor(admin).call("addUser", {
                username: "carol",
                password: "pw",
                role: ROLE_EDITOR,
                overrides: {
                    [PERMISSIONS.MONITOR_EDIT_ALL]: true,
                    "monitor.launch.missiles": true,
                    [PERMISSIONS.SETTINGS_MANAGE]: "yes",
                },
            });

            const row = await knex("user").where({ username: "carol" }).first();
            assert.deepStrictEqual(JSON.parse(row.permissions), {
                [PERMISSIONS.MONITOR_EDIT_ALL]: true,
            });
        });

        test("the user list never exposes password hashes", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const socket = socketFor(admin);
            await socket.call("getUserList");

            const list = socket.lastEmit("userList");
            assert.ok(Array.isArray(list) && list.length > 0);
            for (const entry of list) {
                assert.ok(!("password" in entry), "password must not be sent to the client");
            }
        });
    });

    describe("last administrator protection", () => {
        test("the only admin cannot demote themselves", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const res = await socketFor(admin).call("editUser", {
                id: admin,
                username: "admin",
                role: ROLE_EDITOR,
            });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /last administrator/);
            assert.strictEqual((await knex("user").where({ id: admin }).first()).role, ROLE_ADMIN);
        });

        test("the only admin cannot deactivate themselves", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const res = await socketFor(admin).call("editUser", {
                id: admin,
                username: "admin",
                role: ROLE_ADMIN,
                active: false,
            });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /last administrator/);
        });

        test("an admin can be demoted once another active admin exists", async () => {
            const first = await makeUser("admin1", ROLE_ADMIN);
            await makeUser("admin2", ROLE_ADMIN);

            const res = await socketFor(first).call("editUser", {
                id: first,
                username: "admin1",
                role: ROLE_EDITOR,
            });

            assert.strictEqual(res.ok, true);
            assert.strictEqual((await knex("user").where({ id: first }).first()).role, ROLE_EDITOR);
        });

        test("an inactive second admin does not count as a replacement", async () => {
            const active = await makeUser("admin1", ROLE_ADMIN);
            await makeUser("admin2", ROLE_ADMIN, { active: 0 });

            const res = await socketFor(active).call("editUser", {
                id: active,
                username: "admin1",
                role: ROLE_EDITOR,
            });

            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /last administrator/);
        });

        test("the last admin cannot be deleted by another user holding user.manage", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const manager = await makeUser("manager", ROLE_VIEWER, {
                permissions: JSON.stringify({ [PERMISSIONS.USER_MANAGE]: true }),
            });

            const res = await socketFor(manager).call("deleteUser", admin);
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /last administrator/);
            assert.ok(await knex("user").where({ id: admin }).first());
        });
    });

    describe("monitor ownership", () => {
        test("resolves the owner of each monitor in one lookup", async () => {
            const alice = await makeUser("alice", ROLE_EDITOR, { display_name: "Alice A." });
            const bob = await makeUser("bob", ROLE_EDITOR);

            const [m1] = await knex("monitor").insert({ name: "a", user_id: alice, interval: 60 });
            const [m2] = await knex("monitor").insert({ name: "b", user_id: bob, interval: 60 });

            const Monitor = require("../../server/model/monitor");
            const rows = await Monitor.getMonitorOwner([m1, m2]);
            const byMonitor = Object.fromEntries(rows.map((r) => [r.monitor_id, r]));

            assert.strictEqual(byMonitor[m1].username, "alice");
            assert.strictEqual(byMonitor[m1].display_name, "Alice A.");
            assert.strictEqual(byMonitor[m2].username, "bob");
            assert.strictEqual(byMonitor[m2].display_name, null);
        });

        test("an unowned monitor resolves to a null user rather than being dropped", async () => {
            const [orphan] = await knex("monitor").insert({ name: "orphan", user_id: null, interval: 60 });

            const Monitor = require("../../server/model/monitor");
            const rows = await Monitor.getMonitorOwner([orphan]);

            assert.strictEqual(rows.length, 1, "the monitor must still appear");
            assert.strictEqual(rows[0].user_id, null);
            assert.strictEqual(rows[0].username, null);
        });

        test("an empty id list does not hit the database", async () => {
            const Monitor = require("../../server/model/monitor");
            assert.deepStrictEqual(await Monitor.getMonitorOwner([]), []);
        });
    });

    describe("deleting users", () => {
        test("a user cannot delete their own account", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            await makeUser("admin2", ROLE_ADMIN);

            const res = await socketFor(admin).call("deleteUser", admin);
            assert.strictEqual(res.ok, false);
            assert.match(res.msg, /your own account/);
        });

        test("deleting a user leaves their monitors in place but unowned", async () => {
            const admin = await makeUser("admin", ROLE_ADMIN);
            const alice = await makeUser("alice", ROLE_EDITOR);

            const [monitorID] = await knex("monitor").insert({
                name: "alice's monitor",
                user_id: alice,
                interval: 60,
            });

            const res = await socketFor(admin).call("deleteUser", alice);
            assert.strictEqual(res.ok, true);

            const monitor = await knex("monitor").where({ id: monitorID }).first();
            assert.ok(monitor, "monitor should survive its owner being deleted");
            assert.strictEqual(monitor.user_id, null, "monitor should become unowned");
        });
    });
});
