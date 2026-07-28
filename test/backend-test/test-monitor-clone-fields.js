const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const knexLib = require("knex");
const { R } = require("redbean-node");

const sqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
sqliteDialect.prototype._driver = () => require("@louislam/sqlite3");

const REPO = path.join(__dirname, "..", "..");

let knex;
let tmpDir;
let monitorColumns;

/*
 * Cloning posts a monitor's own toJSON output back to the `add` handler, which
 * hands it to bean.import(). Any key in toJSON that is not a column on the
 * monitor table therefore has to be stripped first, or the insert fails.
 *
 * This broke once already: the "added by" feature added `owner` and `userID`
 * to toJSON without adding them to the strip list, and every clone failed with
 * an unknown-column error. This test fails if that happens again.
 */

/**
 * Keys emitted by toJSON that are deliberately not columns, each stripped
 * before import. Keep in step with frontendOnlyProperties in server.js.
 */
const STRIPPED_BEFORE_IMPORT = [
    "humanReadableInterval",
    "globalpingdnsresolvetypeoptions",
    "responsecheck",
    "owner",
    "userID",
    "includeSensitiveData",
    "maintenance",
    "childrenIDs",
    "forceInactive",
    "path",
    "pathName",
    "screenshot",
    // Handled explicitly by the add/edit handlers rather than by import().
    "id",
    "tags",
    "notificationIDList",
    "accepted_statuscodes",
    "conditions",
    "kafkaProducerBrokers",
    "kafkaProducerSaslOptions",
    "rabbitmqNodes",
    "retryOnlyOnStatusCodeFailure",
    "autoIncidentMinutes",
];

/**
 * camelCase to snake_case, matching how redbean maps bean properties.
 * @param {string} key Property name.
 * @returns {string} Column name.
 */
function toColumn(key) {
    return key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

describe("Monitor clone field safety", () => {
    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ayoratou-clone-"));
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

        monitorColumns = Object.keys(await knex("monitor").columnInfo());
    });

    after(async () => {
        await knex.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("the server strips every toJSON key that is not a monitor column", async () => {
        const [id] = await knex("monitor").insert({ name: "api", interval: 60 });
        const monitor = await R.findOne("monitor", " id = ? ", [id]);

        const Monitor = require("../../server/model/monitor");
        const preload = await Monitor.preparePreloadData([{ id, active: true, name: "api" }]);
        const json = monitor.toJSON(preload);

        const unstripped = Object.keys(json).filter((key) => {
            if (STRIPPED_BEFORE_IMPORT.includes(key)) {
                return false;
            }
            return !monitorColumns.includes(key) && !monitorColumns.includes(toColumn(key));
        });

        assert.deepStrictEqual(
            unstripped,
            [],
            `toJSON emits ${JSON.stringify(unstripped)}, which are not monitor columns and are not ` +
                "stripped before bean.import(). Cloning a monitor will fail. Either add them to " +
                "frontendOnlyProperties in server.js and to STRIPPED_BEFORE_IMPORT here, or add a migration."
        );
    });

    test("the attribution fields specifically are covered", async () => {
        const [id] = await knex("monitor").insert({ name: "api", interval: 60 });
        const monitor = await R.findOne("monitor", " id = ? ", [id]);

        const Monitor = require("../../server/model/monitor");
        const preload = await Monitor.preparePreloadData([{ id, active: true, name: "api" }]);
        const json = monitor.toJSON(preload);

        // These exist for display and caused the original breakage.
        assert.ok("owner" in json, "toJSON should still expose owner for the UI");
        assert.ok("userID" in json, "toJSON should still expose userID for the UI");
        assert.ok(!monitorColumns.includes("owner"), "owner is not a column, so it must be stripped");
        assert.ok(STRIPPED_BEFORE_IMPORT.includes("owner"));
        assert.ok(STRIPPED_BEFORE_IMPORT.includes("userID"));
    });
});
