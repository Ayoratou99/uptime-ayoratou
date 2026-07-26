const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const knexLib = require("knex");
const { R } = require("redbean-node");

const sqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
sqliteDialect.prototype._driver = () => require("@louislam/sqlite3");

const Incident = require("../../server/model/incident");
const { INCIDENT_STATUS } = require("../../server/model/incident");

const REPO = path.join(__dirname, "..", "..");

let knex;
let tmpDir;

/**
 * Create a status page row.
 * @param {string} slug Page slug.
 * @returns {Promise<number>} Status page id.
 */
async function makeStatusPage(slug = "demo") {
    const [id] = await knex("status_page").insert({
        slug,
        title: "Demo",
        icon: "/icon.svg",
        theme: "auto",
    });
    return id;
}

/**
 * Create an incident and return it as a bean.
 * @param {number} statusPageID Owning status page.
 * @param {object} fields Column overrides.
 * @returns {Promise<Bean>} Incident bean.
 */
async function makeIncident(statusPageID, fields = {}) {
    const [id] = await knex("incident").insert({
        title: "Database degraded",
        content: "We are looking into elevated error rates.",
        style: "warning",
        status: INCIDENT_STATUS.INVESTIGATING,
        active: true,
        pin: true,
        status_page_id: statusPageID,
        created_date: "2026-07-26 09:00:00",
        ...fields,
    });
    return await R.findOne("incident", " id = ? ", [id]);
}

describe("Incident updates", () => {
    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ayoratou-incident-"));
        knex = knexLib({
            client: sqliteDialect,
            connection: { filename: path.join(tmpDir, "test.db") },
            useNullAsDefault: true,
            pool: { min: 1, max: 1 },
        });
        R.setup(knex);
        R.freeze(true);
        // Without this, R.findOne returns a plain bean and the Incident model's
        // methods are missing -- the same autoload Database.connect performs.
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
        await knex("status_page").del();
        await knex("user").del();
    });

    test("adding an update keeps the earlier text instead of overwriting it", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        await incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "Cause found: a bad deploy.");
        await incident.addUpdate(INCIDENT_STATUS.MONITORING, "Rolled back, watching recovery.");

        const updates = (await Incident.getUpdatesFor([incident.id])).get(incident.id);

        assert.strictEqual(updates.length, 2);
        // Newest first.
        assert.strictEqual(updates[0].content, "Rolled back, watching recovery.");
        assert.strictEqual(updates[1].content, "Cause found: a bad deploy.");
    });

    test("the incident tracks the latest status and content", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        await incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "Cause found.");

        const row = await knex("incident").where({ id: incident.id }).first();
        assert.strictEqual(row.status, INCIDENT_STATUS.IDENTIFIED);
        assert.strictEqual(row.content, "Cause found.");
        assert.ok(row.last_updated_date, "last_updated_date should be stamped");
    });

    test("resolving through an update closes the incident", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        await incident.addUpdate(INCIDENT_STATUS.RESOLVED, "All good now.");

        const row = await knex("incident").where({ id: incident.id }).first();
        assert.strictEqual(row.status, INCIDENT_STATUS.RESOLVED);
        assert.strictEqual(!!row.active, false);
        assert.strictEqual(!!row.pin, false);
    });

    test("an unknown status is rejected", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        await assert.rejects(() => incident.addUpdate("exploded", "text"), /Invalid incident status/);
        assert.strictEqual(
            await knex("incident_update")
                .count("* as c")
                .first()
                .then((r) => r.c),
            0
        );
    });

    test("empty content is rejected", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        await assert.rejects(() => incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "   "), /Please input content/);
        await assert.rejects(() => incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, ""), /Please input content/);
    });

    test("the update records its author", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);
        const [userID] = await knex("user").insert({
            username: "ops",
            password: "x",
            role: "admin",
            display_name: "Ops Team",
        });

        await incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "Investigating.", userID);

        const updates = (await Incident.getUpdatesFor([incident.id])).get(incident.id);
        assert.strictEqual(updates[0].author, "Ops Team");
    });

    test("an update whose author was deleted still renders", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);
        const [userID] = await knex("user").insert({ username: "temp", password: "x", role: "editor" });

        await incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "Investigating.", userID);
        await knex("user").where({ id: userID }).del();

        const updates = (await Incident.getUpdatesFor([incident.id])).get(incident.id);
        assert.strictEqual(updates.length, 1, "the update must survive its author");
        assert.strictEqual(updates[0].author, null);
    });

    test("deleting an incident removes its timeline", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);
        await incident.addUpdate(INCIDENT_STATUS.IDENTIFIED, "Cause found.");

        await knex("incident").where({ id: incident.id }).del();

        const remaining = await knex("incident_update").where({ incident_id: incident.id });
        assert.strictEqual(remaining.length, 0, "updates should cascade with the incident");
    });

    test("timelines of several incidents are fetched together and kept separate", async () => {
        const page = await makeStatusPage();
        const a = await makeIncident(page, { title: "A" });
        const b = await makeIncident(page, { title: "B" });

        await a.addUpdate(INCIDENT_STATUS.IDENTIFIED, "A first");
        await b.addUpdate(INCIDENT_STATUS.IDENTIFIED, "B first");
        await b.addUpdate(INCIDENT_STATUS.MONITORING, "B second");

        const updates = await Incident.getUpdatesFor([a.id, b.id]);
        assert.strictEqual(updates.get(a.id).length, 1);
        assert.strictEqual(updates.get(b.id).length, 2);
        assert.strictEqual(updates.get(a.id)[0].content, "A first");
    });

    test("toPublicJSON exposes the status and timeline", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);
        await incident.addUpdate(INCIDENT_STATUS.MONITORING, "Watching.");

        const updates = (await Incident.getUpdatesFor([incident.id])).get(incident.id);
        const json = incident.toPublicJSON(updates);

        assert.strictEqual(json.status, INCIDENT_STATUS.MONITORING);
        assert.strictEqual(json.updates.length, 1);
        assert.strictEqual(json.updates[0].content, "Watching.");
    });

    test("an incident with no timeline serialises to an empty list, not null", async () => {
        const page = await makeStatusPage();
        const incident = await makeIncident(page);

        assert.deepStrictEqual(incident.toPublicJSON().updates, []);
    });

    test("getUpdatesFor with no ids does not query", async () => {
        assert.strictEqual((await Incident.getUpdatesFor([])).size, 0);
    });
});
