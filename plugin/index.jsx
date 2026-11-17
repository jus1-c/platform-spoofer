/*
 * Platform Spoof — Dorion build of a Shelter plugin.
 * Copyright (c) 2026 SpikeHD and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The upstream plugin patches Discord's webpack module from the top level of the file, which
 * leaves nothing to clean up and fails the whole plugin when the module is not loaded yet.
 * This port starts from onLoad, waits a bounded time, reports why it could not patch instead
 * of throwing, and undoes every hook when it is unloaded.
 */

import { createSpoofer, normalizeClientType } from "./spoof.js";

const { store } = shelter.plugin;
const { Select, SelectOption } = shelter.ui;

store.clientType ??= "desktop";

const scoped = shelter.plugin.scoped;
const patcher = scoped?.patcher ?? shelter.patcher;

// Settings must repaint the moment a choice changes, so the selected type and the patch state
// live in signals instead of being read from the mutable store during render.
const createSignal = shelter.solid?.createSignal ?? (initial => {
    let value = initial;
    return [() => value, next => { value = next; }];
});

const [clientType, setClientType] = createSignal(normalizeClientType(store.clientType));
const [status, setStatus] = createSignal({ state: "idle", reason: null });

const STYLE_ID = "platform-spoof-settings";
const styles = `
.pspoof-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.pspoof-label { font-size: 14px; font-weight: 500; color: var(--text-normal, #dbdee1); }
.pspoof-note { margin: 0; font-size: 12px; line-height: 1.45; color: var(--text-muted, #b5bac1); }
.pspoof-warning { color: var(--text-warning, #f0b232); }
`;

function applyStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const element = document.createElement("style");
    element.id = STYLE_ID;
    element.textContent = styles;
    document.head.append(element);
}

const spoofer = createSpoofer({
    scope: typeof window !== "undefined" ? window : {},
    store,
    patcher,
    onStatus: next => setStatus(next)
});

function statusText(current, type) {
    if (current.state === "active") return `Discord is told this is a ${type} client.`;
    if (current.state === "unsupported") return `Cannot spoof on this Discord build: ${current.reason}.`;
    if (current.state === "stopped") return "Spoofing is off.";
    if (current.state === "waiting") return `Waiting for Discord to finish loading (${current.reason ?? "starting"}).`;
    return "Not started.";
}

export function onLoad() {
    applyStyles();
    // Upstream exposed this global; keep it working for anything that refers to it.
    // @ts-expect-error assigning to window
    window.PlatformSpoof = {
        desktop: "Discord Client",
        web: "Chrome",
        mobile: "Android",
        setSpoof: type => { store.clientType = normalizeClientType(type); setClientType(store.clientType); }
    };
    void spoofer.start();
}

export function onUnload() {
    spoofer.stop();
    if (typeof window !== "undefined" && window.PlatformSpoof?.setSpoof) delete window.PlatformSpoof;
    if (typeof document !== "undefined") document.getElementById(STYLE_ID)?.remove();
}

export function settings() {
    applyStyles();
    // Every signal read happens inside the JSX on purpose: Solid only tracks a dependency that
    // is read while rendering, so a value read here first would freeze the panel until re-entry.
    return (
        <div>
            <div class="pspoof-field">
                <label class="pspoof-label" for="pspoof-client-type">Client type</label>
                <Select
                    value={clientType()}
                    aria-label="Client type"
                    onChange={value => {
                        store.clientType = normalizeClientType(value);
                        setClientType(store.clientType);
                    }}
                >
                    <SelectOption value="desktop">Desktop client</SelectOption>
                    <SelectOption value="web">Web</SelectOption>
                    <SelectOption value="mobile">Mobile</SelectOption>
                </Select>
                <p class={status().state === "unsupported" ? "pspoof-note pspoof-warning" : "pspoof-note"}>
                    {statusText(status(), clientType())}
                </p>
            </div>
            <p class="pspoof-note">
                Only the reported platform changes: game detection, a real stream and a real viewer
                cannot be spoofed.
            </p>
        </div>
    );
}
