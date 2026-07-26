/*
 * Outbound email for public status page subscriptions.
 *
 * This is deliberately separate from the notification providers: those are
 * configured per monitor by an operator, whereas this is a single
 * instance-wide SMTP account used to mail members of the public who have
 * confirmed a subscription.
 */
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { Settings } = require("./settings");
const { escape } = require("html-escaper");

/** Settings group holding the SMTP configuration. */
const SETTINGS_TYPE = "statusPageSmtp";

/**
 * Read the SMTP configuration.
 * @returns {Promise<object>} Settings object, possibly empty.
 */
async function getSmtpConfig() {
    return (await Settings.getSettings(SETTINGS_TYPE)) ?? {};
}

/**
 * Whether enough SMTP settings are present to attempt a send.
 * @param {object} config SMTP settings.
 * @returns {boolean} True if configured.
 */
function isConfigured(config) {
    return !!(config && config.host && config.port && config.fromAddress);
}

/**
 * Build a nodemailer transport from the stored settings.
 * @param {object} config SMTP settings.
 * @returns {import("nodemailer").Transporter} Transport.
 * @throws {Error} If the settings are incomplete.
 */
function createTransport(config) {
    if (!isConfigured(config)) {
        throw new Error("Status page SMTP is not configured");
    }

    return nodemailer.createTransport({
        host: config.host,
        port: Number(config.port),
        secure: !!config.secure,
        // Only pass auth when a username is set; many relays are open on the
        // local network and reject an empty credential pair.
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
        tls: config.ignoreTLSError ? { rejectUnauthorized: false } : undefined,
    });
}

/**
 * Generate a URL-safe token for confirm/unsubscribe links.
 * @returns {string} Random token.
 */
function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

/**
 * Send one message through the configured SMTP account.
 * @param {object} options Recipient, subject and bodies.
 * @param {string} options.to Recipient address.
 * @param {string} options.subject Subject line.
 * @param {string} options.text Plain-text body.
 * @param {string} options.html HTML body.
 * @returns {Promise<void>}
 * @throws {Error} If SMTP is unconfigured or the send fails.
 */
async function sendMail({ to, subject, text, html }) {
    const config = await getSmtpConfig();
    const transport = createTransport(config);

    await transport.sendMail({
        from: config.fromName ? `"${config.fromName}" <${config.fromAddress}>` : config.fromAddress,
        to,
        subject,
        text,
        html,
    });
}

/**
 * Absolute base URL for links in outgoing mail.
 *
 * Falls back to the primary base URL setting; without one the links would be
 * relative and useless in an email client.
 * @returns {Promise<string>} Base URL without a trailing slash.
 */
async function getBaseURL() {
    const primary = await Settings.get("primaryBaseURL");
    const base = primary || "";
    return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * Wrap body content in a minimal HTML email shell.
 * @param {string} title Heading.
 * @param {string} bodyHTML Pre-escaped body markup.
 * @param {string} footerHTML Pre-escaped footer markup.
 * @returns {string} Complete HTML document.
 */
function layout(title, bodyHTML, footerHTML = "") {
    return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2328">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:10px;padding:28px;border:1px solid #e5e7eb">
    <h1 style="margin:0 0 16px;font-size:20px">${title}</h1>
    ${bodyHTML}
  </div>
  <div style="max-width:560px;margin:16px auto 0;font-size:12px;color:#6b7280;text-align:center">${footerHTML}</div>
</body></html>`;
}

/**
 * Send the double opt-in confirmation message.
 * @param {Bean} statusPage Status page being subscribed to.
 * @param {Bean} subscriber Subscriber row holding the confirm token.
 * @returns {Promise<void>}
 */
async function sendConfirmationEmail(statusPage, subscriber) {
    const base = await getBaseURL();
    const link = `${base}/status/${encodeURIComponent(statusPage.slug)}/subscribe/confirm/${subscriber.confirm_token}`;
    const title = escape(statusPage.title || statusPage.slug);

    await sendMail({
        to: subscriber.email,
        subject: `Confirm your subscription to ${statusPage.title || statusPage.slug}`,
        text:
            `Confirm your subscription to ${statusPage.title || statusPage.slug} status updates by opening this link:\n\n` +
            `${link}\n\n` +
            `If you did not request this, ignore this email and nothing further will be sent.`,
        html: layout(
            `Confirm your subscription`,
            `<p style="margin:0 0 20px">Confirm that you want status updates for <strong>${title}</strong>.</p>
             <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#5cdd8b;color:#0b2a17;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Confirm subscription</a></p>
             <p style="margin:0;font-size:13px;color:#6b7280">If you did not request this, ignore this email and nothing further will be sent.</p>`
        ),
    });
}

/**
 * Send a message to every confirmed subscriber of a status page.
 *
 * Failures are logged per recipient rather than aborting the run, so one bad
 * address cannot stop everyone else being told about an outage. Sends are
 * sequential to stay within typical SMTP concurrency limits.
 * @param {number} statusPageID Status page whose subscribers to notify.
 * @param {Function} build Builds {subject, text, html} for a subscriber.
 * @returns {Promise<{sent: number, failed: number}>} Delivery tally.
 */
async function sendToSubscribers(statusPageID, build) {
    const config = await getSmtpConfig();
    if (!isConfigured(config)) {
        log.debug("status-page-mail", "SMTP not configured, skipping subscriber notification");
        return { sent: 0, failed: 0 };
    }

    const statusPage = await R.findOne("status_page", " id = ? ", [statusPageID]);
    if (!statusPage || !statusPage.subscription_enabled) {
        return { sent: 0, failed: 0 };
    }

    const subscribers = await R.find("status_page_subscriber", " status_page_id = ? AND confirmed = 1 ", [
        statusPageID,
    ]);
    if (!subscribers.length) {
        return { sent: 0, failed: 0 };
    }

    const base = await getBaseURL();
    let sent = 0;
    let failed = 0;

    for (const subscriber of subscribers) {
        const unsubscribeLink = `${base}/status/${encodeURIComponent(statusPage.slug)}/subscribe/unsubscribe/${subscriber.unsubscribe_token}`;
        try {
            const message = build(subscriber, unsubscribeLink);
            await sendMail({ to: subscriber.email, ...message });
            sent++;
        } catch (e) {
            failed++;
            log.warn("status-page-mail", `Failed to notify ${subscriber.email}: ${e.message}`);
        }
    }

    log.info("status-page-mail", `Notified subscribers of status page ${statusPageID}: ${sent} sent, ${failed} failed`);
    return { sent, failed };
}

/**
 * Notify subscribers about an incident being posted or updated.
 * @param {number} statusPageID Status page id.
 * @param {object} incident Incident public JSON.
 * @param {object|null} update The timeline entry that triggered this, if any.
 * @returns {Promise<{sent: number, failed: number}>} Delivery tally.
 */
async function notifyIncident(statusPageID, incident, update = null) {
    const statusLabel = (update?.status ?? incident.status ?? "investigating").toUpperCase();
    const body = update?.content ?? incident.content ?? "";

    return await sendToSubscribers(statusPageID, (subscriber, unsubscribeLink) => ({
        subject: `[${statusLabel}] ${incident.title}`,
        text: `${incident.title}\n\n${statusLabel}\n${body}\n\nUnsubscribe: ${unsubscribeLink}`,
        html: layout(
            escape(incident.title),
            `<p style="margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.5px;color:#6b7280">${escape(statusLabel)}</p>
             <p style="margin:0;white-space:pre-wrap">${escape(body)}</p>`,
            `<a href="${unsubscribeLink}" style="color:#6b7280">Unsubscribe</a>`
        ),
    }));
}

/**
 * Notify subscribers that a monitor on the page changed state.
 * @param {number} statusPageID Status page id.
 * @param {string} monitorName Monitor display name.
 * @param {boolean} isUp Whether the monitor is now up.
 * @param {string} message Heartbeat message.
 * @returns {Promise<{sent: number, failed: number}>} Delivery tally.
 */
async function notifyMonitorStatus(statusPageID, monitorName, isUp, message) {
    const state = isUp ? "UP" : "DOWN";

    return await sendToSubscribers(statusPageID, (subscriber, unsubscribeLink) => ({
        subject: `[${state}] ${monitorName}`,
        text: `${monitorName} is ${state}.\n\n${message}\n\nUnsubscribe: ${unsubscribeLink}`,
        html: layout(
            `${escape(monitorName)} is ${state}`,
            `<p style="margin:0;white-space:pre-wrap">${escape(message ?? "")}</p>`,
            `<a href="${unsubscribeLink}" style="color:#6b7280">Unsubscribe</a>`
        ),
    }));
}

/**
 * Status pages that publish a given monitor and have subscriptions enabled.
 *
 * Monitors reach a status page through `monitor_group` -> `group`, so a
 * monitor may appear on several pages or none.
 * @param {number} monitorID Monitor id.
 * @returns {Promise<number[]>} Status page ids.
 */
async function getSubscribedStatusPageIDs(monitorID) {
    const rows = await R.getAll(
        `SELECT DISTINCT \`group\`.status_page_id AS id
         FROM monitor_group
         JOIN \`group\` ON \`group\`.id = monitor_group.group_id
         JOIN status_page ON status_page.id = \`group\`.status_page_id
         WHERE monitor_group.monitor_id = ?
           AND status_page.subscription_enabled = 1`,
        [monitorID]
    );
    return rows.map((row) => row.id);
}

/**
 * Tell subscribers of every status page publishing this monitor that it
 * changed state.
 *
 * Called from the heartbeat loop, so it must never throw: a mail failure must
 * not interrupt monitoring.
 * @param {object} monitor Monitor bean.
 * @param {boolean} isUp Whether the monitor is now up.
 * @param {string} message Heartbeat message.
 * @returns {Promise<void>}
 */
async function notifyMonitorChange(monitor, isUp, message) {
    try {
        const config = await getSmtpConfig();
        if (!isConfigured(config)) {
            return;
        }

        const statusPageIDs = await getSubscribedStatusPageIDs(monitor.id);
        for (const statusPageID of statusPageIDs) {
            await notifyMonitorStatus(statusPageID, monitor.name, isUp, message);
        }
    } catch (e) {
        log.warn("status-page-mail", `Could not notify subscribers about ${monitor.name}: ${e.message}`);
    }
}

module.exports = {
    SETTINGS_TYPE,
    getSubscribedStatusPageIDs,
    notifyMonitorChange,
    getSmtpConfig,
    isConfigured,
    createTransport,
    generateToken,
    sendMail,
    getBaseURL,
    sendConfirmationEmail,
    sendToSubscribers,
    notifyIncident,
    notifyMonitorStatus,
};
