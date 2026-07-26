const { MonitorType } = require("./monitor-type");
const { ConditionVariable } = require("../monitor-conditions/variables");
const { defaultStringOperators, defaultNumberOperators } = require("../monitor-conditions/operators");

/**
 * Condition support for the HTTP-family monitor types.
 *
 * These types (http, keyword, json-query) are checked inline in
 * Monitor.beat() rather than through MonitorType.check(), because their
 * request handling is deeply entangled with retries, TLS info and proxying.
 * This class exists so they can still advertise `supportsConditions` and a
 * variable list to the monitor edit form through the normal plumbing.
 *
 * See Monitor.buildHttpConditionContext() for where the values come from, and
 * Monitor.beat() for where the conditions are evaluated.
 */
class HttpMonitorType extends MonitorType {
    name = "http";

    supportsConditions = true;

    conditionVariables = [
        new ConditionVariable("status_code", defaultNumberOperators),
        new ConditionVariable("response_time", defaultNumberOperators),
        new ConditionVariable("content_type", defaultStringOperators),
        new ConditionVariable("body", defaultStringOperators),
        new ConditionVariable("body_size", defaultNumberOperators),
        new ConditionVariable("body_is_json", defaultStringOperators),
    ];

    /**
     * Never called: Monitor.beat() handles these types inline before reaching
     * the MonitorType dispatch.
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        throw new Error(
            "HTTP monitors are checked inline in Monitor.beat(); HttpMonitorType only declares condition support."
        );
    }
}

/** Keyword monitors take the same request path, so they get the same variables. */
class KeywordMonitorType extends HttpMonitorType {
    name = "keyword";
}

/** JSON-query monitors take the same request path, so they get the same variables. */
class JsonQueryMonitorType extends HttpMonitorType {
    name = "json-query";
}

module.exports = {
    HttpMonitorType,
    KeywordMonitorType,
    JsonQueryMonitorType,
};
