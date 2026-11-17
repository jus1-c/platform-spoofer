/*
 * Client platform spoofing for Dorion.
 * Copyright (c) 2026 SpikeHD and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Discord decides which client it is talking to from the `browser` field of its
 * identification properties. The upstream plugin reads that value by patching a webpack
 * module; on Dorion the module is not always there when a plugin loads, so this version
 * waits for it, reports why it gave up instead of throwing, and never touches anything
 * else. A rewritten object is always a copy: the caller's properties are left intact.
 */

const BROWSERS = {
    desktop: "Discord Client",
    web: "Chrome",
    mobile: "Android"
};

/** Anything unexpected falls back to the upstream default instead of guessing. */
export function normalizeClientType(value) {
    return value === "web" || value === "mobile" ? value : "desktop";
}

export function browserFor(clientType) {
    return BROWSERS[normalizeClientType(clientType)];
}

/** Only `browser` changes, so a locale, build number or device field survives untouched. */
export function rewritePlatform(properties, clientType) {
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) return properties;
    const browser = browserFor(clientType);
    if (properties.browser === browser) return properties;
    return { ...properties, browser };
}

/** The webpack chunk Discord pushes its modules into, if the page has one yet. */
export function findWebpackChunk(scope) {
    if (!scope || typeof scope !== "object") return null;
    const names = Object.keys(scope).filter(name => name.startsWith("webpackChunk"));
    return names.find(name => /discord/i.test(name)) ?? names[0] ?? null;
}

/**
 * Borrows webpack's own require out of the chunk without keeping anything: the temporary
 * module is pushed and popped straight away, exactly like the upstream reader does.
 */
export function grabRequire(scope, name) {
    const chunk = scope?.[name];
    if (!chunk || typeof chunk.push !== "function") return null;
    let require = null;
    try {
        chunk.push([[Symbol("platform-spoof")], {}, module => { require = module; }]);
        chunk.pop();
    } catch {
        return null;
    }
    return typeof require === "function" ? require : null;
}

function providerIn(container, seen, depth) {
    if (!container || typeof container !== "object" || depth > 2) return null;
    if (seen.has(container)) return null;
    seen.add(container);
    if (typeof container.getSuperProperties === "function") {
        return { parent: container, name: "getSuperProperties" };
    }
    for (const value of Object.values(container)) {
        if (!value || typeof value !== "object") continue;
        const found = providerIn(value, seen, depth + 1);
        if (found) return found;
    }
    return null;
}

/**
 * Looks for the module that owns the identification function. Only already loaded modules
 * are inspected: forcing every factory to run would add startup work and side effects for
 * a provider that is usually cached already.
 */
export function findSuperPropertiesProvider(require) {
    const cache = require?.c;
    if (!cache || typeof cache !== "object") return null;
    const seen = new WeakSet();
    for (const entry of Object.values(cache)) {
        const found = providerIn(entry?.exports, seen, 0);
        if (found) return found;
    }
    return null;
}

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 250;

/**
 * Installs the patch once the provider exists, and gives up with a reason when it does not.
 * `patcher` is injected so the caller decides between Shelter's scoped and plain patcher.
 */
export function createSpoofer({
    scope,
    store,
    patcher,
    onStatus,
    setTimeout: schedule = setTimeout,
    clearTimeout: cancel = clearTimeout,
    waitMs = DEFAULT_WAIT_MS,
    pollMs = DEFAULT_POLL_MS
} = {}) {
    if (typeof patcher?.after !== "function") throw new Error("A function patcher is required");

    let status = { state: "idle", reason: null };
    let generation = 0;
    let timer = null;
    let unpatch = null;

    function set(next, reason = null) {
        status = { state: next, reason };
        // The settings view reads this, so a change has to be announced rather than polled.
        if (typeof onStatus === "function") onStatus({ ...status });
    }

    function clearTimer() {
        if (timer !== null) {
            cancel(timer);
            timer = null;
        }
    }

    function attach(provider, myGeneration) {
        if (myGeneration !== generation) return;
        try {
            unpatch = patcher.after(provider.name, provider.parent, (args, response) =>
                rewritePlatform(response, store.clientType)
            );
            set("active");
        } catch (error) {
            set("unsupported", `could not patch ${provider.name}: ${error?.message ?? error}`);
        }
    }

    function attempt(myGeneration, deadline) {
        if (myGeneration !== generation) return;
        const chunk = findWebpackChunk(scope);
        if (!chunk) {
            if (Date.now() >= deadline) return set("unsupported", "no webpack chunk was found");
            set("waiting", "waiting for the webpack chunk");
            return retry(myGeneration, deadline);
        }
        const require = grabRequire(scope, chunk);
        if (!require) {
            if (Date.now() >= deadline) return set("unsupported", "the webpack chunk could not be read");
            set("waiting", "waiting for a readable webpack chunk");
            return retry(myGeneration, deadline);
        }
        const provider = findSuperPropertiesProvider(require);
        if (!provider) {
            if (Date.now() >= deadline) return set("unsupported", "the identification function was not found");
            set("waiting", "waiting for the identification function");
            return retry(myGeneration, deadline);
        }
        attach(provider, myGeneration);
    }

    function retry(myGeneration, deadline) {
        clearTimer();
        timer = schedule(() => {
            timer = null;
            attempt(myGeneration, deadline);
        }, pollMs);
    }

    function start() {
        if (status.state === "active") return Promise.resolve(status);
        generation++;
        const myGeneration = generation;
        set("waiting", "starting");
        attempt(myGeneration, Date.now() + waitMs);
        return Promise.resolve(status);
    }

    function stop() {
        generation++;
        clearTimer();
        if (unpatch) {
            try { unpatch(); } catch { }
            unpatch = null;
        }
        set("stopped");
    }

    return {
        start,
        stop,
        getStatus: () => ({ ...status })
    };
}
