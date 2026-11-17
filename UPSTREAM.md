# Upstream source

Started from the upstream plugin, copied on 2026-11-17:

- Repository: <https://github.com/SpikeHD/shelter-plugins>
- Path: `plugins/platform-spoof/`
- Repo commit: `427391668cdd6df3e2d33354e39cca9a90a0d232`
- `index.tsx` blob: `b9cf97656d083ab70302b5382c5083e706f1de93`

The original file is not part of this repository; it can be read at the upstream commit above.

The upstream plugin is already a Shelter plugin. This repository is the **Dorion build** of it: the
changes below make it load and behave correctly in the web client Dorion hosts. They are not a port
to Shelter, and nothing here is written for Vencord.

## What changed in the port

| Upstream | Here |
| --- | --- |
| `index.tsx`, top-level side effects | `index.jsx` that starts in `onLoad` and stops in `onUnload` |
| Patches at import time, throws when the module is missing | Waits up to 10 s, reports the reason in settings, never throws at load |
| `@cumjar/websmack` + `spitroast` dependencies | Dependency-free discovery plus `shelter.patcher`, so the build has no bundled library |
| Imports `../../components/RadioGroup` from the parent repository | Settings built from `shelter.ui` only |
| `RadioGroup` of three options | One `<Select>` with three options, so long labels cannot overflow the panel |
| Settings read the plain store and only repaint after a re-entry | Selection and patch state live in signals, so a click repaints immediately |
| Oversized `Header` title | A plain label at the same size as the plugin's other fields |
| No cleanup | The patch is removed on unload |
| No tests | `tests/spoof.test.mjs`, `tests/package.test.mjs` |

The `window.PlatformSpoof` global is still created, so anything that refers to it keeps working.

## Not copied

`components/RadioGroup.tsx`, `components/Radio.tsx`, the `Component<…>` global type and the
`*.tsx.scss` handling of that repository's bundler. This port uses `shelter.ui` instead, which is
why the plugin bundle has no other files to load.
