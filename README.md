# Platform Spoof — Shelter plugin for Dorion

Makes Discord report this client as a **desktop**, **web** or **mobile** client instead of whatever
it detected. A port of SpikeHD's `platform-spoof` Shelter plugin, rebuilt so it can run on Dorion.

**This is a Shelter plugin for [Dorion](https://github.com/SpikeHD/Dorion), not a Vencord plugin.**
It installs from a URL inside Discord's Shelter settings and runs in the web client Dorion hosts.
It has nothing to do with the Vencord plugin ecosystem, and the upstream Shelter plugin it was
ported from is untouched.

## Install

1. Create a repository from this source and let the `Build and deploy Shelter plugin` workflow run
   (see [Publishing](#publishing)).
2. In Dorion, open Discord **User Settings → Shelter → Plugins → Install Plugin** and enter:

   ```text
   https://<owner>.github.io/<repository>/
   ```

Shelter fetches `plugin.json` and `plugin.js` from that URL and picks up later builds from it.

## What it actually changes

Discord labels a client from the `browser` field of the identification properties it attaches to
its requests. This plugin patches the function that builds them and reports the name you picked:

| Selection | Reported as |
|---|---|
| Desktop client | `Discord Client` |
| Web | `Chrome` |
| Mobile | `Android` |

Nothing else in those properties is touched, and the object handed back is a copy.

## Why the upstream version fails on Dorion

The upstream file patches a webpack module from the top level of the plugin, at import time:

- if Discord's module is not loaded yet, the plugin throws during load and never starts;
- it looks up one exact export name, so a rename breaks it;
- it installs no cleanup, so the patch outlives the plugin.

This port starts from `onLoad`, waits up to ten seconds for the function, tells you in the settings
why it gave up instead of throwing, and removes the patch on unload. It no longer needs the
`@cumjar/websmack` or `spitroast` packages.

## Desktop quest identity (experimental, off by default)

With **Desktop** selected, the switch rewrites the identity Discord already attached to a quest
heartbeat (`POST /quests/<id>/heartbeat`). It never creates a heartbeat, never changes a body,
never retries, and leaves every other request alone — enrollment, opening a quest, claiming a
reward and chat are untouched. If the identity header is not visible at that layer, the request
goes out exactly as Discord built it and the settings line says so.

That switch cannot make game detection work: it changes how the client is labelled, not what it
can prove. A quest that requires a running game is still out of reach.

## Settings and state

The plugin reports what it reached instead of claiming success:

- `Identification patched: showing as <type>.`
- `Looking for Discord's identification function (<reason>).`
- `Cannot spoof on this build: <reason>.`

The quest line does the same with `rewritten` and `untouched` heartbeat counts.

## Limits

- Only the reported platform changes. A real desktop client also exposes APIs this build does not
  have, so a feature that probes for them still sees a web client.
- Discord may fix the platform of a session at login. If a change does not show up, reload and
  check again; the plugin cannot rewrite a session that was already identified.
- The settings line describes local state. It is not proof that another client sees the spoofed
  platform.

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
