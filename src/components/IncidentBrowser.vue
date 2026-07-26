<template>
    <div class="incident-browser">
        <div class="browser-toolbar">
            <div class="search-field">
                <font-awesome-icon icon="search" class="search-icon" />
                <input
                    v-model="query"
                    type="search"
                    class="form-control"
                    :placeholder="$t('searchIncidents')"
                    :aria-label="$t('searchIncidents')"
                />
            </div>

            <select v-model="statusFilter" class="form-select filter-select" :aria-label="$t('filterByStatus')">
                <option value="">{{ $t("allStatuses") }}</option>
                <option value="investigating">{{ $t("incidentStatus_investigating") }}</option>
                <option value="identified">{{ $t("incidentStatus_identified") }}</option>
                <option value="monitoring">{{ $t("incidentStatus_monitoring") }}</option>
                <option value="resolved">{{ $t("incidentStatus_resolved") }}</option>
            </select>

            <select v-model="stateFilter" class="form-select filter-select" :aria-label="$t('filterByState')">
                <option value="">{{ $t("allIncidents") }}</option>
                <option value="active">{{ $t("onlyOngoing") }}</option>
                <option value="past">{{ $t("onlyPast") }}</option>
            </select>

            <input
                v-model="fromDate"
                type="date"
                class="form-control date-input"
                :aria-label="$t('filterFrom')"
                :title="$t('filterFrom')"
            />
            <input
                v-model="toDate"
                type="date"
                class="form-control date-input"
                :aria-label="$t('filterTo')"
                :title="$t('filterTo')"
            />

            <div class="btn-group export-group">
                <button class="btn btn-outline-secondary" type="button" @click="exportAs('csv')">
                    <font-awesome-icon icon="download" />
                    CSV
                </button>
                <button class="btn btn-outline-secondary" type="button" @click="exportAs('json')">
                    <font-awesome-icon icon="download" />
                    JSON
                </button>
            </div>
        </div>

        <div class="browser-summary">
            {{ $t("showingNofM", { n: filtered.length, m: incidents.length }) }}
            <button v-if="hasFilters" class="btn btn-link btn-sm clear-link" type="button" @click="clearFilters">
                {{ $t("clearFilters") }}
            </button>
        </div>

        <IncidentHistory :incidents="filtered" :loading="loading" />
    </div>
</template>

<script>
import IncidentHistory from "./IncidentHistory.vue";

export default {
    name: "IncidentBrowser",

    components: { IncidentHistory },

    props: {
        /** Every incident available to browse. */
        incidents: {
            type: Array,
            default: () => [],
        },
        loading: {
            type: Boolean,
            default: false,
        },
        /** Used to name the exported file. */
        slug: {
            type: String,
            default: "status",
        },
    },

    data() {
        return {
            query: "",
            statusFilter: "",
            stateFilter: "",
            fromDate: "",
            toDate: "",
        };
    },

    computed: {
        /**
         * Whether any filter is narrowing the list.
         * @returns {boolean} True if filtered.
         */
        hasFilters() {
            return !!(this.query || this.statusFilter || this.stateFilter || this.fromDate || this.toDate);
        },

        /**
         * Incidents matching the current search and filters.
         *
         * Text search covers the timeline as well as the title and body, so
         * searching for a phrase used only in a follow-up still finds it.
         * @returns {object[]} Matching incidents.
         */
        filtered() {
            const needle = this.query.trim().toLowerCase();

            return this.incidents.filter((incident) => {
                if (this.statusFilter && (incident.status || "investigating") !== this.statusFilter) {
                    return false;
                }

                if (this.stateFilter === "active" && !incident.active) {
                    return false;
                }
                if (this.stateFilter === "past" && incident.active) {
                    return false;
                }

                // Compare on the date portion so the bounds are inclusive
                // regardless of the time of day an incident was raised.
                const day = (incident.createdDate ?? "").slice(0, 10);
                if (this.fromDate && day && day < this.fromDate) {
                    return false;
                }
                if (this.toDate && day && day > this.toDate) {
                    return false;
                }

                if (!needle) {
                    return true;
                }

                const haystack = [incident.title, incident.content, ...(incident.updates ?? []).map((u) => u.content)]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();

                return haystack.includes(needle);
            });
        },
    },

    methods: {
        /**
         * Reset every filter.
         * @returns {void}
         */
        clearFilters() {
            this.query = "";
            this.statusFilter = "";
            this.stateFilter = "";
            this.fromDate = "";
            this.toDate = "";
        },

        /**
         * Download the filtered incidents.
         *
         * Exports what is on screen rather than everything, so a search doubles
         * as a way to extract a subset.
         * @param {string} format "csv" or "json".
         * @returns {void}
         */
        exportAs(format) {
            const rows = this.filtered;
            const stamp = new Date().toISOString().slice(0, 10);

            if (format === "json") {
                this.download(
                    JSON.stringify(rows, null, 2),
                    "application/json",
                    `${this.slug}-incidents-${stamp}.json`
                );
                return;
            }

            const header = ["id", "title", "status", "ongoing", "created", "last_updated", "updates", "content"];
            const lines = [header.join(",")];

            for (const incident of rows) {
                lines.push(
                    [
                        incident.id,
                        incident.title,
                        incident.status ?? "",
                        incident.active ? "yes" : "no",
                        incident.createdDate ?? "",
                        incident.lastUpdatedDate ?? "",
                        (incident.updates ?? []).length,
                        incident.content ?? "",
                    ]
                        .map(this.csvCell)
                        .join(",")
                );
            }

            this.download(lines.join("\n"), "text/csv", `${this.slug}-incidents-${stamp}.csv`);
        },

        /**
         * Quote a CSV cell.
         *
         * A leading =, +, - or @ is prefixed with a quote so spreadsheet
         * software treats it as text rather than a formula.
         * @param {any} value Raw value.
         * @returns {string} Quoted cell.
         */
        csvCell(value) {
            let text = String(value ?? "");
            if (/^[=+\-@]/.test(text)) {
                text = `'${text}`;
            }
            return `"${text.replace(/"/g, '""')}"`;
        },

        /**
         * Trigger a client-side file download.
         * @param {string} content File body.
         * @param {string} mime Content type.
         * @param {string} filename Suggested name.
         * @returns {void}
         */
        download(content, mime, filename) {
            const blob = new Blob([content], { type: `${mime};charset=utf-8;` });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.browser-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 10px 4px;
}

.search-field {
    position: relative;
    flex: 1 1 220px;
    min-width: 0;

    .form-control {
        padding-left: 34px;
    }
}

.search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 13px;
    opacity: 0.5;
    pointer-events: none;
}

.filter-select {
    flex: 0 1 160px;
}

.date-input {
    flex: 0 1 150px;
}

.export-group {
    flex: 0 0 auto;
    height: 38px;
}

.browser-summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 0;
    font-size: 13px;
    color: $secondary-text;
}

.clear-link {
    padding: 0;
    font-size: 13px;
}

@media (max-width: 600px) {
    .filter-select,
    .date-input {
        flex: 1 1 100%;
    }

    .export-group {
        width: 100%;
    }
}
</style>
