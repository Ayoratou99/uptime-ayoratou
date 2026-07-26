const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const knexLib = require("knex");
const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));

const sqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
sqliteDialect.prototype._driver = () => require("@louislam/sqlite3");

const { DOWN, UP } = require("../../src/util");
const autoIncident = require("../../server/auto-incident");
const { INCIDENT_STATUS } = require("../../server/model/incident");

const REPO = path.join(__dirname, "..", "..");

let knex;
let tmpDir;

/**
 * Create a monitor.
 * @param {object} fields Column overrides.
 * @returns {Promise<Bean>} Monitor bean.
 */
async function makeMonitor(fields = {}) {
    const [id] = await knex("monitor").insert({
        name: "API",
        interval: 60,
        auto_incident_minutes: 5,
        ...fields,
    });
    return await R.findOne("monitor", " id = ? ", [id]);
}

/**
 * Create a status page publishing a monitor.
 * @param {number} monitorID Monitor to publish.
 * @param {object} fields Status page overrides.
 * @returns {Promise<number>} Status page id.
 */
async function makeStatusPageWith(monitorID, fields = {}) {
    const [pageID] = await knex("status_page").insert({
        slug: "demo-" + Math.random().toString(36).slice(2, 8),
        title: "Demo",
        icon: "/icon.svg",
        theme: "auto",
        ...fields,
    });
    const [groupID] = await knex("group").insert({ name: "Services", status_page_id: pageID });
    await knex("monitor_group").insert({ monitor_id: monitorID, group_id: groupID });
    return pageID;
}

/**
 * Write an important heartbeat, which is what marks a status transition.
 * @param {number} monitorID Monitor id.
 * @param {number} status DOWN or UP.
 * @param {number} minutesAgo How long ago the transition happened.
 * @returns {Promise<void>}
 */
async function makeTransition(monitorID, status, minutesAgo) {
    await knex("heartbeat").insert({
        monitor_id: monitorID,
        status,
        important: 1,
        msg: status === DOWN ? "connection refused" : "OK",
        time: dayjs.utc().subtract(minutesAgo, "minute").format("YYYY-MM-DD HH:mm:ss.SSS"),
    });
}

describe("Automatic incidents", () => {
    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ayoratou-auto-"));
        knex = knexLib({
            client: sqliteDialect,
            connection: { filename: path.join(tmpDir, "test.db") },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        R.setup(knex);
        R.freeze(true);
        await R.autoloadModels(path.join(REPO, "server/model"));

        const { createTables } = require(path.join(REPO, "db/knex_init_db"));
        await createTables();
        await knex.raw("PRAGMA foreign_keys = OFF");
        await knex.migrate.latest({ directory: path.join(REPO, "db/knex_migrations") });
        await knex.raw("PRAGMA foreign_keys = ON");
    });

    after(async () => {
        await knex.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
        await knex("incident_update").del();
        await knex("incident").del();
        await knex("heartbeat").del();
        await knex("monitor_group").del();
        await knex("group").del();
        await knex("status_page").del();
        await knex("monitor").del();
    });

    describe("downtime measurement", () => {
        test("reports minutes since the outage began", async () => {
            const monitor = await makeMonitor();
            await makeTransition(monitor.id, DOWN, 12);

            const minutes = await autoIncident.getDowntimeMinutes(monitor.id);
            assert.ok(minutes >= 11 && minutes <= 13, `expected about 12, got ${minutes}`);
        });

        test("returns null when the monitor is up", async () => {
            const monitor = await makeMonitor();
            await makeTransition(monitor.id, UP, 12);

            assert.strictEqual(await autoIncident.getDowntimeMinutes(monitor.id), null);
        });

        test("returns null when there is no history", async () => {
            const monitor = await makeMonitor();
            assert.strictEqual(await autoIncident.getDowntimeMinutes(monitor.id), null);
        });
    });

    describe("opening", () => {
        test("posts an incident once the threshold is passed", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            const page = await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);

            await autoIncident.handleHeartbeat(monitor, true);

            const incidents = await knex("incident").where({ status_page_id: page });
            assert.strictEqual(incidents.length, 1);
            assert.strictEqual(incidents[0].auto_monitor_id, monitor.id);
            assert.strictEqual(incidents[0].status, INCIDENT_STATUS.INVESTIGATING);
            assert.match(incidents[0].title, /API is down/);
        });

        test("seeds the incident timeline", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);

            await autoIncident.handleHeartbeat(monitor, true);

            const updates = await knex("incident_update");
            assert.strictEqual(updates.length, 1);
            assert.strictEqual(updates[0].status, INCIDENT_STATUS.INVESTIGATING);
            assert.strictEqual(updates[0].created_by, null, "machine-created updates have no author");
        });

        test("stays quiet before the threshold", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 10 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 3);

            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 0);
        });

        test("does nothing when the feature is off", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 0 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 120);

            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 0);
        });

        test("does nothing when the monitor is on no status page", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeTransition(monitor.id, DOWN, 30);

            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 0);
        });

        test("does not open a second incident while one is already open", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);

            await autoIncident.handleHeartbeat(monitor, true);
            await autoIncident.handleHeartbeat(monitor, true);
            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 1, "one outage means one incident");
        });

        test("posts on every status page publishing the monitor", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);

            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 2);
        });
    });

    describe("resolving", () => {
        test("closes the incident when the monitor recovers", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);
            await autoIncident.handleHeartbeat(monitor, true);

            await autoIncident.handleHeartbeat(monitor, false);

            const incident = (await knex("incident"))[0];
            assert.strictEqual(incident.status, INCIDENT_STATUS.RESOLVED);
            assert.strictEqual(!!incident.active, false);
        });

        test("records the recovery on the timeline", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);
            await makeTransition(monitor.id, DOWN, 7);
            await autoIncident.handleHeartbeat(monitor, true);

            await autoIncident.handleHeartbeat(monitor, false);

            const updates = await knex("incident_update").orderBy("id");
            assert.strictEqual(updates.length, 2, "open and resolve are both recorded");
            assert.strictEqual(updates[1].status, INCIDENT_STATUS.RESOLVED);
            assert.match(updates[1].content, /responding normally/);
        });

        test("leaves incidents an operator wrote by hand alone", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            const page = await makeStatusPageWith(monitor.id);
            await knex("incident").insert({
                title: "Planned work",
                content: "Written by a person.",
                style: "info",
                active: true,
                pin: true,
                status_page_id: page,
                status: INCIDENT_STATUS.INVESTIGATING,
                auto_monitor_id: null,
            });

            await autoIncident.handleHeartbeat(monitor, false);

            const incident = (await knex("incident"))[0];
            assert.strictEqual(incident.status, INCIDENT_STATUS.INVESTIGATING, "manual incident must be untouched");
            assert.strictEqual(!!incident.active, true);
        });

        test("recovery with nothing open is a no-op", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);

            await assert.doesNotReject(() => autoIncident.handleHeartbeat(monitor, false));
            assert.strictEqual((await knex("incident")).length, 0);
        });

        test("a fresh outage after recovery opens a new incident", async () => {
            const monitor = await makeMonitor({ auto_incident_minutes: 5 });
            await makeStatusPageWith(monitor.id);

            await makeTransition(monitor.id, DOWN, 7);
            await autoIncident.handleHeartbeat(monitor, true);
            await autoIncident.handleHeartbeat(monitor, false);

            await knex("heartbeat").del();
            await makeTransition(monitor.id, DOWN, 7);
            await autoIncident.handleHeartbeat(monitor, true);

            assert.strictEqual((await knex("incident")).length, 2, "second outage is its own incident");
        });
    });

    test("never throws, so the heartbeat loop cannot be interrupted", async () => {
        await assert.doesNotReject(() => autoIncident.handleHeartbeat({ id: 999999, name: "ghost" }, true));
        await assert.doesNotReject(() => autoIncident.handleHeartbeat({}, true));
        await assert.doesNotReject(() => autoIncident.handleHeartbeat({ auto_incident_minutes: "nonsense" }, true));
    });
});
