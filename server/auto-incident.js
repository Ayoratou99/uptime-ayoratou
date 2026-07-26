/*
 * Automatic incidents for sustained downtime.
 *
 * A monitor configured with `auto_incident_minutes` posts an incident on every
 * status page that publishes it once it has been continuously down for that
 * long. The delay exists so a brief blip does not put a notice in front of the
 * public; only an outage that persists is worth announcing.
 *
 * Posting is the only thing automated. An incident is never closed or updated
 * by the system: a monitor coming back tells you the check passes again, not
 * that the underlying problem is understood or that the public has been given
 * an explanation. Updating and resolving stay with whoever is handling it.
 */
const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { log, DOWN } = require("../src/util");
const { INCIDENT_STATUS } = require("./model/incident");
const apicache = require("./modules/apicache");
const statusPageMailer = require("./status-page-mailer");

/**
 * Status pages that publish a monitor, whether or not they take subscriptions.
 * @param {number} monitorID Monitor id.
 * @returns {Promise<number[]>} Status page ids.
 */
async function getStatusPageIDsForMonitor(monitorID) {
    const rows = await R.getAll(
        `SELECT DISTINCT \`group\`.status_page_id AS id
         FROM monitor_group
         JOIN \`group\` ON \`group\`.id = monitor_group.group_id
         WHERE monitor_group.monitor_id = ?`,
        [monitorID]
    );
    return rows.map((row) => row.id);
}

/**
 * How long the monitor has been continuously down, in minutes.
 *
 * Measured from the heartbeat that first reported the current outage -- the
 * most recent "important" beat, which is written whenever the status changes.
 * @param {number} monitorID Monitor id.
 * @returns {Promise<number|null>} Minutes down, or null if not currently down.
 */
async function getDowntimeMinutes(monitorID) {
    const row = await R.getRow(
        `SELECT time, status FROM heartbeat
         WHERE monitor_id = ? AND important = 1
         ORDER BY time DESC LIMIT 1`,
        [monitorID]
    );

    if (!row || row.status !== DOWN) {
        return null;
    }

    return dayjs.utc().diff(dayjs.utc(row.time), "minute");
}

/**
 * The open auto-incident for a monitor on a given status page, if any.
 * @param {number} monitorID Monitor id.
 * @param {number} statusPageID Status page id.
 * @returns {Promise<Bean|null>} Incident bean or null.
 */
async function findOpenAutoIncident(monitorID, statusPageID) {
    return await R.findOne("incident", " auto_monitor_id = ? AND status_page_id = ? AND active = 1 ", [
        monitorID,
        statusPageID,
    ]);
}

/**
 * Open an incident for a monitor that has been down long enough.
 * @param {object} monitor Monitor bean.
 * @param {number} statusPageID Status page to post on.
 * @param {number} minutesDown How long it has been down.
 * @returns {Promise<void>}
 */
async function openIncident(monitor, statusPageID, minutesDown) {
    const now = R.isoDateTime(dayjs.utc());
    const content = `${monitor.name} has been unreachable for ${minutesDown} minutes. We are investigating.`;

    const incident = R.dispense("incident");
    incident.title = `${monitor.name} is down`;
    incident.content = content;
    incident.style = "danger";
    incident.pin = true;
    incident.active = true;
    incident.status = INCIDENT_STATUS.INVESTIGATING;
    incident.status_page_id = statusPageID;
    incident.auto_monitor_id = monitor.id;
    incident.created_date = now;
    await R.store(incident);

    const update = R.dispense("incident_update");
    update.incident_id = incident.id;
    update.status = INCIDENT_STATUS.INVESTIGATING;
    update.content = content;
    update.created_date = now;
    // No created_by: this was not posted by a person.
    update.created_by = null;
    await R.store(update);

    log.info(
        "auto-incident",
        `Opened incident ${incident.id} for monitor ${monitor.id} on status page ${statusPageID}`
    );

    statusPageMailer
        .notifyIncident(statusPageID, incident.toPublicJSON())
        .catch((e) => log.warn("auto-incident", e.message));
}

/**
 * Post an incident if this monitor has now been down long enough.
 *
 * Recovery is deliberately not handled here. Nothing the system observes tells
 * it the incident is over in any sense the public cares about, so an open
 * incident stays open until someone updates or resolves it by hand.
 *
 * Called from the beat loop, so it must never throw: an incident bookkeeping
 * failure must not interrupt monitoring.
 * @param {object} monitor Monitor bean.
 * @param {boolean} isDown Whether the latest beat was down.
 * @returns {Promise<void>}
 */
async function handleHeartbeat(monitor, isDown) {
    try {
        if (!isDown) {
            return;
        }

        const threshold = Number(monitor.auto_incident_minutes) || 0;
        if (threshold <= 0) {
            return;
        }

        const statusPageIDs = await getStatusPageIDsForMonitor(monitor.id);
        if (!statusPageIDs.length) {
            return;
        }

        const minutesDown = await getDowntimeMinutes(monitor.id);
        if (minutesDown === null || minutesDown < threshold) {
            return;
        }

        let opened = false;
        for (const statusPageID of statusPageIDs) {
            // One open incident per monitor per page, however many beats fail.
            // Because nothing auto-resolves, this also means a monitor that
            // flaps repeatedly cannot bury the page in duplicate notices: the
            // existing incident is reused until someone closes it.
            if (await findOpenAutoIncident(monitor.id, statusPageID)) {
                continue;
            }
            await openIncident(monitor, statusPageID, minutesDown);
            opened = true;
        }

        if (opened) {
            apicache.clear();
        }
    } catch (e) {
        log.warn("auto-incident", `Could not post incident for monitor ${monitor?.id}: ${e.message}`);
    }
}

module.exports = {
    getStatusPageIDsForMonitor,
    getDowntimeMinutes,
    findOpenAutoIncident,
    handleHeartbeat,
};
