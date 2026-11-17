import assert from "node:assert/strict";
import test from "node:test";

async function loadSpoof() {
    try {
        return await import("../plugin/spoof.js");
    } catch (error) {
        if (error.code === "ERR_MODULE_NOT_FOUND") assert.fail("Platform spoof core is not implemented");
        throw error;
    }
}

/** A window-like scope with a webpack chunk that hands out a require with a module cache. */
function fakeScope(exportsList, { chunkName = "webpackChunkdiscord_app" } = {}) {
    return chainedScope([exportsList], { chunkName });
}

/**
 * Discord installs one runtime per entry bundle (app, wasm, sentry) and every runtime wraps the
 * chunk's push, so one push reaches all of them. Installed first runs last.
 */
function chainedScope(runtimes, { chunkName = "webpackChunkdiscord_app" } = {}) {
    const chunk = [];
    for (const runtime of runtimes) {
        const cache = {};
        (runtime.cache ?? runtime).forEach((exports, index) => {
            cache[index] = { id: index, loaded: true, exports };
        });
        const require = runtime.require ?? (module => module);
        require.c = cache;
        require.m = runtime.factories ?? {};
        const parentPush = chunk.push.bind(chunk);
        chunk.push = function (bundle) {
            bundle?.[2]?.(require);
            return parentPush(bundle);
        };
    }
    return { [chunkName]: chunk };
}

function fakePatcher() {
    const patches = [];
    return {
        patches,
        after(name, parent, callback) {
            const original = parent[name];
            const wrapped = function (...args) {
                return callback(args, original.apply(this, args));
            };
            parent[name] = wrapped;
            patches.push({ name, parent, original });
            return () => { parent[name] = original; };
        }
    };
}

function fakeTimers() {
    const pending = new Map();
    let nextId = 1;
    return {
        pending,
        setTimeout(fn, ms) {
            const id = nextId++;
            pending.set(id, { fn, ms });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        runAll() {
            const entries = [...pending];
            pending.clear();
            for (const [, { fn }] of entries) fn();
        },
        get size() {
            return pending.size;
        }
    };
}

test("each client type maps to the name Discord expects", async () => {
    const { browserFor, normalizeClientType } = await loadSpoof();
    assert.equal(browserFor("desktop"), "Discord Client");
    assert.equal(browserFor("web"), "Chrome");
    assert.equal(browserFor("mobile"), "Android");
    assert.equal(normalizeClientType("web"), "web");
    assert.equal(normalizeClientType("mobile"), "mobile");
    assert.equal(normalizeClientType("nonsense"), "desktop");
    assert.equal(normalizeClientType(undefined), "desktop");
});

test("only the browser field changes and the input is left intact", async () => {
    const { rewritePlatform } = await loadSpoof();
    const original = { os: "Windows", browser: "Chrome", client_version: "1.0.9175", device: "" };
    const rewritten = rewritePlatform(original, "desktop");

    assert.notEqual(rewritten, original);
    assert.deepEqual(rewritten, { os: "Windows", browser: "Discord Client", client_version: "1.0.9175", device: "" });
    assert.equal(original.browser, "Chrome");
});

test("a rewritten value that is already correct is returned as it was", async () => {
    const { rewritePlatform } = await loadSpoof();
    const properties = { browser: "Discord Client" };
    assert.equal(rewritePlatform(properties, "desktop"), properties);
});

test("values that are not a properties object are returned untouched", async () => {
    const { rewritePlatform } = await loadSpoof();
    assert.equal(rewritePlatform(undefined, "desktop"), undefined);
    assert.equal(rewritePlatform(null, "web"), null);
    assert.deepEqual(rewritePlatform(["browser"], "web"), ["browser"]);
});

test("the provider is found in a module cache entry", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const scope = fakeScope([{ unrelated: () => { } }, behaviour]);

    const provider = findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]);
    assert.equal(provider.parent, behaviour);
    assert.equal(provider.name, "getSuperProperties");
    assert.equal(typeof behaviour.getSuperProperties, "function");
});

test("a provider nested one level deep is still found", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const scope = fakeScope([{ analytics: behaviour }]);
    const provider = findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]);
    assert.equal(provider.parent, behaviour);
});

test("one push reaches every installed runtime, and only the app one holds the provider", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const analytics = { getSuperProperties: () => ({ browser: "Edge" }) };
    // Dorion's page installs several runtimes: the wasm/polyfill one first, the app one last.
    const scope = chainedScope([
        { cache: Array.from({ length: 102 }, () => ({})) },
        { cache: [{ default: analytics }] }
    ]);

    const requires = grabRequires(scope, "webpackChunkdiscord_app");
    assert.equal(requires.length, 2);
    assert.deepEqual(requires.map(require => Object.keys(require.c).length), [1, 102]);

    const found = requires.map(require => findSuperPropertiesProvider(require)).find(Boolean);
    assert.equal(found.parent, analytics);
});

test("the order the runtimes were installed in does not matter", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const analytics = { getSuperProperties: () => ({ browser: "Edge" }) };
    const scope = chainedScope([
        { cache: [{ default: analytics }] },
        { cache: Array.from({ length: 102 }, () => ({})) }
    ]);

    const found = grabRequires(scope, "webpackChunkdiscord_app")
        .map(require => findSuperPropertiesProvider(require)).find(Boolean);
    assert.equal(found.parent, analytics);
});

test("looking for the provider never runs a module factory and leaves the chunk as it was", async () => {
    const { grabRequires } = await loadSpoof();
    let executed = 0;
    const scope = chainedScope([
        { cache: [{}], factories: { 1: () => { executed++; } } },
        { cache: [{ default: { getSuperProperties: () => ({}) } }], factories: { 2: () => { executed++; } } }
    ]);
    const chunk = scope.webpackChunkdiscord_app;
    const before = chunk.length;

    const requires = grabRequires(scope, "webpackChunkdiscord_app");

    assert.equal(requires.length, 2);
    assert.equal(executed, 0);
    assert.equal(chunk.length, before);
});

test("the object the gateway identifies with is preferred over a namespace getter", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const namespaceCopy = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const gatewayObject = { getSuperProperties: () => ({ browser: "Edge" }) };
    const scope = fakeScope([namespaceCopy, { default: gatewayObject }]);

    const provider = findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]);
    assert.equal(provider.parent, gatewayObject);
});

test("an object that answers every property name is not mistaken for the provider", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    // Discord's message catalog behaves like this: any name returns a function.
    const catalog = new Proxy({}, {
        get: () => () => "missing message",
        getOwnPropertyDescriptor: () => undefined,
        has: () => false
    });
    const scope = fakeScope([{ messages: catalog }]);

    assert.equal(findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]), null);
});

test("a catalog that creates a property when it is asked for one is not patched", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const warnings = [];
    // Copied from Discord's makeMessagesProxy: reading any name, or asking whether it is an
    // own property, creates a function on the target. A key snapshot must come first.
    const target = {};
    const message = key => locale => { warnings.push({ key, locale }); return { fallback: true }; };
    const catalog = new Proxy(target, {
        ownKeys: value => Reflect.ownKeys(value),
        getOwnPropertyDescriptor(value, key) {
            value[key] || (value[key] = message(key));
            return Reflect.getOwnPropertyDescriptor(value, key);
        },
        get(value, key) {
            if (key === "$$typeof") return "object";
            if (key === Symbol.toStringTag) return "IntlMessagesProxy";
            value[key] || (value[key] = message(key));
            return value[key];
        }
    });
    const analytics = { getSuperProperties: () => ({ browser: "Edge" }) };
    const scope = fakeScope([{ default: catalog }, { default: analytics }]);

    const provider = findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]);

    assert.equal(provider.parent, analytics);
    assert.deepEqual(Reflect.ownKeys(target), []);
    assert.deepEqual(warnings, []);
});

test("a catalog that has already been probed by something else is still skipped", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const target = {};
    const catalog = new Proxy(target, {
        ownKeys: value => Reflect.ownKeys(value),
        getOwnPropertyDescriptor(value, key) {
            target[key] || (target[key] = () => "message");
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(value, key) {
            if (key === Symbol.toStringTag) return "IntlMessagesProxy";
            target[key] || (target[key] = () => "message");
            return target[key];
        }
    });
    // Another plugin probed it first, so the name now really is an own property.
    assert.equal(typeof catalog.getSuperProperties, "function");
    const analytics = { getSuperProperties: () => ({ browser: "Edge" }) };
    const scope = fakeScope([{ default: catalog }, { default: analytics }]);

    const provider = findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]);

    assert.equal(provider.parent, analytics);
});

test("an object without a browser field is left alone instead of gaining one", async () => {
    const { rewritePlatform } = await loadSpoof();
    const message = { fallback: true };
    assert.equal(rewritePlatform(message, "desktop"), message);

    const withoutBrowser = { os: "Windows" };
    assert.equal(rewritePlatform(withoutBrowser, "desktop"), withoutBrowser);
});

test("status never calls the patched function: it reports the last value it returned", async () => {
    const { createSpoofer } = await loadSpoof();
    let calls = 0;
    const behaviour = {
        getSuperProperties: () => {
            calls++;
            return { os: "Windows", browser: "Chrome" };
        }
    };
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({
        scope: fakeScope([{ default: behaviour }]),
        store: { clientType: "desktop" },
        patcher,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    assert.deepEqual(spoofer.getObserved(), { browser: null, provider: null });

    spoofer.start();
    assert.equal(spoofer.getStatus().state, "active");
    assert.equal(calls, 0);
    assert.deepEqual(spoofer.getObserved(), { browser: null, provider: "default.getSuperProperties" });

    behaviour.getSuperProperties();
    assert.equal(calls, 1);
    assert.deepEqual(spoofer.getObserved(), { browser: "Discord Client", provider: "default.getSuperProperties" });

    // Asking for the status twice must not run Discord's function again.
    spoofer.getObserved();
    spoofer.getObserved();
    assert.equal(calls, 1);

    spoofer.stop();
    assert.deepEqual(spoofer.getObserved(), { browser: null, provider: null });
});

test("a function that only lives on a prototype is not used", async () => {
    const { findSuperPropertiesProvider, grabRequires } = await loadSpoof();
    const provider = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const wrapper = { __proto__: provider };
    const scope = fakeScope([wrapper]);

    assert.equal(findSuperPropertiesProvider(grabRequires(scope, "webpackChunkdiscord_app")[0]), null);
});

test("the spoofer patches the runtime that carries the provider, not the last one to answer", async () => {
    const { createSpoofer } = await loadSpoof();
    const analytics = { getSuperProperties: () => ({ browser: "Edge" }) };
    const scope = chainedScope([
        { cache: Array.from({ length: 102 }, () => ({})) },
        { cache: [{ default: analytics }] }
    ]);
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({
        scope,
        store: { clientType: "desktop" },
        patcher,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    spoofer.start();
    assert.equal(spoofer.getStatus().state, "active");
    assert.equal(analytics.getSuperProperties().browser, "Discord Client");
});

test("a missing chunk or require yields no provider instead of throwing", async () => {
    const { findSuperPropertiesProvider, findWebpackChunk, grabRequires } = await loadSpoof();
    assert.equal(findWebpackChunk({}), null);
    assert.equal(findWebpackChunk(undefined), null);
    assert.deepEqual(grabRequires({}, "webpackChunkdiscord_app"), []);
    assert.deepEqual(grabRequires({ webpackChunkdiscord_app: {} }, "webpackChunkdiscord_app"), []);
    assert.equal(findSuperPropertiesProvider(null), null);
    assert.equal(findSuperPropertiesProvider({}), null);
    assert.equal(findWebpackChunk({ webpackChunkdiscord_app: [] }), "webpackChunkdiscord_app");
});

test("the spoofer patches the provider and rewrites what it returns", async () => {
    const { createSpoofer } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ os: "Windows", browser: "Chrome" }) };
    const scope = fakeScope([behaviour]);
    const store = { clientType: "desktop" };
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({ scope, store, patcher, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });

    spoofer.start();
    assert.equal(spoofer.getStatus().state, "active");
    assert.equal(patcher.patches.length, 1);

    const properties = behaviour.getSuperProperties();
    assert.equal(properties.browser, "Discord Client");
    assert.equal(properties.os, "Windows");

    store.clientType = "mobile";
    assert.equal(behaviour.getSuperProperties().browser, "Android");

    spoofer.stop();
    assert.equal(behaviour.getSuperProperties().browser, "Chrome");
    assert.equal(spoofer.getStatus().state, "stopped");
});

test("a module that appears later is patched after waiting", async () => {
    const { createSpoofer } = await loadSpoof();
    const scope = fakeScope([]);
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const store = { clientType: "desktop" };
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({ scope, store, patcher, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });

    spoofer.start();
    assert.equal(spoofer.getStatus().state, "waiting");
    assert.equal(patcher.patches.length, 0);

    scope.webpackChunkdiscord_app.push = function (bundle) {
        if (typeof bundle[2] === "function") bundle[2](Object.assign(m => m, { c: { 0: { exports: behaviour } } }));
        return 0;
    };
    timers.runAll();

    assert.equal(spoofer.getStatus().state, "active");
    assert.equal(behaviour.getSuperProperties().browser, "Discord Client");
});

test("no provider within the wait window reports unsupported instead of throwing", async () => {
    const { createSpoofer } = await loadSpoof();
    const scope = fakeScope([]);
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const realNow = Date.now;
    let clock = 0;
    Date.now = () => clock;
    try {
        const spoofer = createSpoofer({
            scope,
            store: { clientType: "desktop" },
            patcher,
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            waitMs: 100,
            pollMs: 10
        });
        spoofer.start();
        clock = 500;
        timers.runAll();
        const status = spoofer.getStatus();
        assert.equal(status.state, "unsupported");
        assert.match(status.reason, /identification function/);
        assert.equal(patcher.patches.length, 0);
    } finally {
        Date.now = realNow;
    }
});

test("a page with no webpack chunk at all reports that reason", async () => {
    const { createSpoofer } = await loadSpoof();
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const realNow = Date.now;
    let clock = 0;
    Date.now = () => clock;
    try {
        const spoofer = createSpoofer({
            scope: {},
            store: { clientType: "desktop" },
            patcher,
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            waitMs: 100
        });
        spoofer.start();
        clock = 500;
        timers.runAll();
        assert.match(spoofer.getStatus().reason, /webpack chunk/);
    } finally {
        Date.now = realNow;
    }
});

test("starting twice keeps a single patch", async () => {
    const { createSpoofer } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({
        scope: fakeScope([behaviour]),
        store: { clientType: "desktop" },
        patcher,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    spoofer.start();
    spoofer.start();
    assert.equal(patcher.patches.length, 1);
});

test("stopping while still waiting leaves no timer and no patch behind", async () => {
    const { createSpoofer } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const scope = fakeScope([]);
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const spoofer = createSpoofer({
        scope,
        store: { clientType: "desktop" },
        patcher,
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    spoofer.start();
    assert.equal(timers.size, 1);
    spoofer.stop();
    assert.equal(timers.size, 0);

    // The module turns up after the plugin was switched off: it must stay unpatched.
    scope.webpackChunkdiscord_app.push = function (bundle) {
        if (typeof bundle[2] === "function") bundle[2](Object.assign(m => m, { c: { 0: { exports: behaviour } } }));
        return 0;
    };
    timers.runAll();
    assert.equal(patcher.patches.length, 0);
    assert.equal(behaviour.getSuperProperties().browser, "Chrome");
});

test("a patcher that refuses the module is reported, not thrown", async () => {
    const { createSpoofer } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const timers = fakeTimers();
    const spoofer = createSpoofer({
        scope: fakeScope([behaviour]),
        store: { clientType: "desktop" },
        patcher: {
            after() { throw new Error("frozen module"); }
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    spoofer.start();
    const status = spoofer.getStatus();
    assert.equal(status.state, "unsupported");
    assert.match(status.reason, /frozen module/);
});

test("every state change is announced so the settings can repaint", async () => {
    const { createSpoofer } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const patcher = fakePatcher();
    const timers = fakeTimers();
    const seen = [];
    const spoofer = createSpoofer({
        scope: fakeScope([behaviour]),
        store: { clientType: "desktop" },
        patcher,
        onStatus: next => seen.push(next.state),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout
    });

    spoofer.start();
    spoofer.stop();
    assert.deepEqual(seen, ["waiting", "active", "stopped"]);
});

test("a spoofer without a patcher is rejected up front", async () => {
    const { createSpoofer } = await loadSpoof();
    assert.throws(() => createSpoofer({ scope: {}, store: {}, patcher: undefined }), /patcher/);
});
