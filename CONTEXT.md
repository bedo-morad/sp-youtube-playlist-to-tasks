# Context

The words this plugin uses. Keep additions short and specific so the code, the panel copy and
the README stay on the same vocabulary.

## Plugin

A Super Productivity plugin with two halves in one package. `iFrame: true` in the manifest
puts the panel in an iframe and still runs `plugin.js` in the app's renderer.

## Panel

`index.html`. Renders the form, the preview list and the watched list. Holds no network code
and writes no tasks. It asks the background half for everything.

## Background half

`plugin.js`. Scrapes playlists, writes tasks, and runs the refresh timer. It is the only place
that calls `executeNodeScript` or `updateTask`.

## Scraper

The template literal `NODE_SCRIPT` inside `plugin.js`, passed to `executeNodeScript`. Runs in a
spawned Node process because YouTube sends no CORS headers and the renderer fetch would be
blocked. Returns `{ playlistId, title, description, videos, declared, truncated }`.

## Draft

What the panel holds after a fetch and before an import: the playlist title, description, the
video rows with `durationSec` and `present`, and the settings of an existing import if one
exists. Never written to the task store.

## Import

The write that turns a draft into a task. Creates the task if none exists, links the playlist,
and adds one subtask per selected video. Re-imports add only videos that are not subtasks.

## Registry

The plugin's persisted list of imports, stored under the `playlists` key. One entry per
playlist: task id, title, the options used, `refreshHours`, `lastChecked`, and `knownIds`.

## Known videos

Video ids that were in the playlist at import time but were not added, either because the user
left them out or because they were unavailable. The background check never adds a known video,
so a deliberate omission stays omitted.

## Watched playlist

A registry entry with `autoRefresh: true`. The background half checks it every `refreshHours`,
defaulting to 24, and skips entries whose task no longer exists.

## Link state

The result of writing an attachment: `ok` when the reread confirms it, `no-links` when the host
dropped the field, `unverified` when the task list does not expose attachments. `no-links`
falls back to writing the links into the task notes.
