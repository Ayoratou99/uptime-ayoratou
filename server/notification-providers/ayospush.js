const NotificationProvider = require("./notification-provider");
const axios = require("axios");

/**
 * Cached AyosPush bearer tokens, keyed by "apiUrl|apiKey".
 *
 * AyosPush issues a JWT valid for about an hour. Notification providers are
 * instantiated once at startup and reused, so caching here avoids a login
 * round-trip on every single alert.
 * @type {Map<string, {token: string, expiresAt: number}>}
 */
const tokenCache = new Map();

/** Refresh this long before the token actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Fallback lifetime when the API does not report one. */
const TOKEN_DEFAULT_TTL_SECONDS = 3600;

class AyosPush extends NotificationProvider {
    name = "AyosPush";

    /**
     * @inheritdoc
     */
    async send(notification, msg, monitorJSON = null, heartbeatJSON = null) {
        const okMsg = "Sent Successfully.";
        const apiUrl = AyosPush.normaliseApiUrl(notification.ayospushApiUrl);

        try {
            const token = await this.getToken(notification, apiUrl);
            await this.sendTemplate(notification, apiUrl, token, msg);
            return okMsg;
        } catch (error) {
            // A stale cached token surfaces as a 401. Drop it and retry once so a
            // rotated or expired token does not swallow an outage alert.
            if (error?.response?.status === 401) {
                tokenCache.delete(AyosPush.cacheKey(apiUrl, notification.ayospushApiKey));
                const token = await this.getToken(notification, apiUrl);
                await this.sendTemplate(notification, apiUrl, token, msg);
                return okMsg;
            }
            this.throwGeneralAxiosError(error);
        }
    }

    /**
     * Post the approved WhatsApp template to a recipient.
     * @param {BeanModel} notification Notification configuration.
     * @param {string} apiUrl Base API URL without a trailing slash.
     * @param {string} token Bearer token.
     * @param {string} msg Message body, passed as template variable {{1}}.
     * @returns {Promise<void>}
     * @throws {Error} If AyosPush rejects the send.
     */
    async sendTemplate(notification, apiUrl, token, msg) {
        let config = {
            headers: {
                Authorization: `Bearer ${token}`,
                accept: "application/json",
                "content-type": "multipart/form-data",
            },
        };
        config = this.getAxiosConfigWithProxy(config);

        const data = {
            phone_number_id: notification.ayospushPhoneNumberId,
            // AyosPush expects plain digits, without a leading "+".
            recipient_number: String(notification.ayospushRecipientNumber ?? "").replace(/^\+/, ""),
            template_name: notification.ayospushTemplateName,
            variables: JSON.stringify({ 1: msg }),
        };

        const response = await axios.post(`${apiUrl}/messages/template`, data, config);

        // AyosPush can answer HTTP 200 with { success: false } on a logical
        // failure such as an unapproved template or an invalid number.
        if (response.data && response.data.success === false) {
            throw new Error(response.data.message || "AyosPush rejected the message");
        }
    }

    /**
     * Return a valid bearer token, logging in only when the cache is cold or stale.
     * @param {BeanModel} notification Notification configuration.
     * @param {string} apiUrl Base API URL without a trailing slash.
     * @returns {Promise<string>} Bearer token.
     * @throws {Error} If authentication fails or no token is returned.
     */
    async getToken(notification, apiUrl) {
        const key = AyosPush.cacheKey(apiUrl, notification.ayospushApiKey);
        const cached = tokenCache.get(key);
        if (cached && Date.now() < cached.expiresAt) {
            return cached.token;
        }

        let config = { headers: { "Content-Type": "application/json" } };
        config = this.getAxiosConfigWithProxy(config);

        const response = await axios.post(
            `${apiUrl}/auth/login`,
            {
                api_key: notification.ayospushApiKey,
                api_secret: notification.ayospushApiSecret,
            },
            config
        );

        // The payload is normally wrapped as { success, data: { token, ... } },
        // but accept the flatter shapes the API has also been seen to return.
        const body = response.data ?? {};
        const token = body.data?.token ?? body.data?.access_token ?? body.token ?? body.access_token ?? body.jwt;

        if (!token) {
            throw new Error("AyosPush authentication succeeded but returned no token");
        }

        const ttlMs = (body.data?.expires_in_seconds ?? TOKEN_DEFAULT_TTL_SECONDS) * 1000;
        tokenCache.set(key, {
            token,
            expiresAt: Date.now() + Math.max(ttlMs - TOKEN_REFRESH_MARGIN_MS, 60 * 1000),
        });

        return token;
    }

    /**
     * Build the token cache key.
     * @param {string} apiUrl Base API URL.
     * @param {string} apiKey API key.
     * @returns {string} Cache key.
     */
    static cacheKey(apiUrl, apiKey) {
        return `${apiUrl}|${apiKey}`;
    }

    /**
     * Normalise the configured API URL, applying the default and trimming any
     * trailing slash so path joining stays predictable.
     * @param {string} apiUrl Configured URL, possibly blank.
     * @returns {string} Usable base URL.
     */
    static normaliseApiUrl(apiUrl) {
        const url = (apiUrl || "https://ayospush.com/api/v1").trim();
        return url.endsWith("/") ? url.slice(0, -1) : url;
    }
}

module.exports = AyosPush;
