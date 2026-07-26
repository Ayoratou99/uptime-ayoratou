const { BeanModel } = require("redbean-node/dist/bean-model");
const { R } = require("redbean-node");
const dayjs = require("dayjs");

/**
 * Lifecycle of an incident, in the order operators normally move through it.
 * Mirrors the vocabulary readers already recognise from other status pages.
 */
const INCIDENT_STATUS = {
    INVESTIGATING: "investigating",
    IDENTIFIED: "identified",
    MONITORING: "monitoring",
    RESOLVED: "resolved",
};

const INCIDENT_STATUS_LIST = Object.values(INCIDENT_STATUS);

class Incident extends BeanModel {
    /**
     * Resolve the incident and mark it as inactive
     * @returns {Promise<void>}
     */
    async resolve() {
        this.active = false;
        this.pin = false;
        this.status = INCIDENT_STATUS.RESOLVED;
        this.last_updated_date = R.isoDateTime(dayjs.utc());
        await R.store(this);
    }

    /**
     * Append an entry to this incident's timeline and move it to that status.
     *
     * This is what makes an update non-destructive: the previous text stays as
     * its own row instead of being overwritten.
     * @param {string} status One of {@link INCIDENT_STATUS_LIST}.
     * @param {string} content Description of the update.
     * @param {number|null} userID Author, or null if unknown.
     * @returns {Promise<Bean>} The stored update bean.
     * @throws {Error} If the status or content is invalid.
     */
    async addUpdate(status, content, userID = null) {
        if (!INCIDENT_STATUS_LIST.includes(status)) {
            throw new Error("Invalid incident status");
        }
        if (!content || String(content).trim() === "") {
            throw new Error("Please input content");
        }

        const now = R.isoDateTime(dayjs.utc());

        const update = R.dispense("incident_update");
        update.incident_id = this.id;
        update.status = status;
        update.content = String(content).trim();
        update.created_date = now;
        update.created_by = userID;
        await R.store(update);

        // The incident itself carries the latest state, so the status page can
        // show a current summary without walking the whole timeline.
        this.status = status;
        this.content = update.content;
        this.last_updated_date = now;
        if (status === INCIDENT_STATUS.RESOLVED) {
            this.active = false;
            this.pin = false;
        }
        await R.store(this);

        return update;
    }

    /**
     * Load the timeline for a set of incidents in one query.
     * @param {number[]} incidentIDs Incident IDs.
     * @returns {Promise<Map<number, object[]>>} Updates keyed by incident id, newest first.
     */
    static async getUpdatesFor(incidentIDs) {
        const result = new Map();
        if (!incidentIDs.length) {
            return result;
        }

        const placeholders = incidentIDs.map(() => "?").join(",");
        const rows = await R.getAll(
            `SELECT incident_update.id,
                    incident_update.incident_id,
                    incident_update.status,
                    incident_update.content,
                    incident_update.created_date,
                    \`user\`.username AS author_username,
                    \`user\`.display_name AS author_display_name
             FROM incident_update
             LEFT JOIN \`user\` ON \`user\`.id = incident_update.created_by
             WHERE incident_update.incident_id IN (${placeholders})
             ORDER BY incident_update.created_date DESC, incident_update.id DESC`,
            incidentIDs
        );

        for (const row of rows) {
            if (!result.has(row.incident_id)) {
                result.set(row.incident_id, []);
            }
            result.get(row.incident_id).push({
                id: row.id,
                status: row.status,
                content: row.content,
                createdDate: row.created_date,
                // Null for public viewers of an update whose author was deleted.
                author: row.author_display_name || row.author_username || null,
            });
        }

        return result;
    }

    /**
     * Return an object that ready to parse to JSON for public
     * @param {object[]|null} updates Timeline entries, newest first.
     * @returns {object} Object ready to parse
     */
    toPublicJSON(updates = null) {
        return {
            id: this.id,
            style: this.style,
            title: this.title,
            content: this.content,
            status: this.status || INCIDENT_STATUS.INVESTIGATING,
            pin: !!this.pin,
            active: !!this.active,
            createdDate: this.created_date,
            lastUpdatedDate: this.last_updated_date,
            status_page_id: this.status_page_id,
            updates: updates ?? [],
        };
    }
}

module.exports = Incident;
module.exports.INCIDENT_STATUS = INCIDENT_STATUS;
module.exports.INCIDENT_STATUS_LIST = INCIDENT_STATUS_LIST;
