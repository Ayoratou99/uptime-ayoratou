<template>
    <div v-if="updates.length > 0" class="incident-timeline">
        <div v-for="update in updates" :key="update.id" class="timeline-entry">
            <div class="timeline-marker" :class="'status-' + update.status"></div>
            <div class="timeline-body">
                <div class="timeline-heading">
                    <span class="status-label" :class="'status-' + update.status">
                        {{ statusLabel(update.status) }}
                    </span>
                    <span class="timeline-date">{{ $root.datetime(update.createdDate) }}</span>
                    <span v-if="update.author" class="timeline-author">&middot; {{ update.author }}</span>
                </div>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div class="timeline-content" v-html="renderContent(update.content)"></div>
            </div>
        </div>
    </div>
</template>

<script>
import { marked } from "marked";
import DOMPurify from "dompurify";

export default {
    name: "IncidentTimeline",

    props: {
        /** Timeline entries, newest first, as returned by Incident.toPublicJSON(). */
        updates: {
            type: Array,
            default: () => [],
        },
    },

    methods: {
        /**
         * Translated label for an incident status.
         *
         * Resolved through a lookup rather than key concatenation so the
         * translation key checker can see each key literally.
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
                }[status] ?? status
            );
        },

        /**
         * Render an update's markdown, sanitised.
         *
         * Updates are authored by logged-in staff but rendered on a public
         * page, so the output is still passed through DOMPurify.
         * @param {string} content Markdown source.
         * @returns {string} Safe HTML.
         */
        renderContent(content) {
            return DOMPurify.sanitize(marked(content ?? ""));
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.incident-timeline {
    margin-top: 18px;
    border-top: 1px solid rgba(128, 128, 128, 0.25);
    padding-top: 14px;
}

.timeline-entry {
    display: flex;
    gap: 12px;
    padding-bottom: 16px;
    position: relative;

    &:not(:last-child)::before {
        content: "";
        position: absolute;
        left: 5px;
        top: 16px;
        bottom: 0;
        width: 2px;
        background-color: rgba(128, 128, 128, 0.3);
    }
}

.timeline-marker {
    flex: 0 0 auto;
    width: 12px;
    height: 12px;
    margin-top: 4px;
    border-radius: 50%;
    background-color: $secondary-text;
    z-index: 1;

    &.status-investigating {
        background-color: $warning;
    }

    &.status-identified {
        background-color: $danger;
    }

    &.status-monitoring {
        background-color: $primary;
    }

    &.status-resolved {
        background-color: $primary;
    }
}

.timeline-body {
    flex: 1 1 auto;
    min-width: 0;
}

.timeline-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
}

.status-label {
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    font-size: 12px;
}

.timeline-date,
.timeline-author {
    opacity: 0.75;
}

.timeline-content {
    margin-top: 4px;
    font-size: 14px;

    :deep(p:last-child) {
        margin-bottom: 0;
    }
}
</style>
