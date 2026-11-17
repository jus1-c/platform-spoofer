/*
 * Platform Spoof — Shelter port for Dorion.
 * Copyright (c) 2026 SpikeHD and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The upstream plugin patches Discord's webpack module from the top level of the file, which
 * leaves nothing to clean up and fails the whole plugin when the module is not loaded yet.
 * This port starts from onLoad, waits a bounded time, reports why it could not patch instead
 * of throwing, and undoes every hook when it is unloaded.
 */

import { createSpoofer, normalizeClientType } from "./spoof.js";
import { createQuestCompatibility } from "./quests.js";

const { store } = shelter.plugin;
const { Header, HeaderTags, Text, Button, ButtonColors, ButtonSizes, SwitchItem } = shelter.ui;

store.clientType ??= "desktop";
store.desktopQuests ??= false;

const scoped = shelter.plugin.scoped;
const patcher = scoped?.patcher ?? shelter.patcher;
const intercept = scoped?.http?.intercept
    ? (method, filter, callback) => scoped.http.intercept(method, filter, callback)
    : (method, filter, callback) => shelter.http.intercept(method, filter, callback);

const OPTIONS = [
    { value: "desktop", label: "Desktop client" },
    { value: "web", label: "Web" },
    { value: "mobile", label: "Mobile" }
];

const STYLE_ID = "platform-spoof-settings";
const styles = `
.pspoof-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0 4px; }
.pspoof-status { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-muted, #b5bac1); }
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
    patcher
});

const questCompatibility = createQuestCompatibility({ intercept, store });

function spoofStatusLine() {
    const status = spoofer.getStatus();
    if (status.state === "active") return `Identification patched: showing as ${store.clientType}.`;
    if (status.state === "unsupported") return `Cannot spoof on this build: ${status.reason}.`;
    if (status.state === "stopped") return "Spoofing is off.";
    return `Looking for Discord's identification function (${status.reason ?? "starting"}).`;
}

function questStatusLine() {
    const status = questCompatibility.getStatus();
    if (normalizeClientType(store.clientType) !== "desktop") return "Desktop quest identity needs the Desktop selection.";
    if (!status.active) return "Desktop quest identity is off.";
    return `Desktop quest identity: ${status.rewritten} heartbeat(s) rewritten, ${status.untouched} left as they were.`;
}

export function onLoad() {
    applyStyles();
    // Upstream exposed this global; keep it working for plugins or notes that refer to it.
    // @ts-expect-error assigning to window
    window.PlatformSpoof = {
        desktop: "Discord Client",
        web: "Chrome",
        mobile: "Android",
        setSpoof: type => { store.clientType = normalizeClientType(type); }
    };
    void spoofer.start();
    questCompatibility.start();
}

export function onUnload() {
    spoofer.stop();
    questCompatibility.stop();
    if (typeof window !== "undefined" && window.PlatformSpoof?.setSpoof) delete window.PlatformSpoof;
    if (typeof document !== "undefined") document.getElementById(STYLE_ID)?.remove();
}

export function settings() {
    applyStyles();
    return (
        <div>
            <Header tag={HeaderTags.H1}>Client type</Header>
            <div class="pspoof-row">
                {OPTIONS.map(option => (
                    <Button
                        size={ButtonSizes?.SMALL}
                        color={normalizeClientType(store.clientType) === option.value ? ButtonColors?.BRAND : ButtonColors?.SECONDARY}
                        onClick={() => { store.clientType = option.value; }}
                    >
                        {option.label}
                    </Button>
                ))}
            </div>
            <p class="pspoof-status">{spoofStatusLine()}</p>
            <SwitchItem
                value={store.desktopQuests === true}
                onChange={value => { store.desktopQuests = value; }}
                note="Experimental. Rewrites the client identity Discord already attached to quest heartbeats, so desktop quests can recognise this client. It never invents a heartbeat and needs the Desktop selection."
            >
                Desktop quest identity
            </SwitchItem>
            <p class="pspoof-status">{questStatusLine()}</p>
            <Text>
                Spoofing changes how Discord labels this client. It cannot provide game detection,
                so a quest that needs a running game is still out of reach.
            </Text>
        </div>
    );
}
