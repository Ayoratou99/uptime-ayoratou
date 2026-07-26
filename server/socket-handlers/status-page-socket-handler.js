const { R } = require("redbean-node");
const dayjs = require("dayjs");
const { log } = require("../../src/util");
const ImageDataURI = require("../image-data-uri");
const Database = require("../database");
const apicache = require("../modules/apicache");
const StatusPage = require("../model/status_page");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { Settings } = require("../settings");
const { PERMISSIONS } = require("../permissions");
const { requirePermission, requireActOn } = require("../socket-permissions");
const Incident = require("../model/incident");
const { INCIDENT_STATUS, INCIDENT_STATUS_LIST } = require("../model/incident");
const statusPageMailer = require("../status-page-mailer");

/**
 * Resolve a status page the socket's user is allowed to modify.
 *
 * Incidents, groups and page settings all live under a status page, so every
 * write to any of them is authorised against the page's owner.
 * @param {Socket} socket Socket.io instance
 * @param {string} slug Status page slug
 * @param {string} ownPermission Permission covering pages the user owns
 * @param {string} allPermission Permission covering pages owned by anyone
 * @returns {Promise<Bean>} The status page bean
 * @throws {Error} If the page does not exist or the action is not allowed
 */
async function getEditableStatusPage(
    socket,
    slug,
    ownPermission = PERMISSIONS.STATUSPAGE_EDIT_OWN,
    allPermission = PERMISSIONS.STATUSPAGE_EDIT_ALL
) {
    const statusPage = await R.findOne("status_page", " slug = ? ", [slug]);
    if (!statusPage) {
        throw new Error("slug is not found");
    }
    await requireActOn(socket, ownPermission, allPermission, statusPage.user_id);
    return statusPage;
}

/**
 * Validates incident data
 * @param {object} incident - The incident object
 * @returns {void}
 * @throws {Error} If validation fails
 */
function validateIncident(incident) {
    if (!incident.title || incident.title.trim() === "") {
        throw new Error("Please input title");
    }
    if (!incident.content || incident.content.trim() === "") {
        throw new Error("Please input content");
    }
}

/**
 * Socket handlers for status page
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
module.exports.statusPageSocketHandler = (socket) => {
    // Post or edit incident
    socket.on("postIncident", async (slug, incident, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            let incidentBean;

            if (incident.id) {
                incidentBean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [
                    incident.id,
                    statusPageID,
                ]);
            }

            if (incidentBean == null) {
                incidentBean = R.dispense("incident");
            }

            const isNew = !incidentBean.id;

            incidentBean.title = incident.title;
            incidentBean.content = incident.content;
            incidentBean.style = incident.style;
            incidentBean.pin = true;
            incidentBean.active = true;
            incidentBean.status_page_id = statusPageID;

            if (INCIDENT_STATUS_LIST.includes(incident.status)) {
                incidentBean.status = incident.status;
            } else if (isNew) {
                incidentBean.status = INCIDENT_STATUS.INVESTIGATING;
            }

            if (incident.id) {
                incidentBean.last_updated_date = R.isoDateTime(dayjs.utc());
            } else {
                incidentBean.created_date = R.isoDateTime(dayjs.utc());
            }

            await R.store(incidentBean);

            // Seed the timeline so a freshly posted incident already reads as
            // history rather than gaining its first entry only on the next edit.
            if (isNew) {
                const first = R.dispense("incident_update");
                first.incident_id = incidentBean.id;
                first.status = incidentBean.status;
                first.content = incidentBean.content;
                first.created_date = incidentBean.created_date;
                first.created_by = socket.userID;
                await R.store(first);
            }

            // The public status page and incident history endpoints are cached
            // for 5 minutes, so without this a newly posted incident stays
            // invisible to visitors for up to that long.
            apicache.clear();

            const updates = await Incident.getUpdatesFor([incidentBean.id]);
            const incidentJSON = incidentBean.toPublicJSON(updates.get(incidentBean.id) ?? []);

            // Only a newly posted incident mails subscribers; an edit is a
            // correction, not news. Follow-ups go out via addIncidentUpdate.
            if (isNew) {
                statusPageMailer
                    .notifyIncident(statusPageID, incidentJSON)
                    .catch((e) => log.warn("status-page-mail", e.message));
            }

            callback({
                ok: true,
                incident: incidentJSON,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("unpinIncident", async (slug, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            await R.exec("UPDATE incident SET pin = 0 WHERE pin = 1 AND status_page_id = ? ", [statusPageID]);
            apicache.clear();

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("getIncidentHistory", async (slug, cursor, callback) => {
        try {
            let statusPageID = await StatusPage.slugToID(slug);
            if (!statusPageID) {
                throw new Error("slug is not found");
            }

            const isPublic = !socket.userID;
            const result = await StatusPage.getIncidentHistory(statusPageID, cursor, isPublic);
            callback({
                ok: true,
                ...result,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    socket.on("editIncident", async (slug, incidentID, incident, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            try {
                validateIncident(incident);
            } catch (e) {
                callback({
                    ok: false,
                    msg: e.message,
                    msgi18n: true,
                });
                return;
            }

            const validStyles = ["info", "warning", "danger", "primary", "light", "dark"];
            if (!validStyles.includes(incident.style)) {
                incident.style = "warning";
            }

            bean.title = incident.title;
            bean.content = incident.content;
            bean.style = incident.style;
            bean.pin = incident.pin !== false;
            bean.lastUpdatedDate = R.isoDateTime(dayjs.utc());

            await R.store(bean);
            apicache.clear();

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                incident: bean.toPublicJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("deleteIncident", async (slug, incidentID, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            await R.trash(bean);
            apicache.clear();

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("getStatusPageSmtp", async (callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.SETTINGS_MANAGE);
            const config = await statusPageMailer.getSmtpConfig();
            callback({
                ok: true,
                // The password is write-only: report whether one is stored
                // rather than sending it back to the browser.
                config: { ...config, password: undefined, hasPassword: !!config.password },
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("setStatusPageSmtp", async (config, callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.SETTINGS_MANAGE);

            const existing = await statusPageMailer.getSmtpConfig();
            const next = {
                host: String(config?.host ?? "").trim(),
                port: Number(config?.port) || 587,
                secure: !!config?.secure,
                ignoreTLSError: !!config?.ignoreTLSError,
                username: String(config?.username ?? "").trim(),
                // A blank password means "keep the stored one", so saving other
                // fields does not silently wipe the credential.
                password: config?.password ? String(config.password) : (existing.password ?? ""),
                fromAddress: String(config?.fromAddress ?? "").trim(),
                fromName: String(config?.fromName ?? "").trim(),
            };

            await Settings.setSettings(statusPageMailer.SETTINGS_TYPE, next);
            callback({ ok: true, msg: "Saved.", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("testStatusPageSmtp", async (to, callback) => {
        try {
            await requirePermission(socket, PERMISSIONS.SETTINGS_MANAGE);

            const recipient = String(to ?? "").trim();
            if (!recipient) {
                throw new Error("Please enter a recipient address");
            }

            await statusPageMailer.sendMail({
                to: recipient,
                subject: "Ayoratou test email",
                text: "This is a test email from Ayoratou. Your status page SMTP settings are working.",
                html: "<p>This is a test email from Ayoratou. Your status page SMTP settings are working.</p>",
            });

            callback({ ok: true, msg: "Sent Successfully." });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("getStatusPageSubscribers", async (slug, callback) => {
        try {
            const statusPage = await getEditableStatusPage(socket, slug);
            const subscribers = await R.find(
                "status_page_subscriber",
                " status_page_id = ? ORDER BY created_date DESC ",
                [statusPage.id]
            );

            callback({
                ok: true,
                subscribers: subscribers.map((s) => ({
                    id: s.id,
                    email: s.email,
                    confirmed: !!s.confirmed,
                    createdDate: s.created_date,
                })),
            });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    socket.on("deleteStatusPageSubscriber", async (slug, subscriberID, callback) => {
        try {
            const statusPage = await getEditableStatusPage(socket, slug);
            const subscriber = await R.findOne("status_page_subscriber", " id = ? AND status_page_id = ? ", [
                subscriberID,
                statusPage.id,
            ]);

            if (subscriber) {
                await R.trash(subscriber);
            }

            callback({ ok: true, msg: "successDeleted", msgi18n: true });
        } catch (e) {
            callback({ ok: false, msg: e.message });
        }
    });

    // Append an entry to an incident's timeline. This is the non-destructive
    // counterpart to editIncident, which rewrites the incident in place.
    socket.on("addIncidentUpdate", async (slug, incidentID, update, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            const bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({ ok: false, msg: "Incident not found or access denied", msgi18n: true });
                return;
            }

            const stored = await bean.addUpdate(update?.status, update?.content, socket.userID);
            apicache.clear();

            const updates = await Incident.getUpdatesFor([bean.id]);
            const incidentJSON = bean.toPublicJSON(updates.get(bean.id) ?? []);

            statusPageMailer
                .notifyIncident(statusPageID, incidentJSON, { status: stored.status, content: stored.content })
                .catch((e) => log.warn("status-page-mail", e.message));

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
                incident: incidentJSON,
            });
        } catch (error) {
            callback({ ok: false, msg: error.message });
        }
    });

    socket.on("resolveIncident", async (slug, incidentID, callback) => {
        try {
            const statusPageID = (await getEditableStatusPage(socket, slug)).id;

            let bean = await R.findOne("incident", " id = ? AND status_page_id = ? ", [incidentID, statusPageID]);
            if (!bean) {
                callback({
                    ok: false,
                    msg: "Incident not found or access denied",
                    msgi18n: true,
                });
                return;
            }

            // Record the resolution on the timeline so the page shows when it
            // ended, not just that it is no longer active.
            const resolutionNote = R.dispense("incident_update");
            resolutionNote.incident_id = bean.id;
            resolutionNote.status = INCIDENT_STATUS.RESOLVED;
            resolutionNote.content = "Resolved.";
            resolutionNote.created_date = R.isoDateTime(dayjs.utc());
            resolutionNote.created_by = socket.userID;
            await R.store(resolutionNote);

            await bean.resolve();
            apicache.clear();

            const updates = await Incident.getUpdatesFor([bean.id]);
            const incidentJSON = bean.toPublicJSON(updates.get(bean.id) ?? []);

            statusPageMailer
                .notifyIncident(statusPageID, incidentJSON, { status: INCIDENT_STATUS.RESOLVED, content: "Resolved." })
                .catch((e) => log.warn("status-page-mail", e.message));

            callback({
                ok: true,
                msg: "Resolved",
                msgi18n: true,
                incident: incidentJSON,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
                msgi18n: true,
            });
        }
    });

    socket.on("getStatusPage", async (slug, callback) => {
        try {
            const statusPage = await getEditableStatusPage(socket, slug);

            callback({
                ok: true,
                config: await statusPage.toJSON(),
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Save Status Page
    // imgDataUrl Only Accept PNG!
    socket.on("saveStatusPage", async (slug, config, imgDataUrl, publicGroupList, callback) => {
        try {
            // Save Config
            let statusPage = await getEditableStatusPage(socket, slug);

            checkSlug(config.slug);

            const header = "data:image/png;base64,";

            // Check logo format
            // If is image data url, convert to png file
            // Else assume it is a url, nothing to do
            if (imgDataUrl.startsWith("data:")) {
                if (!imgDataUrl.startsWith(header)) {
                    throw new Error("Only allowed PNG logo.");
                }

                const filename = `logo${statusPage.id}.png`;

                // Convert to file
                await ImageDataURI.outputFile(imgDataUrl, Database.uploadDir + filename);
                config.logo = `/upload/${filename}?t=` + Date.now();
            } else {
                config.logo = imgDataUrl;
            }

            statusPage.slug = config.slug;
            statusPage.title = config.title;
            statusPage.description = config.description;
            statusPage.icon = config.logo;
            ((statusPage.autoRefreshInterval = config.autoRefreshInterval), (statusPage.theme = config.theme));
            //statusPage.published = ;
            //statusPage.search_engine_index = ;
            statusPage.show_tags = config.showTags;
            //statusPage.password = null;
            statusPage.footer_text = config.footerText;
            statusPage.custom_css = config.customCSS;
            statusPage.show_powered_by = config.showPoweredBy;
            statusPage.subscription_enabled = !!config.subscriptionEnabled;
            statusPage.rss_title = config.rssTitle;
            statusPage.show_only_last_heartbeat = config.showOnlyLastHeartbeat;
            statusPage.show_certificate_expiry = config.showCertificateExpiry;
            statusPage.modified_date = R.isoDateTime();
            statusPage.analytics_id = config.analyticsId;
            statusPage.analytics_script_url = config.analyticsScriptUrl;
            const validAnalyticsTypes = ["google", "umami", "plausible", "matomo", "rybbit"];
            if (config.analyticsType !== null && !validAnalyticsTypes.includes(config.analyticsType)) {
                throw new Error("Invalid analytics type");
            }
            statusPage.analytics_type = config.analyticsType;

            await R.store(statusPage);

            await statusPage.updateDomainNameList(config.domainNameList);
            await StatusPage.loadDomainMappingList();

            // Save Public Group List
            const groupIDList = [];
            let groupOrder = 1;

            for (let group of publicGroupList) {
                let groupBean;
                if (group.id) {
                    groupBean = await R.findOne("group", " id = ? AND public = 1 AND status_page_id = ? ", [
                        group.id,
                        statusPage.id,
                    ]);
                } else {
                    groupBean = R.dispense("group");
                }

                groupBean.status_page_id = statusPage.id;
                groupBean.name = group.name;
                groupBean.public = true;
                groupBean.weight = groupOrder++;

                await R.store(groupBean);

                await R.exec("DELETE FROM monitor_group WHERE group_id = ? ", [groupBean.id]);

                let monitorOrder = 1;

                for (let monitor of group.monitorList) {
                    let relationBean = R.dispense("monitor_group");
                    relationBean.weight = monitorOrder++;
                    relationBean.group_id = groupBean.id;
                    relationBean.monitor_id = monitor.id;

                    if (monitor.sendUrl !== undefined) {
                        relationBean.send_url = monitor.sendUrl;
                    }

                    if (monitor.url !== undefined) {
                        relationBean.custom_url = monitor.url;
                    }

                    await R.store(relationBean);
                }

                groupIDList.push(groupBean.id);
                group.id = groupBean.id;
            }

            // Delete groups that are not in the list
            log.debug("socket", "Delete groups that are not in the list");
            if (groupIDList.length === 0) {
                await R.exec("DELETE FROM `group` WHERE status_page_id = ?", [statusPage.id]);
            } else {
                const slots = groupIDList.map(() => "?").join(",");

                const data = [...groupIDList, statusPage.id];
                await R.exec(`DELETE FROM \`group\` WHERE id NOT IN (${slots}) AND status_page_id = ?`, data);
            }

            const server = UptimeKumaServer.getInstance();

            // Also change entry page to new slug if it is the default one, and slug is changed.
            if (server.entryPage === "statusPage-" + slug && statusPage.slug !== slug) {
                server.entryPage = "statusPage-" + statusPage.slug;
                await Settings.set("entryPage", server.entryPage, "general");
            }

            apicache.clear();

            callback({
                ok: true,
                publicGroupList,
            });
        } catch (error) {
            log.error("socket", error);

            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Add a new status page
    socket.on("addStatusPage", async (title, slug, callback) => {
        try {
            const user = await requirePermission(socket, PERMISSIONS.STATUSPAGE_CREATE);

            title = title?.trim();
            slug = slug?.trim();

            // Check empty
            if (!title || !slug) {
                throw new Error("Please input all fields");
            }

            // Make sure slug is string
            if (typeof slug !== "string") {
                throw new Error("Slug -Accept string only");
            }

            // lower case only
            slug = slug.toLowerCase();

            checkSlug(slug);

            let statusPage = R.dispense("status_page");
            statusPage.slug = slug;
            statusPage.title = title;
            statusPage.theme = "auto";
            statusPage.icon = "";
            statusPage.autoRefreshInterval = 300;
            // Record the creator so "edit own" can be enforced later.
            statusPage.user_id = user.id;
            await R.store(statusPage);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                slug: slug,
            });
        } catch (error) {
            log.error("socket", error);
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });

    // Delete a status page
    socket.on("deleteStatusPage", async (slug, callback) => {
        const server = UptimeKumaServer.getInstance();

        try {
            const statusPageID = (
                await getEditableStatusPage(
                    socket,
                    slug,
                    PERMISSIONS.STATUSPAGE_DELETE_OWN,
                    PERMISSIONS.STATUSPAGE_DELETE_ALL
                )
            ).id;

            if (statusPageID) {
                // Reset entry page if it is the default one.
                if (server.entryPage === "statusPage-" + slug) {
                    server.entryPage = "dashboard";
                    await Settings.set("entryPage", server.entryPage, "general");
                }

                // No need to delete records from `status_page_cname`, because it has cascade foreign key.
                // But for incident & group, it is hard to add cascade foreign key during migration, so they have to be deleted manually.

                // Delete incident
                await R.exec("DELETE FROM incident WHERE status_page_id = ? ", [statusPageID]);

                // Delete group
                await R.exec("DELETE FROM `group` WHERE status_page_id = ? ", [statusPageID]);

                // Delete status_page
                await R.exec("DELETE FROM status_page WHERE id = ? ", [statusPageID]);

                apicache.clear();
            } else {
                throw new Error("Status Page is not found");
            }

            callback({
                ok: true,
            });
        } catch (error) {
            callback({
                ok: false,
                msg: error.message,
            });
        }
    });
};

/**
 * Check slug a-z, 0-9, - only
 * Regex from: https://stackoverflow.com/questions/22454258/js-regex-string-validation-for-slug
 * @param {string} slug Slug to test
 * @returns {void}
 * @throws Slug is not valid
 */
function checkSlug(slug) {
    if (typeof slug !== "string") {
        throw new Error("Slug must be string");
    }

    slug = slug.trim();

    if (!slug) {
        throw new Error("Slug cannot be empty");
    }

    if (!slug.match(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)) {
        throw new Error("Invalid Slug");
    }
}
