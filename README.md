# Platform Spoof

Reports this Discord client as a **desktop**, **web** or **mobile** client instead of whatever it
detected. Dorion build of SpikeHD's Platform Spoof Shelter plugin.

## Install

In Dorion, open Discord **User Settings → Shelter → Plugins → Install Plugin** and enter:

```text
https://jus1-c.github.io/platform-spoofer/
```

Shelter fetches `plugin.json` and `plugin.js` from that URL and picks up later builds from it.

## What it actually changes

Discord describes a client with an object that holds `browser`, `os`, `device` and a few build
fields. This plugin patches the function that returns it and swaps one field:

| Selection | Reported as |
|---|---|
| Desktop client | `Discord Client` |
| Web | `Chrome` |
| Mobile | `Android` |

Nothing else in that object is touched, and the object handed back is a copy.

Discord uses two readers of that data: the gateway identification (`getSuperProperties`) and the
HTTP header, which uses a separately cached base64 copy (`getSuperPropertiesBase64`). This plugin
patches the first one, so the platform Discord is told when the client connects changes, while the
`X-Super-Properties` header on individual requests keeps the value Discord computed at startup.

## Why the upstream version fails on Dorion

The upstream file patches a webpack module from the top level of the plugin, at import time:

- if Discord's module is not loaded yet, the plugin throws during load and never starts;
- it looks up one exact export name, so a rename breaks it;
- it installs no cleanup, so the patch outlives the plugin.

Dorion makes the first case the normal one: several runtimes share one webpack chunk, and the
module that holds the function is usually not loaded when a plugin starts. This build searches
every runtime that answers on that chunk, waits up to ten seconds for the module, never runs a
module factory to find it, tells you in the settings why it gave up, and removes the patch on
unload. It no longer needs the `@cumjar/websmack` or `spitroast` packages.

## Settings

One selector and one status line, which describes the state the plugin actually reached:

- `Discord is told this is a <type> client.`
- `Waiting for Discord to finish loading (<reason>).`
- `Cannot spoof on this Discord build: <reason>.`
- `Spoofing is off.`

The line is marked in warning colour when the build refused the patch, so a silent failure cannot
be mistaken for success. The selector updates the moment you pick a value; no reload needed.

`window.PlatformSpoof.status()` in the console returns the same information plus:

- `configured` — the name the setting asks for;
- `reported` — the `browser` value the patched function actually returned the last time Discord
  called it, and `null` until it has run;
- `provider` — which object was patched, e.g. `default.getSuperProperties`.

Reading the status never calls Discord's function. It describes local state only: it cannot prove
what another client sees.

## Limits

- Only the reported platform changes. A real desktop client also exposes APIs this build does not
  have, so a feature that probes for them still sees a web client.
- Discord may fix the platform of a session at login. If a change does not show up, reload and
  check again; the plugin cannot rewrite a session that was already identified.
- The settings line describes local state. It is not proof that another client sees the spoofed
  platform.
- The HTTP header keeps its cached copy (see above), so a request captured in the Network tab can
  still show the original browser after the gateway identity changed.
- This plugin changes a label, not capabilities: game detection, a real stream and a real viewer
  are still out of reach.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run build   # → dist/plugin.json, dist/plugin.js
```

## Publishing

Push to `main`, then set **Settings → Pages → Source** to **GitHub Actions**. The workflow runs the
tests, builds with Lune and publishes `dist/`.

## Credit and licence

Upstream: <https://github.com/SpikeHD/shelter-plugins>, `plugins/platform-spoof/`, GPL-3.0.
See [`UPSTREAM.md`](UPSTREAM.md) for the exact revision and what this port changed.
This repository is GPL-3.0; see [`LICENSE`](LICENSE).
