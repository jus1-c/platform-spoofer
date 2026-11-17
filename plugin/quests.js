/*
 * Desktop identity for Discord quest requests.
 * Copyright (c) 2026 SpikeHD and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Discord decides whether a client may take part in a desktop quest from the identity on the
 * request. This layer only rewrites the identity that Discord itself already attached to a
 * quest heartbeat: it never builds a request, adds a header that was not there, changes a
 * body, or retries. When anything is not exactly as expected the request is left alone, so a
 * refused heartbeat looks exactly like it does without this plugin.
 */

import { normalizeClientType, rewritePlatform } from "./spoof.js";

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const RELATIVE_HEARTBEAT = /^\/quests\/\d+\/heartbeat$/;
const ABSOLUTE_HEARTBEAT = /^\/api\/v\d+\/quests\/\d+\/heartbeat$/;
const SUPER_PROPERTIES = "x-super-properties";

function decodeBase64(value) {
    if (typeof atob === "function") {
        const binary = atob(value);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder().decode(bytes);
    }
    return Buffer.from(value, "base64").toString("utf8");
}

function encodeBase64(text) {
    if (typeof btoa === "function") {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }
    return Buffer.from(text, "utf8").toString("base64");
}

/** True only for the quest heartbeat endpoint, on Discord, over https. */
export function isQuestHeartbeatUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return false;
    const withoutQuery = rawUrl.replace(/[?#].*$/s, "");
    if (withoutQuery.startsWith("/")) return RELATIVE_HEARTBEAT.test(withoutQuery);

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (!DISCORD_HOSTS.has(url.hostname)) return false;
    return ABSOLUTE_HEARTBEAT.test(url.pathname);
}

function headerKey(headers, wanted) {
    if (!headers || typeof headers !== "object") return null;
    return Object.keys(headers).find(key => key.toLowerCase() === wanted) ?? null;
}

/**
 * Rewrites the identity Discord attached, and only that. Returns null whenever the request
 * should be passed through untouched.
 */
export function planQuestRequest(
    { url, method = "POST", headers } = {},
    { enabled = false, clientType = "desktop" } = {}
) {
    if (enabled !== true) return null;
    if (normalizeClientType(clientType) !== "desktop") return null;
    if (String(method).toUpperCase() !== "POST") return null;
    if (!isQuestHeartbeatUrl(url)) return null;

    const key = headerKey(headers, SUPER_PROPERTIES);
    if (!key) return null;
    if (typeof headers[key] !== "string" || !headers[key]) return null;

    let properties;
    try {
        properties = JSON.parse(decodeBase64(headers[key]));
    } catch {
        return null;
    }
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;

    const rewritten = rewritePlatform(properties, clientType);
    if (rewritten === properties) return null;

    let encoded;
    try {
        encoded = encodeBase64(JSON.stringify(rewritten));
    } catch {
        return null;
    }
    return { headers: { ...headers, [key]: encoded } };
}

/**
 * Installs one interceptor for quest heartbeats. `intercept` is Shelter's http interceptor,
 * so the request keeps Discord's own authentication and transport.
 */
export function createQuestCompatibility({ intercept, store } = {}) {
    if (typeof intercept !== "function") throw new Error("An http interceptor is required");

    let dispose = null;
    let rewritten = 0;
    let untouched = 0;

    function start() {
        if (dispose) return;
        const off = intercept("post", isQuestHeartbeatUrl, async (request, send) => {
            const plan = planQuestRequest(request, {
                enabled: store?.desktopQuests === true,
                clientType: store?.clientType
            });
            if (!plan) {
                untouched++;
                return send(request);
            }
            rewritten++;
            return send({ ...request, headers: plan.headers });
        });
        dispose = typeof off === "function" ? off : () => { };
    }

    function stop() {
        if (!dispose) return;
        try { dispose(); } catch { }
        dispose = null;
    }

    return {
        start,
        stop,
        getStatus: () => ({ active: Boolean(dispose), rewritten, untouched })
    };
}
