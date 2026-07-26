<template>
    <div>
        <form @submit.prevent="save">
            <p class="form-text">{{ $t("statusPageSmtpDescription") }}</p>

            <div class="row">
                <div class="col-md-8 mb-3">
                    <label for="smtp-host" class="form-label">{{ $t("Hostname") }}</label>
                    <input
                        id="smtp-host"
                        v-model="config.host"
                        type="text"
                        class="form-control"
                        placeholder="smtp.example.com"
                        required
                    />
                </div>
                <div class="col-md-4 mb-3">
                    <label for="smtp-port" class="form-label">{{ $t("Port") }}</label>
                    <input id="smtp-port" v-model.number="config.port" type="number" class="form-control" required />
                </div>
            </div>

            <div class="mb-3 form-check form-switch">
                <input id="smtp-secure" v-model="config.secure" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="smtp-secure">{{ $t("smtpSecure") }}</label>
                <div class="form-text">{{ $t("smtpSecureDescription") }}</div>
            </div>

            <div class="mb-3 form-check form-switch">
                <input id="smtp-ignore-tls" v-model="config.ignoreTLSError" class="form-check-input" type="checkbox" />
                <label class="form-check-label" for="smtp-ignore-tls">{{ $t("smtpIgnoreTLSError") }}</label>
            </div>

            <div class="row">
                <div class="col-md-6 mb-3">
                    <label for="smtp-username" class="form-label">{{ $t("Username") }}</label>
                    <input
                        id="smtp-username"
                        v-model="config.username"
                        type="text"
                        class="form-control"
                        autocomplete="off"
                    />
                    <div class="form-text">{{ $t("smtpUsernameDescription") }}</div>
                </div>
                <div class="col-md-6 mb-3">
                    <label for="smtp-password" class="form-label">{{ $t("Password") }}</label>
                    <HiddenInput
                        id="smtp-password"
                        v-model="config.password"
                        autocomplete="new-password"
                        :placeholder="config.hasPassword ? $t('smtpPasswordUnchanged') : ''"
                    ></HiddenInput>
                    <div v-if="config.hasPassword" class="form-text">{{ $t("smtpPasswordKeep") }}</div>
                </div>
            </div>

            <div class="row">
                <div class="col-md-6 mb-3">
                    <label for="smtp-from-address" class="form-label">{{ $t("smtpFromAddress") }}</label>
                    <input
                        id="smtp-from-address"
                        v-model="config.fromAddress"
                        type="email"
                        class="form-control"
                        placeholder="status@example.com"
                        required
                    />
                </div>
                <div class="col-md-6 mb-3">
                    <label for="smtp-from-name" class="form-label">{{ $t("smtpFromName") }}</label>
                    <input
                        id="smtp-from-name"
                        v-model="config.fromName"
                        type="text"
                        class="form-control"
                        placeholder="Ayoratou Status"
                    />
                </div>
            </div>

            <div class="mb-4">
                <button class="btn btn-primary" type="submit" :disabled="processing">
                    {{ $t("Save") }}
                </button>
            </div>
        </form>

        <hr />

        <h5>{{ $t("smtpSendTest") }}</h5>
        <p class="form-text mt-0">{{ $t("smtpSendTestDescription") }}</p>
        <div class="row g-2 align-items-start">
            <div class="col-md-6">
                <input
                    id="smtp-test-to"
                    v-model="testRecipient"
                    type="email"
                    class="form-control"
                    placeholder="you@example.com"
                />
            </div>
            <div class="col-md-auto">
                <button class="btn btn-outline-primary" :disabled="testing || !testRecipient" @click="sendTest">
                    {{ testing ? $t("smtpSending") : $t("smtpSendTest") }}
                </button>
            </div>
        </div>
    </div>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: { HiddenInput },

    data() {
        return {
            processing: false,
            testing: false,
            testRecipient: "",
            config: {
                host: "",
                port: 587,
                secure: false,
                ignoreTLSError: false,
                username: "",
                password: "",
                fromAddress: "",
                fromName: "",
                hasPassword: false,
            },
        };
    },

    mounted() {
        this.load();
    },

    methods: {
        /**
         * Load the stored SMTP settings. The password is never returned; the
         * server only reports whether one exists.
         * @returns {void}
         */
        load() {
            this.$root.getSocket().emit("getStatusPageSmtp", (res) => {
                if (res.ok) {
                    this.config = {
                        ...this.config,
                        ...res.config,
                        password: "",
                    };
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },

        /**
         * Persist the settings.
         * @returns {void}
         */
        save() {
            this.processing = true;
            this.$root.getSocket().emit("setStatusPageSmtp", this.config, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.load();
                }
            });
        },

        /**
         * Send a test message to prove the settings work before relying on them.
         * @returns {void}
         */
        sendTest() {
            this.testing = true;
            this.$root.getSocket().emit("testStatusPageSmtp", this.testRecipient, (res) => {
                this.testing = false;
                this.$root.toastRes(res);
            });
        },
    },
};
</script>
