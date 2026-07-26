<template>
    <div class="form-container">
        <div class="form">
            <!-- Mandatory 2FA enrolment. Reached after the password is accepted
                 but before a session exists, so it cannot be skipped. -->
            <form v-if="setupRequired" aria-label="Two-Factor Setup Form" class="pt-3" @submit.prevent="completeSetup">
                <h4 class="mb-2">{{ $t("twoFASetupTitle") }}</h4>
                <p class="setup-help">{{ $t("twoFASetupIntro") }}</p>

                <div class="qr-wrapper my-3">
                    <VueQrcode v-if="setupUri" :value="setupUri" type="image/png" :quality="1" />
                </div>

                <details class="manual-secret mb-3">
                    <summary>{{ $t("twoFACannotScan") }}</summary>
                    <code class="secret-text">{{ manualSecret }}</code>
                </details>

                <div class="form-floating">
                    <input
                        id="setup-otp"
                        ref="setupOtpInput"
                        v-model="token"
                        type="text"
                        inputmode="numeric"
                        maxlength="6"
                        class="form-control"
                        placeholder="123456"
                        autocomplete="one-time-code"
                        required
                    />
                    <label for="setup-otp">{{ $t("twoFAEnterCode") }}</label>
                </div>

                <button class="w-100 btn btn-primary mt-3" type="submit" :disabled="processing">
                    {{ $t("twoFAConfirmAndSignIn") }}
                </button>

                <button class="w-100 btn btn-link mt-2" type="button" @click="cancelSetup">
                    {{ $t("Cancel") }}
                </button>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                </div>
            </form>

            <form v-else aria-label="Login Form" class="pt-3" @submit.prevent="submit">
                <div v-if="!tokenRequired" class="form-floating">
                    <input
                        id="floatingInput"
                        v-model="username"
                        type="text"
                        class="form-control"
                        placeholder="Username"
                        autocomplete="username"
                        required
                    />
                    <label for="floatingInput">{{ $t("Username") }}</label>
                </div>

                <div v-if="!tokenRequired" class="form-floating mt-3">
                    <input
                        id="floatingPassword"
                        v-model="password"
                        type="password"
                        class="form-control"
                        placeholder="Password"
                        autocomplete="current-password"
                        required
                    />
                    <label for="floatingPassword">{{ $t("Password") }}</label>
                </div>

                <div v-if="tokenRequired">
                    <div class="form-floating mt-3">
                        <input
                            id="otp"
                            ref="otpInput"
                            v-model="token"
                            type="text"
                            maxlength="6"
                            class="form-control"
                            placeholder="123456"
                            autocomplete="one-time-code"
                            required
                        />
                        <label for="otp">{{ $t("Token") }}</label>
                    </div>
                </div>

                <div class="form-check mb-3 mt-3 d-flex justify-content-center pe-4">
                    <div class="form-check">
                        <input
                            id="remember"
                            v-model="$root.remember"
                            type="checkbox"
                            value="remember-me"
                            class="form-check-input"
                        />

                        <label class="form-check-label" for="remember">
                            {{ $t("Remember me") }}
                        </label>
                    </div>
                </div>
                <button class="w-100 btn btn-primary" type="submit" :disabled="processing">
                    {{ $t("Login") }}
                </button>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                </div>
            </form>
        </div>
    </div>
</template>

<script>
import VueQrcode from "vue-qrcode";

export default {
    components: { VueQrcode },

    data() {
        return {
            processing: false,
            username: "",
            password: "",
            token: "",
            res: null,
            tokenRequired: false,
            setupRequired: false,
            setupUri: "",
        };
    },

    computed: {
        /**
         * The shared secret pulled out of the otpauth URI, for people who
         * cannot scan a QR code.
         * @returns {string} Base32 secret, or an empty string.
         */
        manualSecret() {
            return new URLSearchParams(this.setupUri.split("?")[1] ?? "").get("secret") ?? "";
        },
    },

    watch: {
        tokenRequired(newVal) {
            if (newVal) {
                this.$nextTick(() => {
                    this.$refs.otpInput?.focus();
                });
            }
        },

        setupRequired(newVal) {
            if (newVal) {
                this.$nextTick(() => {
                    this.$refs.setupOtpInput?.focus();
                });
            }
        },
    },

    mounted() {
        document.title += " - Login";

        // A stored token belonging to a user whose 2FA was reset lands here too,
        // so enrolment is unavoidable however they arrive.
        this.$root.emitter.on("setup2FARequired", this.onSetupRequired);
    },

    unmounted() {
        document.title = document.title.replace(" - Login", "");
        this.$root.emitter.off("setup2FARequired", this.onSetupRequired);
    },

    methods: {
        /**
         * Switch the form into enrolment mode.
         * @param {string} uri otpauth URI from the server.
         * @returns {void}
         */
        onSetupRequired(uri) {
            this.setupUri = uri;
            this.setupRequired = true;
            this.token = "";
            this.res = null;
        },

        /**
         * Submit the user details and attempt to log in
         * @returns {void}
         */
        submit() {
            this.processing = true;

            this.$root.login(this.username, this.password, this.token, (res) => {
                this.processing = false;

                if (res.setup2FARequired) {
                    this.onSetupRequired(res.uri);
                } else if (res.tokenRequired) {
                    this.tokenRequired = true;
                } else {
                    this.res = res;
                }
            });
        },

        /**
         * Confirm the first authenticator code, which enables 2FA and signs in.
         * @returns {void}
         */
        completeSetup() {
            this.processing = true;

            this.$root.completeTwoFASetup(this.token, (res) => {
                this.processing = false;
                this.res = res;
                if (!res.ok) {
                    this.token = "";
                }
            });
        },

        /**
         * Abandon enrolment and go back to the password form.
         *
         * Nothing is enabled server-side until a code is confirmed, so the
         * account is left exactly as it was.
         * @returns {void}
         */
        cancelSetup() {
            this.setupRequired = false;
            this.setupUri = "";
            this.token = "";
            this.password = "";
            this.res = null;
        },
    },
};
</script>

<style lang="scss" scoped>
.form-container {
    display: flex;
    align-items: center;
    padding-top: 40px;
    padding-bottom: 40px;
}

.form-floating {
    > label {
        padding-left: 1.3rem;
    }

    > .form-control {
        padding-left: 1.3rem;
    }
}

.form {
    width: 100%;
    max-width: 330px;
    padding: 15px;
    margin: auto;
    text-align: center;
}

.setup-help {
    font-size: 14px;
    opacity: 0.8;
    margin-bottom: 0;
}

.qr-wrapper {
    display: flex;
    justify-content: center;

    :deep(img) {
        width: 190px;
        height: 190px;
        background: #fff;
        padding: 8px;
        border-radius: 8px;
    }
}

.manual-secret {
    font-size: 13px;
    text-align: left;

    summary {
        cursor: pointer;
        opacity: 0.8;
    }
}

.secret-text {
    display: block;
    margin-top: 6px;
    word-break: break-all;
    font-size: 12px;
}
</style>
