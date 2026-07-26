<template>
    <div class="shadow-box subscribe-box p-4 mb-4">
        <h3 class="subscribe-title">{{ $t("subscribeToUpdates") }}</h3>
        <p class="subscribe-help">{{ $t("subscribeToUpdatesDescription") }}</p>

        <form class="subscribe-form" @submit.prevent="subscribe">
            <input
                v-model="email"
                type="email"
                class="form-control"
                :placeholder="$t('emailPlaceholder')"
                :aria-label="$t('Email')"
                required
                :disabled="submitting || done"
            />
            <button class="btn btn-primary" type="submit" :disabled="submitting || done">
                {{ submitting ? $t("subscribing") : $t("Subscribe") }}
            </button>
        </form>

        <p v-if="message" class="subscribe-message" :class="{ error: isError }">
            {{ message }}
        </p>
    </div>
</template>

<script>
import axios from "axios";

export default {
    name: "StatusPageSubscribe",

    props: {
        /** Slug of the status page being subscribed to. */
        slug: {
            type: String,
            required: true,
        },
    },

    data() {
        return {
            email: "",
            submitting: false,
            done: false,
            message: "",
            isError: false,
        };
    },

    methods: {
        /**
         * Request a subscription. The server replies identically whether or not
         * the address is already on the list, so nothing here reveals it.
         * @returns {Promise<void>}
         */
        async subscribe() {
            this.submitting = true;
            this.message = "";
            this.isError = false;

            try {
                const res = await axios.post(`/api/status-page/${encodeURIComponent(this.slug)}/subscribe`, {
                    email: this.email,
                });
                this.message = res.data.msg;
                this.done = true;
            } catch (e) {
                this.isError = true;
                this.message = e.response?.data?.msg || this.$t("subscribeFailed");
            } finally {
                this.submitting = false;
            }
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.subscribe-title {
    font-size: 18px;
    margin-bottom: 4px;
}

.subscribe-help {
    font-size: 14px;
    color: $secondary-text;
    margin-bottom: 14px;
}

.subscribe-form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;

    .form-control {
        flex: 1 1 220px;
        min-width: 0;
    }

    .btn {
        flex: 0 0 auto;
    }
}

.subscribe-message {
    margin: 12px 0 0;
    font-size: 14px;
    color: $primary;

    &.error {
        color: $danger;
    }
}
</style>
