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
    const cache = {};
    exportsList.forEach((exports, index) => { cache[index] = { id: index, loaded: true, exports }; });
    const require = module => module;
    require.c = cache;
    const chunk = [];
    chunk.push = function (bundle) {
        const runtime = bundle?.[2];
        if (typeof runtime === "function") runtime(require);
        return Array.prototype.push.call(this, bundle);
    };
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
    const { findSuperPropertiesProvider, grabRequire } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const scope = fakeScope([{ unrelated: () => { } }, behaviour]);
    const require = grabRequire(scope, "webpackChunkdiscord_app");

    const provider = findSuperPropertiesProvider(require);
    assert.equal(provider.parent, behaviour);
    assert.equal(provider.name, "getSuperProperties");
    assert.equal(typeof behaviour.getSuperProperties, "function");
});

test("a provider nested one level deep is still found", async () => {
    const { findSuperPropertiesProvider, grabRequire } = await loadSpoof();
    const behaviour = { getSuperProperties: () => ({ browser: "Chrome" }) };
    const scope = fakeScope([{ analytics: behaviour }]);
    const provider = findSuperPropertiesProvider(grabRequire(scope, "webpackChunkdiscord_app"));
    assert.equal(provider.parent, behaviour);
});

test("a missing chunk or require yields no provider instead of throwing", async () => {
    const { findSuperPropertiesProvider, findWebpackChunk, grabRequire } = await loadSpoof();
    assert.equal(findWebpackChunk({}), null);
    assert.equal(findWebpackChunk(undefined), null);
    assert.equal(grabRequire({}, "webpackChunkdiscord_app"), null);
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

test("a spoofer without a patcher is rejected up front", async () => {
    const { createSpoofer } = await loadSpoof();
    assert.throws(() => createSpoofer({ scope: {}, store: {}, patcher: undefined }), /patcher/);
});
