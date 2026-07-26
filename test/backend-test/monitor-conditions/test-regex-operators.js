const { describe, test } = require("node:test");
const assert = require("node:assert");

const { operatorMap, OP_REGEX, OP_NOT_REGEX } = require("../../../server/monitor-conditions/operators.js");

describe("Regex condition operators", () => {
    const regex = operatorMap.get(OP_REGEX);
    const notRegex = operatorMap.get(OP_NOT_REGEX);

    test("matches a bare pattern", () => {
        assert.strictEqual(regex.test("order-12345-ok", "order-\\d+"), true);
        assert.strictEqual(regex.test("no digits here", "order-\\d+"), false);
    });

    test("supports the /pattern/flags form", () => {
        assert.strictEqual(regex.test("ORDER-99", "/order-\\d+/i"), true);
        // Without the flag the same pattern is case sensitive.
        assert.strictEqual(regex.test("ORDER-99", "order-\\d+"), false);
    });

    test("matches across lines only with the s flag", () => {
        assert.strictEqual(regex.test("first\nsecond", "/first.second/s"), true);
        assert.strictEqual(regex.test("first\nsecond", "first.second"), false);
    });

    test("searches anywhere in the value, not just the start", () => {
        assert.strictEqual(regex.test('{"status":"healthy"}', '"status":"healthy"'), true);
    });

    test("negated operator inverts the result", () => {
        assert.strictEqual(notRegex.test("no digits here", "order-\\d+"), true);
        assert.strictEqual(notRegex.test("order-1", "order-\\d+"), false);
    });

    test("coerces non-string values rather than throwing", () => {
        assert.strictEqual(regex.test(404, "^4\\d\\d$"), true);
        assert.strictEqual(regex.test(null, "^$"), true);
        assert.strictEqual(regex.test(undefined, "^$"), true);
    });

    test("an invalid pattern reports itself clearly instead of leaking a SyntaxError", () => {
        assert.throws(() => regex.test("anything", "[unclosed"), /Invalid regular expression "\[unclosed"/);
        assert.throws(() => notRegex.test("anything", "*bad"), /Invalid regular expression "\*bad"/);
    });

    test("a literal pattern containing slashes is not mistaken for the delimited form", () => {
        assert.strictEqual(regex.test("path /a/b here", "/a/b"), true);
    });
});
