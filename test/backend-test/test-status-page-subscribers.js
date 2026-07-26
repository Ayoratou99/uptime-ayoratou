const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const knexLib = require("knex");
const { R } = require("redbean-node");

const sqliteDialect = require("knex/lib/dialects/sqlite3/index.js");
sqliteDialect.prototype._driver = () => require("@louislam/sqlite3");

const mailer = require("../../server/status-page-mailer");

const REPO = path.join(__dirname, "..", "..");

let knex;
let tmpDir;

/**
 * Create a status page.
 * @param {object} fields Column overrides.
 * @returns {Promise<number>} Status page id.
 */
async function makeStatusPage(fields = {}) {
    const [id] = await knex("status_page").insert({
        slug: "demo",
        title: "Demo",
        icon: "/icon.svg",
        theme: "auto",
        subscription_enabled: true,
        ...fields,
    });
    return id;
}

/**
 * Create a subscriber row.
 * @param {number} statusPageID Owning status page.
 * @param {object} fields Column overrides.
 * @returns {Promise<number>} Subscriber id.
 */
async function makeSubscriber(statusPageID, fields = {}) {
    const [id] = await knex("status_page_subscriber").insert({
        status_page_id: statusPageID,
        email: "reader@example.com",
        confirmed: true,
        unsubscribe_token: mailer.generateToken(),
        ...fields,
    });
    return id;
}

describe("Status page subscribers", () => {
    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ayoratou-subs-"));
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
        await knex("status_page_subscriber").del();
        await knex("monitor_group").del();
        await knex("group").del();
        await knex("status_page").del();
        await knex("setting").del();
    });

    describe("tokens", () => {
        test("are long and unpredictable", () => {
            const a = mailer.generateToken();
            const b = mailer.generateToken();

            assert.strictEqual(a.length, 64);
            assert.notStrictEqual(a, b);
            assert.match(a, /^[0-9a-f]+$/);
        });
    });

    describe("configuration", () => {
        test("is considered unconfigured until host, port and sender are set", () => {
            assert.strictEqual(mailer.isConfigured({}), false);
            assert.strictEqual(mailer.isConfigured({ host: "smtp.example.com" }), false);
            assert.strictEqual(mailer.isConfigured({ host: "smtp.example.com", port: 587 }), false);
            assert.strictEqual(
                mailer.isConfigured({ host: "smtp.example.com", port: 587, fromAddress: "a@b.c" }),
                true
            );
        });

        test("building a transport without configuration is refused", () => {
            assert.throws(() => mailer.createTransport({}), /not configured/);
        });

        test("omits auth when no username is set, so open relays are not sent empty credentials", () => {
            const transport = mailer.createTransport({
                host: "smtp.example.com",
                port: 25,
                fromAddress: "a@b.c",
            });
            assert.strictEqual(transport.options.auth, undefined);
        });

        test("includes auth when a username is set", () => {
            const transport = mailer.createTransport({
                host: "smtp.example.com",
                port: 587,
                fromAddress: "a@b.c",
                username: "user",
                password: "pw",
            });
            assert.strictEqual(transport.options.auth.user, "user");
        });
    });

    describe("delivery gating", () => {
        test("nothing is sent when SMTP is not configured", async () => {
            const page = await makeStatusPage();
            await makeSubscriber(page);

            const result = await mailer.sendToSubscribers(page, () => ({
                subject: "x",
                text: "x",
                html: "x",
            }));

            assert.deepStrictEqual(result, { sent: 0, failed: 0 });
        });

        test("nothing is sent when the page has subscriptions disabled", async () => {
            await knex("setting").insert({
                key: "host",
                value: JSON.stringify("smtp.example.com"),
                type: mailer.SETTINGS_TYPE,
            });
            await knex("setting").insert({ key: "port", value: JSON.stringify(587), type: mailer.SETTINGS_TYPE });
            await knex("setting").insert({
                key: "fromAddress",
                value: JSON.stringify("a@b.c"),
                type: mailer.SETTINGS_TYPE,
            });

            const page = await makeStatusPage({ subscription_enabled: false });
            await makeSubscriber(page);

            const result = await mailer.sendToSubscribers(page, () => ({
                subject: "x",
                text: "x",
                html: "x",
            }));

            assert.deepStrictEqual(result, { sent: 0, failed: 0 });
        });
    });

    describe("monitor to status page resolution", () => {
        /**
         * Attach a monitor to a status page through a group.
         * @param {number} statusPageID Status page.
         * @param {number} monitorID Monitor.
         * @returns {Promise<void>}
         */
        async function publish(statusPageID, monitorID) {
            const [groupID] = await knex("group").insert({
                name: "Services",
                status_page_id: statusPageID,
            });
            await knex("monitor_group").insert({ monitor_id: monitorID, group_id: groupID });
        }

        test("finds pages that publish the monitor and accept subscriptions", async () => {
            const page = await makeStatusPage({ slug: "a" });
            const [monitorID] = await knex("monitor").insert({ name: "api", interval: 60 });
            await publish(page, monitorID);

            assert.deepStrictEqual(await mailer.getSubscribedStatusPageIDs(monitorID), [page]);
        });

        test("skips pages with subscriptions disabled", async () => {
            const page = await makeStatusPage({ slug: "b", subscription_enabled: false });
            const [monitorID] = await knex("monitor").insert({ name: "api", interval: 60 });
            await publish(page, monitorID);

            assert.deepStrictEqual(await mailer.getSubscribedStatusPageIDs(monitorID), []);
        });

        test("a monitor on no status page resolves to nothing", async () => {
            const [monitorID] = await knex("monitor").insert({ name: "orphan", interval: 60 });
            assert.deepStrictEqual(await mailer.getSubscribedStatusPageIDs(monitorID), []);
        });

        test("a monitor on two pages is reported once per page", async () => {
            const first = await makeStatusPage({ slug: "one" });
            const second = await makeStatusPage({ slug: "two" });
            const [monitorID] = await knex("monitor").insert({ name: "api", interval: 60 });
            await publish(first, monitorID);
            await publish(second, monitorID);

            const ids = await mailer.getSubscribedStatusPageIDs(monitorID);
            assert.deepStrictEqual(ids.sort(), [first, second].sort());
        });

        test("notifyMonitorChange swallows failures so the heartbeat loop is never interrupted", async () => {
            const page = await makeStatusPage({ slug: "c" });
            const [monitorID] = await knex("monitor").insert({ name: "api", interval: 60 });
            await publish(page, monitorID);

            // SMTP is unconfigured, and the monitor stub is deliberately sparse.
            await assert.doesNotReject(() => mailer.notifyMonitorChange({ id: monitorID, name: "api" }, false, "down"));
        });
    });

    describe("subscriber records", () => {
        test("the same address cannot be subscribed twice to one page", async () => {
            const page = await makeStatusPage();
            await makeSubscriber(page, { email: "dup@example.com" });

            await assert.rejects(() => makeSubscriber(page, { email: "dup@example.com" }));
        });

        test("the same address may subscribe to different pages", async () => {
            const first = await makeStatusPage({ slug: "one" });
            const second = await makeStatusPage({ slug: "two" });

            await makeSubscriber(first, { email: "reader@example.com" });
            await assert.doesNotReject(() => makeSubscriber(second, { email: "reader@example.com" }));
        });

        test("subscribers are removed with their status page", async () => {
            const page = await makeStatusPage();
            await makeSubscriber(page);

            await knex("status_page").where({ id: page }).del();

            const remaining = await knex("status_page_subscriber").where({ status_page_id: page });
            assert.strictEqual(remaining.length, 0);
        });

        test("a new subscriber is unconfirmed by default", async () => {
            const page = await makeStatusPage();
            const [id] = await knex("status_page_subscriber").insert({
                status_page_id: page,
                email: "new@example.com",
                unsubscribe_token: mailer.generateToken(),
            });

            const row = await knex("status_page_subscriber").where({ id }).first();
            assert.strictEqual(!!row.confirmed, false, "must require confirmation before receiving mail");
        });
    });
});
