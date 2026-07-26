let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");
const { escape } = require("html-escaper");
const validator = require("validator");
const dayjs = require("dayjs");
const { log } = require("../../src/util");
const { subscriptionRateLimiter } = require("../rate-limiter");
const { generateToken, sendConfirmationEmail } = require("../status-page-mailer");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug, request);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        for (let monitorID of monitorIDList) {
            let list = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 100
            `,
                [monitorID]
            );

            list = R.convertToBeans("heartbeat", list);
            heartbeatList[monitorID] = list.reverse().map((row) => row.toPublicJSON());

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            heartbeatList,
            uptimeList,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            name: statusPage.title,
            start_url: "/status/" + statusPage.slug,
            display: "standalone",
            icons: [
                {
                    src: statusPage.icon,
                    sizes: "128x128",
                    type: "image/png",
                },
            ],
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/status-page/:slug/incident-history", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let slug = request.params.slug;
        slug = slug.toLowerCase();
        let statusPageID = await StatusPage.slugToID(slug);

        if (!statusPageID) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const cursor = request.query.cursor || null;
        const result = await StatusPage.getIncidentHistory(statusPageID, cursor, true);
        response.json({
            ok: true,
            ...result,
        });
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle,
    } = request.query;

    try {
        let monitorIDList = await R.getCol(
            `
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `,
            [statusPageID]
        );

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(
                `
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `,
                [monitorID]
            );

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }
        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * Render a small standalone page for the confirm/unsubscribe links, which are
 * opened straight from an email client rather than inside the SPA.
 * @param {object} response Express response.
 * @param {string} title Heading.
 * @param {string} message Body text.
 * @param {string} slug Status page slug to link back to.
 * @returns {void}
 */
function sendSubscriptionPage(response, title, message, slug) {
    const safe = (text) => escape(String(text ?? ""));
    response.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(title)}</title></head>
<body style="margin:0;padding:40px 20px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:32px;text-align:center">
    <h1 style="margin:0 0 12px;font-size:20px">${safe(title)}</h1>
    <p style="margin:0 0 24px;color:#4b5563">${safe(message)}</p>
    <a href="/status/${encodeURIComponent(slug)}" style="display:inline-block;background:#5cdd8b;color:#0b2a17;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Back to status page</a>
  </div>
</body></html>`);
}

// Public subscription endpoint. Creates an unconfirmed subscriber and emails a
// confirmation link; nothing is delivered until that link is opened.
router.post("/api/status-page/:slug/subscribe", async (request, response) => {
    allowDevAllOrigin(response);

    try {
        if (!(await subscriptionRateLimiter.pass(null, 0))) {
            response.status(429).json({ ok: false, msg: "Too many subscription requests, try again later." });
            return;
        }
        await subscriptionRateLimiter.removeTokens(1);

        const slug = String(request.params.slug ?? "").toLowerCase();
        const statusPage = await R.findOne("status_page", " slug = ? ", [slug]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }
        if (!statusPage.subscription_enabled) {
            response.status(403).json({ ok: false, msg: "Subscriptions are not enabled for this status page." });
            return;
        }

        const email = String(request.body?.email ?? "")
            .trim()
            .toLowerCase();
        if (!validator.isEmail(email)) {
            response.status(400).json({ ok: false, msg: "Please enter a valid email address." });
            return;
        }

        let subscriber = await R.findOne("status_page_subscriber", " status_page_id = ? AND email = ? ", [
            statusPage.id,
            email,
        ]);

        // Answer identically whether or not the address is already subscribed,
        // so this endpoint cannot be used to test who is on the list.
        const genericReply = {
            ok: true,
            msg: "Check your inbox for a confirmation link.",
        };

        if (subscriber && subscriber.confirmed) {
            response.json(genericReply);
            return;
        }

        if (!subscriber) {
            subscriber = R.dispense("status_page_subscriber");
            subscriber.status_page_id = statusPage.id;
            subscriber.email = email;
            subscriber.unsubscribe_token = generateToken();
        }
        subscriber.confirmed = false;
        subscriber.confirm_token = generateToken();
        await R.store(subscriber);

        try {
            await sendConfirmationEmail(statusPage, subscriber);
        } catch (e) {
            log.warn("status-page-mail", `Could not send confirmation to ${email}: ${e.message}`);
            response.status(500).json({ ok: false, msg: "Could not send the confirmation email." });
            return;
        }

        response.json(genericReply);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Opened from the confirmation email.
router.get("/status/:slug/subscribe/confirm/:token", async (request, response) => {
    try {
        const slug = String(request.params.slug ?? "").toLowerCase();
        const subscriber = await R.findOne("status_page_subscriber", " confirm_token = ? ", [request.params.token]);

        if (!subscriber) {
            sendSubscriptionPage(
                response,
                "Link no longer valid",
                "This confirmation link has already been used or has expired.",
                slug
            );
            return;
        }

        subscriber.confirmed = true;
        subscriber.confirm_token = null;
        subscriber.confirmed_date = R.isoDateTime(dayjs.utc());
        await R.store(subscriber);

        sendSubscriptionPage(
            response,
            "Subscription confirmed",
            "You will now receive status updates by email. Every message includes an unsubscribe link.",
            slug
        );
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// One-click unsubscribe, linked from every notification.
router.get("/status/:slug/subscribe/unsubscribe/:token", async (request, response) => {
    try {
        const slug = String(request.params.slug ?? "").toLowerCase();
        const subscriber = await R.findOne("status_page_subscriber", " unsubscribe_token = ? ", [request.params.token]);

        if (subscriber) {
            await R.trash(subscriber);
        }

        // Same wording either way: an already-removed address should not be
        // distinguishable from one removed just now.
        sendSubscriptionPage(
            response,
            "Unsubscribed",
            "You will no longer receive status updates for this page.",
            slug
        );
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
