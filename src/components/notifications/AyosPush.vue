<template>
    <div class="mb-3">
        <label for="ayospush-api-key" class="form-label">{{ $t("API Key") }}</label>
        <HiddenInput
            id="ayospush-api-key"
            v-model="$parent.notification.ayospushApiKey"
            :required="true"
            autocomplete="new-password"
        ></HiddenInput>
    </div>

    <div class="mb-3">
        <label for="ayospush-api-secret" class="form-label">{{ $t("ayospushApiSecret") }}</label>
        <HiddenInput
            id="ayospush-api-secret"
            v-model="$parent.notification.ayospushApiSecret"
            :required="true"
            autocomplete="new-password"
        ></HiddenInput>
    </div>

    <div class="mb-3">
        <label for="ayospush-phone-number-id" class="form-label">{{ $t("ayospushPhoneNumberId") }}</label>
        <input
            id="ayospush-phone-number-id"
            v-model="$parent.notification.ayospushPhoneNumberId"
            type="text"
            class="form-control"
            required
        />
        <div class="form-text">{{ $t("ayospushPhoneNumberIdDescription") }}</div>
    </div>

    <div class="mb-3">
        <label for="ayospush-template-name" class="form-label">{{ $t("ayospushTemplateName") }}</label>
        <input
            id="ayospush-template-name"
            v-model="$parent.notification.ayospushTemplateName"
            type="text"
            class="form-control"
            required
        />
        <div class="form-text">{{ $t("ayospushTemplateNameDescription") }}</div>
    </div>

    <div class="mb-3">
        <label for="ayospush-recipient-number" class="form-label">{{ $t("ayospushRecipientNumber") }}</label>
        <input
            id="ayospush-recipient-number"
            v-model="$parent.notification.ayospushRecipientNumber"
            type="text"
            class="form-control"
            placeholder="24106000000"
            required
        />
        <div class="form-text">{{ $t("ayospushRecipientNumberDescription") }}</div>
    </div>

    <div class="mb-3">
        <label for="ayospush-api-url" class="form-label">{{ $t("ayospushApiUrl") }}</label>
        <input
            id="ayospush-api-url"
            v-model="$parent.notification.ayospushApiUrl"
            type="url"
            class="form-control"
            pattern="https?://.+"
        />
        <div class="form-text">{{ $t("ayospushApiUrlDescription") }}</div>
    </div>
</template>

<script>
import HiddenInput from "../HiddenInput.vue";

export default {
    components: {
        HiddenInput,
    },
    mounted() {
        if (typeof this.$parent.notification.ayospushApiUrl === "undefined") {
            this.$parent.notification.ayospushApiUrl = "https://ayospush.com/api/v1";
        }
    },
};
</script>
