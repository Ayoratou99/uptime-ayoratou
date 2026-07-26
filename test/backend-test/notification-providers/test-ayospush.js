const { describe, test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

/**
 * Spin up a throwaway HTTP server standing in for the AyosPush API.
 *
 * `handlers` maps a path to a function returning { status, body }. Every
 * request is recorded so tests can assert on what was actually sent.
 * @param {object} handlers Map of path to handler function.
 * @returns {Promise<object>} The server, its base URL and the request log.
 */
async function fakeAyosPush(handlers) {
    const requests = [];

    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            requests.push({
                path: req.url,
                headers: req.headers,
                body,
            });

            const handler = handlers[req.url];
            if (!handler) {
                res.writeHead(404).end("no handler for " + req.url);
                return;
            }
            const { status, body: payload } = handler(body, requests.length);
            res.writeHead(status, { "content-type": "application/json" });
            res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
        });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        server,
        requests,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

/**
 * A login handler that always succeeds.
 * @returns {object} Fake 200 response carrying a token.
 */
const okLogin = () => ({
    status: 200,
    body: { success: true, data: { token: "tok-123", expires_in_seconds: 3600 } },
});

/**
 * A template-send handler that always succeeds.
 * @returns {object} Fake 200 response.
 */
const okSend = () => ({ status: 200, body: { success: true } });

/**
 * Build a notification config pointing at the fake server.
 * @param {string} url Base URL of the fake server.
 * @param {object} extra Fields to override.
 * @returns {object} Notification config.
 */
function config(url, extra = {}) {
    return {
        ayospushApiUrl: url,
        ayospushApiKey: "key-abc",
        ayospushApiSecret: "secret-xyz",
        ayospushPhoneNumberId: "pn-1",
        ayospushTemplateName: "uptime_alert",
        ayospushRecipientNumber: "+24106000000",
        ...extra,
    };
}

describe("AyosPush notification provider", () => {
    let fake;

    beforeEach(() => {
        // The provider caches bearer tokens in a module-level Map. Dropping the
        // module from the require cache gives each test a cold cache, so token
        // reuse can be asserted deliberately rather than leaking between tests.
        delete require.cache[require.resolve("../../../server/notification-providers/ayospush")];
    });

    afterEach(async () => {
        if (fake) {
            await fake.close();
            fake = null;
        }
    });

    test("authenticates, then posts the template with the alert as variable 1", async () => {
        fake = await fakeAyosPush({
            "/auth/login": okLogin,
            "/messages/template": okSend,
        });

        const Provider = require("../../../server/notification-providers/ayospush");
        const result = await new Provider().send(config(fake.url), "Monitor X is down");

        assert.strictEqual(result, "Sent Successfully.");
        assert.strictEqual(fake.requests.length, 2);

        const login = JSON.parse(fake.requests[0].body);
        assert.deepStrictEqual(login, { api_key: "key-abc", api_secret: "secret-xyz" });

        const send = fake.requests[1];
        assert.strictEqual(send.path, "/messages/template");
        assert.match(send.headers.authorization, /^Bearer tok-123$/);
        assert.match(send.headers["content-type"], /multipart\/form-data/);
        assert.match(send.body, /uptime_alert/);
        assert.match(send.body, /Monitor X is down/);
    });

    test("strips the leading + from the recipient number", async () => {
        fake = await fakeAyosPush({ "/auth/login": okLogin, "/messages/template": okSend });

        const Provider = require("../../../server/notification-providers/ayospush");
        await new Provider().send(config(fake.url), "msg");

        const send = fake.requests[1].body;
        assert.match(send, /24106000000/);
        assert.doesNotMatch(send, /\+24106000000/);
    });

    test("treats HTTP 200 with success:false as a failure", async () => {
        fake = await fakeAyosPush({
            "/auth/login": okLogin,
            "/messages/template": () => ({
                status: 200,
                body: { success: false, message: "template not approved" },
            }),
        });

        const Provider = require("../../../server/notification-providers/ayospush");
        await assert.rejects(() => new Provider().send(config(fake.url), "msg"), /template not approved/);
    });

    test("reuses the cached token instead of logging in again", async () => {
        fake = await fakeAyosPush({ "/auth/login": okLogin, "/messages/template": okSend });

        const Provider = require("../../../server/notification-providers/ayospush");
        const provider = new Provider();
        await provider.send(config(fake.url), "first");
        await provider.send(config(fake.url), "second");

        const logins = fake.requests.filter((r) => r.path === "/auth/login");
        assert.strictEqual(logins.length, 1, "should authenticate only once");
        assert.strictEqual(fake.requests.length, 3, "1 login + 2 sends");
    });

    test("re-authenticates once when a cached token is rejected with 401", async () => {
        let sendCount = 0;
        fake = await fakeAyosPush({
            "/auth/login": okLogin,
            "/messages/template": () => {
                sendCount++;
                // First send succeeds, second is rejected as if the token expired,
                // third (after re-auth) succeeds.
                if (sendCount === 2) {
                    return { status: 401, body: { success: false, message: "expired" } };
                }
                return { status: 200, body: { success: true } };
            },
        });

        const Provider = require("../../../server/notification-providers/ayospush");
        const provider = new Provider();
        await provider.send(config(fake.url), "first");
        const result = await provider.send(config(fake.url), "second");

        assert.strictEqual(result, "Sent Successfully.");
        const logins = fake.requests.filter((r) => r.path === "/auth/login");
        assert.strictEqual(logins.length, 2, "should log in again after a 401");
    });

    test("fails clearly when authentication returns no token", async () => {
        fake = await fakeAyosPush({
            "/auth/login": () => ({ status: 200, body: { success: true, data: {} } }),
        });

        const Provider = require("../../../server/notification-providers/ayospush");
        await assert.rejects(() => new Provider().send(config(fake.url), "msg"), /returned no token/);
    });

    test("accepts the flatter token shapes the API also returns", async () => {
        fake = await fakeAyosPush({
            "/auth/login": () => ({ status: 200, body: { access_token: "flat-tok" } }),
            "/messages/template": okSend,
        });

        const Provider = require("../../../server/notification-providers/ayospush");
        await new Provider().send(config(fake.url), "msg");

        assert.match(fake.requests[1].headers.authorization, /^Bearer flat-tok$/);
    });

    test("normalises a trailing slash on the API URL", () => {
        const Provider = require("../../../server/notification-providers/ayospush");
        assert.strictEqual(Provider.normaliseApiUrl("https://example.com/api/v1/"), "https://example.com/api/v1");
        assert.strictEqual(Provider.normaliseApiUrl(""), "https://ayospush.com/api/v1");
        assert.strictEqual(Provider.normaliseApiUrl(undefined), "https://ayospush.com/api/v1");
    });
});
