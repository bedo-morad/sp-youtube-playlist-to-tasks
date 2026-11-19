# YouTube Playlist to Tasks for Super Productivity

[![CI](https://github.com/bedo-morad/sp-youtube-playlist-to-tasks/actions/workflows/ci.yml/badge.svg)](https://github.com/bedo-morad/sp-youtube-playlist-to-tasks/actions/workflows/ci.yml)

A Super Productivity plugin. Paste a playlist, look through its videos, then import the ones
you want. Every video becomes a subtask with its own link, and the playlist link goes on the
main task.

```
Task:      Top N Lists                 Links: youtube.com/playlist?list=PL…
  Subtask: 7 Database Paradigms        Links: youtube.com/watch?v=W2Z7…
  Subtask: 7 Developer Tools           Links: youtube.com/watch?v=U_gA…
```

## Install

1. Run `npm run build`, or zip `manifest.json`, `plugin.js`, `index.html` and `icon.svg`
   yourself.
2. In the app, go to Settings, then Plugins, then Choose Plugin File, and pick `plugin.zip`.
3. Open the plugin from the plugin menu.
4. The first import asks the operating system to allow node execution for this plugin.
   YouTube sends no CORS headers, so the app reads the playlist page from the main process.
   Allow it once per device.
5. Paste a link, or just the playlist ID (`PL0vfts4VzfNg…`), then press Fetch.

Needs the Electron desktop app and Super Productivity 19.3.1 or newer.

## The preview

Nothing is written until you press the button at the bottom of the list. The panel shows what
the playlist holds:

- videos already in the task are marked "in task" and cannot be selected again;
- videos YouTube reports as private or deleted are greyed out and skipped;
- the total running time sits above the list, and each row shows its own length and age;
- the All circle selects or clears every selectable row in the list;
- the search box filters titles, and the All circle follows the rows you can see;
- the last scrape is kept for five minutes, and Refresh reads from YouTube again;
- a failed read is retried twice, with the attempt shown in the status line.

## Options

Only Attach links and Add new videos to the existing task are on by default. The rest live
under Options in the form.

- Attach links puts the playlist link on the task and each video link on its subtask. Turn it
  off if you only want the task structure.
- Set time estimates from video lengths gives each subtask its video's duration. The main task
  gets none, so the total is not counted twice. The durations come with the playlist response,
  so this adds no extra requests.
- Put the playlist description in the task notes appends the description once, below whatever
  is already there. Re-importing does not repeat it.
- Subtask order matches YouTube by default. Oldest first sorts by the age YouTube prints on
  each row. That age is relative ("6 years ago"), so videos of the same age keep their playlist
  order.
- Number the subtask titles adds `1. `, `2. ` and so on to the titles this import creates. The
  order you picked decides the numbers, and existing subtasks keep their titles.
- Create a project named after the playlist puts the task in a new project instead of the one
  you picked. It helps with course playlists, and is unavailable when you are updating an
  existing task since a task cannot be moved from the panel.
- Check for new videos stores the playlist in plugin data and runs a background check every 1
  to 168 hours. The default is 24, described below.
- Add new videos to the existing task is on by default. Turn it off to make a second task from
  the same playlist; the panel warns you when a task already exists.

## Importing the same playlist again

With updating on, the plugin finds the task by its playlist link, or through its stored
registry when links are off. It adds only videos that are not subtasks yet. Subtask order and
completed states stay as they are, and a video you removed from the task is not added back.
Typing a task name renames the existing task.

## Automatic checks

The plugin's background half starts a check 15 seconds after it loads, then looks for due
playlists every 10 minutes. Each watched playlist keeps its own interval, so a daily playlist
and a weekly one can live side by side.

A check adds only videos that were not in the playlist when you last imported it. Videos you
left out stay out. Background reads retry silently, and a check that keeps failing reports the
error in the panel. When a check finds something, it shows a snackbar if the app window has
focus and a system notification if it does not.

The panel lists watched playlists with their interval, a Check now button and a Stop button. If
a check fails, the row says so and the next attempt waits one full interval.

## Limits

Unlisted playlists work when the link works. Private playlists do not, since YouTube has no
anonymous way to read them. A playlist is capped at 5,000 videos and the panel says when it
hits that. A YouTube Mix (`list=RD…`) never ends, so it fills to the cap.

## If links do not appear

Links are written with `updateTask(id, { attachments })`, then read back to confirm the write.
If a future app version drops that field, the panel says so and writes the playlist and video
links into the task notes instead.

## Working on the plugin

```
manifest.json        metadata, permissions, node execution timeout
plugin.js            background half: scraping, task writes, refresh timer
index.html           the panel: form, preview list, watched list
icon.svg             the plugin icon
scripts/pack.mjs     builds plugin.zip
scripts/check.mjs    manifest and syntax checks
scripts/smoke.mjs    offline test of plugin.js against a fake host
CONTEXT.md           the words this project uses
```

`npm test` runs the static checks and the offline flow. `npm run build` runs both and packs
`plugin.zip`. There are no dependencies, so `npm install` is not needed.

The panel and the background half talk over the plugin message channel: the panel posts
`PLUGIN_MESSAGE` to its parent, and `plugin.js` answers through `api.onMessage`. Everything
that touches the network or writes tasks lives in `plugin.js`, which is why the timer keeps
working with the panel closed.

The scraper is a template literal inside `plugin.js` and is passed to
`PluginAPI.executeNodeScript`. Its `require('https')` is what makes the host run it in a real
Node process instead of the fs/path/os sandbox. To follow YouTube layout changes, start from
`videosIn`, `durationOf` and `tokensIn` in that string.

To watch the panel while you work, open the plugin in the app, then DevTools (F12). The panel
is an iframe, so pick it in the DevTools frame selector to see its console.

## Releasing

1. Set the `version` field in `package.json` and `manifest.json` to the same value, and commit
   that change by itself.
2. Push a tag named `v` followed by that version, for example `v1.3.1`. Add a dash for a
   prerelease, such as `v1.4.0-beta.1`.
3. The release workflow checks the tag against both version fields, runs the tests, builds the
   zip on Node 22, and publishes the release with a versioned zip, its sha256 and the commit
   notes since the previous tag.

The `main` branch and `v*` tags are protected. `main` takes only pull requests with one review
and a passing CI run, so use a branch for changes. Only the repository owner can create release
tags.

## Privacy

The plugin talks only to `www.youtube.com`, and only about the playlist you give it. It sends
nothing about your tasks anywhere and stores no credentials. A watched playlist stops checking
quietly once its task is deleted.
