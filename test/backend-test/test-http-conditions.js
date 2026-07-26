const { describe, test } = require("node:test");
const assert = require("node:assert");

const Monitor = require("../../server/model/monitor");
const { HttpMonitorType } = require("../../server/monitor-types/http");

/**
 * Build a fake axios response.
 * @param {object} options Overrides for the response.
 * @param {number} options.status HTTP status code.
 * @param {any} options.data Response body, string or already-parsed object.
 * @param {string} options.contentType Value of the content-type header.
 * @returns {object} Response-like object.
 */
function response({ status = 200, data = "", contentType = "text/html" } = {}) {
    return {
        status,
        data,
        headers: { "content-type": contentType },
    };
}

/**
 * Build a monitor-like object carrying a serialised condition group.
 *
 * Mirrors what ConditionExpressionGroup.fromMonitor reads off a monitor bean.
 * @param {Array} conditions Condition expressions.
 * @returns {object} Monitor stub with checkHttpConditions bound.
 */
function monitorWithConditions(conditions) {
    const stub = { conditions: JSON.stringify(conditions) };
    stub.checkHttpConditions = Monitor.prototype.checkHttpConditions.bind(stub);
    return stub;
}

describe("HTTP condition context", () => {
    test("exposes a value for every variable the monitor type declares", () => {
        const context = Monitor.buildHttpConditionContext(response({ data: "hello" }), 42);
        const declared = new HttpMonitorType().conditionVariables.map((v) => v.id);

        for (const id of declared) {
            assert.ok(id in context, `context is missing declared variable "${id}"`);
        }
    });

    test("captures status, timing, content type and size", () => {
        const context = Monitor.buildHttpConditionContext(
            response({ status: 503, data: "abc", contentType: "text/plain" }),
            1234
        );

        assert.strictEqual(context.status_code, 503);
        assert.strictEqual(context.response_time, 1234);
        assert.strictEqual(context.content_type, "text/plain");
        assert.strictEqual(context.body_size, 3);
    });

    test("measures size in bytes, not characters", () => {
        // "é" is two bytes in UTF-8.
        const context = Monitor.buildHttpConditionContext(response({ data: "é" }), 1);
        assert.strictEqual(context.body_size, 2);
    });

    test("serialises an object body that axios already parsed", () => {
        const context = Monitor.buildHttpConditionContext(
            response({ data: { status: "healthy" }, contentType: "application/json" }),
            1
        );

        assert.strictEqual(context.body, '{"status":"healthy"}');
        assert.strictEqual(context.body_is_json, "true");
    });

    test("detects JSON served as text", () => {
        const context = Monitor.buildHttpConditionContext(response({ data: '{"a":1}' }), 1);
        assert.strictEqual(context.body_is_json, "true");
    });

    test("marks a non-JSON body as such", () => {
        const context = Monitor.buildHttpConditionContext(response({ data: "<html>hi</html>" }), 1);
        assert.strictEqual(context.body_is_json, "false");
    });

    test("a missing content-type header does not blow up", () => {
        const res = { status: 200, data: "x", headers: {} };
        assert.strictEqual(Monitor.buildHttpConditionContext(res, 1).content_type, "");
    });
});

describe("HTTP condition evaluation", () => {
    test("a monitor with no conditions is unaffected", () => {
        const monitor = monitorWithConditions([]);
        assert.doesNotThrow(() => monitor.checkHttpConditions(response(), 10));
    });

    test("passes when the body contains the expected text", () => {
        const monitor = monitorWithConditions([
            { type: "expression", andOr: "and", variable: "body", operator: "contains", value: "Welcome" },
        ]);
        assert.doesNotThrow(() => monitor.checkHttpConditions(response({ data: "<h1>Welcome</h1>" }), 10));
    });

    test("fails when the body does not contain the expected text", () => {
        const monitor = monitorWithConditions([
            { type: "expression", andOr: "and", variable: "body", operator: "contains", value: "Welcome" },
        ]);
        assert.throws(
            () => monitor.checkHttpConditions(response({ data: "<h1>Error</h1>" }), 10),
            /did not meet the configured conditions/
        );
    });

    test("can require the response to be JSON", () => {
        const conditions = [
            { type: "expression", andOr: "and", variable: "body_is_json", operator: "equals", value: "true" },
        ];

        assert.doesNotThrow(() =>
            monitorWithConditions(conditions).checkHttpConditions(
                response({ data: { ok: true }, contentType: "application/json" }),
                10
            )
        );
        assert.throws(
            () => monitorWithConditions(conditions).checkHttpConditions(response({ data: "<html/>" }), 10),
            /did not meet the configured conditions/
        );
    });

    test("can require a JSON content type", () => {
        const conditions = [
            {
                type: "expression",
                andOr: "and",
                variable: "content_type",
                operator: "contains",
                value: "application/json",
            },
        ];

        assert.doesNotThrow(() =>
            monitorWithConditions(conditions).checkHttpConditions(
                response({ contentType: "application/json; charset=utf-8" }),
                10
            )
        );
        assert.throws(() =>
            monitorWithConditions(conditions).checkHttpConditions(response({ contentType: "text/html" }), 10)
        );
    });

    test("combines conditions with AND", () => {
        const conditions = [
            { type: "expression", andOr: "and", variable: "status_code", operator: "num_equals", value: "200" },
            { type: "expression", andOr: "and", variable: "response_time", operator: "lt", value: "500" },
        ];

        assert.doesNotThrow(() => monitorWithConditions(conditions).checkHttpConditions(response(), 120));
        // Same status, but too slow.
        assert.throws(() => monitorWithConditions(conditions).checkHttpConditions(response(), 900));
    });

    test("combines conditions with OR", () => {
        const conditions = [
            { type: "expression", andOr: "and", variable: "status_code", operator: "num_equals", value: "200" },
            { type: "expression", andOr: "or", variable: "status_code", operator: "num_equals", value: "204" },
        ];

        assert.doesNotThrow(() => monitorWithConditions(conditions).checkHttpConditions(response({ status: 204 }), 10));
        assert.throws(() => monitorWithConditions(conditions).checkHttpConditions(response({ status: 500 }), 10));
    });

    test("matches a body against a regular expression", () => {
        const conditions = [
            { type: "expression", andOr: "and", variable: "body", operator: "regex", value: "order-\\d{4,}" },
        ];

        assert.doesNotThrow(() =>
            monitorWithConditions(conditions).checkHttpConditions(response({ data: "ref order-12345 ok" }), 10)
        );
        assert.throws(() =>
            monitorWithConditions(conditions).checkHttpConditions(response({ data: "ref order-12 ok" }), 10)
        );
    });

    test("an unreadable conditions column is ignored rather than failing the check", () => {
        for (const broken of [null, undefined, "", "not json", "{"]) {
            const stub = { name: "test", conditions: broken };
            stub.checkHttpConditions = Monitor.prototype.checkHttpConditions.bind(stub);
            assert.doesNotThrow(
                () => stub.checkHttpConditions(response(), 10),
                `conditions value ${JSON.stringify(broken)} should not fail the beat`
            );
        }
    });

    test("the failure message reports the observed values", () => {
        const monitor = monitorWithConditions([
            { type: "expression", andOr: "and", variable: "status_code", operator: "num_equals", value: "200" },
        ]);

        assert.throws(
            () => monitor.checkHttpConditions(response({ status: 500, data: "err" }), 77),
            (err) => {
                assert.match(err.message, /status 500/);
                assert.match(err.message, /77ms/);
                assert.match(err.message, /3 bytes/);
                return true;
            }
        );
    });
});
