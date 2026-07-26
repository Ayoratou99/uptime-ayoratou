<template>
    <div class="incident-group" data-testid="incident-group">
        <div v-if="loading && incidents.length === 0" class="text-center py-4">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">{{ $t("Loading...") }}</span>
            </div>
        </div>

        <div v-else-if="incidents.length === 0" class="text-center py-4 text-muted">
            {{ $t("No incidents recorded") }}
        </div>

        <div v-else class="incident-list">
            <div
                v-for="incident in incidents"
                :key="incident.id"
                class="incident-item"
                :class="{ resolved: !incident.active }"
            >
                <div class="incident-style-indicator" :class="'bg-' + incident.style"></div>
                <div class="incident-body">
                    <div class="incident-header">
                        <!-- The whole summary row toggles, so the hit area is
                             large rather than a lone chevron. -->
                        <button
                            class="incident-toggle"
                            type="button"
                            :aria-expanded="isExpanded(incident.id) ? 'true' : 'false'"
                            @click="toggle(incident.id)"
                        >
                            <font-awesome-icon
                                icon="chevron-down"
                                class="toggle-chevron"
                                :class="{ collapsed: !isExpanded(incident.id) }"
                            />
                            <span class="incident-title">{{ incident.title }}</span>
                            <span
                                class="incident-status-pill"
                                :class="'status-' + (incident.status || 'investigating')"
                            >
                                {{ statusLabel(incident.status) }}
                            </span>
                            <span class="incident-when">{{ datetime(incident.createdDate) }}</span>
                        </button>

                        <div v-if="editMode" class="incident-actions">
                            <button
                                v-if="incident.active"
                                class="btn btn-success btn-sm me-1"
                                :title="$t('Resolve')"
                                @click="$emit('resolve-incident', incident)"
                            >
                                <font-awesome-icon icon="check" />
                            </button>
                            <button
                                class="btn btn-outline-secondary btn-sm me-1"
                                :title="$t('Edit')"
                                @click="$emit('edit-incident', incident)"
                            >
                                <font-awesome-icon icon="edit" />
                            </button>
                            <button
                                class="btn btn-outline-danger btn-sm"
                                :title="$t('Delete')"
                                @click="$emit('delete-incident', incident)"
                            >
                                <font-awesome-icon icon="trash" />
                            </button>
                        </div>
                    </div>

                    <!-- Collapsed by default: with many incidents, expanding
                         every timeline at once makes the page unusable. -->
                    <div v-if="isExpanded(incident.id)" class="incident-detail">
                        <!-- eslint-disable-next-line vue/no-v-html-->
                        <div class="incident-content mt-1" v-html="getIncidentHTML(incident.content)"></div>

                        <IncidentTimeline :updates="incident.updates || []" />

                        <div class="incident-meta text-muted small mt-2">
                            <div>{{ $t("createdAt", { date: datetime(incident.createdDate) }) }}</div>
                            <div v-if="incident.lastUpdatedDate">
                                {{ $t("lastUpdatedAt", { date: datetime(incident.lastUpdatedDate) }) }}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { marked } from "marked";
import DOMPurify from "dompurify";
import datetimeMixin from "../mixins/datetime";
import IncidentTimeline from "./IncidentTimeline.vue";

export default {
    name: "IncidentHistory",
    components: { IncidentTimeline },
    mixins: [datetimeMixin],
    props: {
        incidents: {
            type: Array,
            default: () => [],
        },
        editMode: {
            type: Boolean,
            default: false,
        },
        loading: {
            type: Boolean,
            default: false,
        },
        /** Ids to render expanded on first paint. */
        initiallyExpanded: {
            type: Array,
            default: () => [],
        },
    },
    emits: ["edit-incident", "delete-incident", "resolve-incident"],

    data() {
        return {
            expanded: [...this.initiallyExpanded],
        };
    },

    methods: {
        /**
         * Whether an incident's detail is showing.
         * @param {number} id Incident id.
         * @returns {boolean} True when expanded.
         */
        isExpanded(id) {
            return this.expanded.includes(id);
        },

        /**
         * Expand or collapse one incident.
         * @param {number} id Incident id.
         * @returns {void}
         */
        toggle(id) {
            const index = this.expanded.indexOf(id);
            if (index === -1) {
                this.expanded.push(id);
            } else {
                this.expanded.splice(index, 1);
            }
        },

        /**
         * Translated label for an incident status.
         *
         * Looked up rather than concatenated so the translation key checker
         * can see each key literally.
         * @param {string} status Status id.
         * @returns {string} Label to display.
         */
        statusLabel(status) {
            return (
                {
                    investigating: this.$t("incidentStatus_investigating"),
                    identified: this.$t("incidentStatus_identified"),
                    monitoring: this.$t("incidentStatus_monitoring"),
                    resolved: this.$t("incidentStatus_resolved"),
                }[status] ?? this.$t("incidentStatus_investigating")
            );
        },

        /**
         * Get sanitized HTML for incident content
         * @param {string} content - Markdown content
         * @returns {string} Sanitized HTML
         */
        getIncidentHTML(content) {
            if (content != null) {
                return DOMPurify.sanitize(marked(content));
            }
            return "";
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.incident-group {
    padding: 10px;

    .incident-list {
        .incident-item {
            display: flex;
            padding: 13px 15px 10px 15px;
            border-radius: 10px;
            transition: all ease-in-out 0.15s;

            &:hover {
                background-color: $highlight-white;
            }

            &.resolved {
                opacity: 0.7;
            }

            .incident-style-indicator {
                width: 6px;
                min-height: 100%;
                border-radius: 3px;
                flex-shrink: 0;
                margin-right: 12px;
            }

            .incident-body {
                flex: 1;
                min-width: 0;
            }

            .incident-meta {
                font-size: 12px;
            }
        }
    }
}

.incident-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
}

.incident-toggle {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    text-align: left;
    color: inherit;
    cursor: pointer;
}

.toggle-chevron {
    flex: 0 0 auto;
    font-size: 12px;
    opacity: 0.7;
    transition: transform 0.2s ease;

    &.collapsed {
        transform: rotate(-90deg);
    }
}

.incident-title {
    font-size: 17px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.incident-status-pill {
    flex: 0 0 auto;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 999px;
    background: rgba(128, 128, 128, 0.15);
    color: $secondary-text;

    &.status-investigating {
        background: rgba(248, 163, 6, 0.16);
        color: $warning;
    }

    &.status-identified {
        background: rgba(220, 53, 69, 0.16);
        color: $danger;
    }

    &.status-monitoring,
    &.status-resolved {
        background: rgba(92, 221, 139, 0.16);
        color: $primary;
    }
}

.incident-when {
    flex: 0 0 auto;
    font-size: 12px;
    color: $secondary-text;
}

.incident-actions {
    flex: 0 0 auto;
}

.dark {
    .incident-group {
        .incident-list {
            .incident-item {
                &:hover {
                    background-color: $dark-bg2;
                }
            }
        }
    }
}
</style>
