/*
 * Client platform spoofing for Dorion.
 * Copyright (c) 2026 SpikeHD and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Discord decides which client it is talking to from the `browser` field of its
 * identification properties. The upstream plugin reads that value by patching a webpack
 * module; on Dorion several runtimes share one chunk and the module is not always loaded
 * when a plugin starts, so this version searches every runtime, waits for the module,
 * reports why it gave up instead of throwing, and never runs a module factory.
 * A rewritten object is always a copy: the caller's properties are left intact.
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
 * Every runtime the page installed on the chunk, in the order they answer. A page can host
 * several (app, wasm, sentry), each wrapping the chunk's push, so one push reaches all of them.
 * Keeping only the last answer loses the app's runtime behind a polyfill loader. The probe entry
 * is removed again in the same call.
 */
export function grabRequires(scope, name) {
    const chunk = scope?.[name];
    if (!chunk || typeof chunk.push !== "function") return [];
    const found = [];
    try {
        chunk.push([[Symbol("platform-spoof")], {}, module => {
            if (typeof module === "function" && !found.includes(module)) found.push(module);
        }]);
    } catch {
        return [];
    } finally {
        try { chunk.pop(); } catch { }
    }
    return found;
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
 * Looks for the module that owns the identification function in one runtime's module cache.
 * The gateway identifies with the analytics object re-exported as `default`, so that object wins;
 * a namespace that merely exposes the same function name is only a fallback.
 */
export function findSuperPropertiesProvider(require) {
    const cache = require?.c;
    if (!cache || typeof cache !== "object") return null;
    const entries = Object.values(cache);
    const seen = new WeakSet();
    for (const entry of entries) {
        const found = providerIn(entry?.exports?.default, seen, 0);
        if (found) return found;
    }
    for (const entry of entries) {
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
    let patched = null;

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
            patched = provider.parent;
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
        const requires = grabRequires(scope, chunk);
        if (!requires.length) {
            if (Date.now() >= deadline) return set("unsupported", "the webpack chunk could not be read");
            set("waiting", "waiting for a readable webpack chunk");
            return retry(myGeneration, deadline);
        }
        let provider = null;
        for (const require of requires) {
            provider = findSuperPropertiesProvider(require);
            if (provider) break;
        }
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
        patched = null;
        set("stopped");
    }

    /**
     * Calls the patched function once, so the settings can show the value Discord will actually
     * send instead of the value the plugin meant to send. This reads; it never sends anything.
     */
    function getBrowser() {
        if (!patched || typeof patched.getSuperProperties !== "function") return null;
        try {
            return patched.getSuperProperties()?.browser ?? null;
        } catch {
            return null;
        }
    }

    return {
        start,
        stop,
        getBrowser,
        getStatus: () => ({ ...status })
    };
}
