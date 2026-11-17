import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

function build(output) {
    execFileSync(process.execPath, [
        "node_modules/@uwu/lune/dist/clibundle.cjs",
        "build",
        "plugin",
        "--to",
        output
    ], { stdio: "pipe" });
}

/** A window whose webpack chunk already holds the identification module. */
function scopeWithProvider(behaviour) {
    const chunk = [];
    chunk.push = function (bundle) {
        if (typeof bundle?.[2] === "function") {
            const require = module => module;
            require.c = { 0: { id: 0, loaded: true, exports: behaviour } };
            bundle[2](require);
        }
        return 0;
    };
    return { webpackChunkDiscord_app: chunk };
}

function patcherRecorder() {
    const patches = [];
    return {
        patches,
        after(name, parent, callback) {
            const original = parent[name];
            parent[name] = function (...args) {
                return callback(args, original.apply(this, args));
            };
            patches.push(name);
            return () => { parent[name] = original; };
        }
    };
}

/** Minimal signal implementation so the settings module can be loaded outside Shelter. */
function createSignal(initial) {
    let value = initial;
    return [() => value, next => { value = next; }];
}

test("Lune builds a Shelter-loadable Platform Spoof bundle", async () => {
    const temporaryRoot = existsSync("/tmp/opencode") ? "/tmp/opencode" : tmpdir();
    const output = mkdtempSync(join(temporaryRoot, "spoofer-build-"));
    try {
        build(output);
        const code = readFileSync(join(output, "plugin.js"), "utf8");
        const manifest = JSON.parse(readFileSync(join(output, "plugin.json"), "utf8"));

        assert.equal(manifest.hash, createHash("md5").update(code).digest("hex"));
        // Shelter shows this text, so it has to say what the build is and where it runs: the
        // upstream plugin is already a Shelter plugin, so this one is the Dorion build of it.
        assert.match(manifest.description, /Dorion/);
        assert.match(manifest.description, /SpikeHD/);
        assert.doesNotMatch(manifest.description, /Shelter port/i);
        // The upstream settings component lives in the source repository, not in the plugin.
        assert.doesNotMatch(code, /RadioGroup/);
        // The plugin only spoofs the reported platform; it does not touch requests.
        assert.doesNotMatch(code, /http\.intercept/);
        assert.doesNotMatch(code, /x-super-properties/i);
        // Settings are a single select, not a row of buttons that can overflow.
        assert.match(code, /pspoof-client-type/);
        // The quest-identity layer was removed; nothing here may look at requests.
        assert.doesNotMatch(code, /desktopQuests/);
        assert.doesNotMatch(code, /SwitchItem/);
        // Solid only tracks reads made while rendering, so the select value must be a getter.
        assert.match(code, /get value\(\) \{\s*return clientType\(\)/);

        const behaviour = { getSuperProperties: () => ({ os: "Windows", browser: "Chrome" }) };
        const patcher = patcherRecorder();
        const shelter = {
            plugin: { store: {}, scoped: { patcher } },
            ui: {},
            solid: { createSignal },
            solidWeb: { template: () => () => ({}), delegateEvents: () => { } },
            patcher
        };
        const plugin = vm.runInNewContext(code, {
            shelter,
            window: scopeWithProvider(behaviour),
            console,
            URL,
            setTimeout,
            clearTimeout,
            navigator: { language: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });

        assert.equal(typeof plugin.onLoad, "function");
        assert.equal(typeof plugin.onUnload, "function");
        assert.equal(typeof plugin.settings, "function");

        plugin.onLoad();
        assert.equal(shelter.plugin.store.clientType, "desktop");
        assert.deepEqual(patcher.patches, ["getSuperProperties"]);
        assert.equal(behaviour.getSuperProperties().browser, "Discord Client");

        plugin.onUnload();
        assert.equal(behaviour.getSuperProperties().browser, "Chrome");
    } finally {
        rmSync(output, { recursive: true, force: true });
    }
});

test("the build script targets this plugin", async () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
    assert.equal(scripts.build, "lune build plugin --to dist");
});
