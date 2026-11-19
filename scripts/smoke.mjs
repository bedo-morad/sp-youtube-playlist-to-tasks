#!/usr/bin/env node
// Offline test of the background half. It loads plugin.js with a fake PluginAPI,
// feeds it a canned playlist in place of the scraper, and walks the same flow the
// panel drives: preview, import, re-import, background check, forget.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = readFileSync(join(ROOT, 'plugin.js'), 'utf8');

const PLAYLIST = {
  playlistId: 'PLtest000001',
  title: 'Test playlist',
  description: 'Good things come in sevens',
  declared: 4,
  truncated: false,
  videos: [
    { videoId: 'vid1', title: 'First video', durationSec: 600, publishedDays: 2200, publishedText: '6 years ago' },
    { videoId: 'vid2', title: 'Second video', durationSec: 300, publishedDays: 365, publishedText: '1 year ago' },
    { videoId: 'vid3', title: 'Private video', durationSec: null, publishedDays: null, publishedText: '' },
    { videoId: 'vid4', title: 'Third video', durationSec: 90, publishedDays: 30, publishedText: '1 month ago' },
  ],
};

let seq = 0;
const tasks = [];
const projects = [{ id: 'P-inbox', title: 'Inbox' }];
const store = new Map();
const clone = (x) => JSON.parse(JSON.stringify(x));

let playlistData = clone(PLAYLIST);
let notifications = 0;
let snacks = 0;

const api = {
  getTasks: async () => clone(tasks),
  getAllProjects: async () => clone(projects),
  addProject: async (data) => {
    const id = 'P' + ++seq;
    projects.push({ id, title: data.title });
    return id;
  },
  addTask: async (data) => {
    const id = 'T' + ++seq;
    tasks.push({
      id,
      title: data.title,
      parentId: data.parentId || null,
      projectId: data.projectId || null,
      timeEstimate: data.timeEstimate || 0,
      attachments: [],
      notes: '',
    });
    return id;
  },
  updateTask: async (id, updates) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) throw new Error('no task ' + id);
    Object.assign(task, clone(updates));
  },
  showSnack: () => {
    snacks++;
  },
  notify: () => {
    notifications++;
  },
  persistDataSynced: async (data, key) => store.set(key || '', data),
  loadSyncedData: async (key) => (store.has(key || '') ? store.get(key || '') : null),
  executeNodeScript: async () => ({ success: true, result: clone(playlistData) }),
  onMessage: (fn) => (api.__handler = fn),
  onReady: (fn) => (api.__ready = fn),
  onUnload: (fn) => (api.__unload = fn),
};

globalThis.PluginAPI = api;
new Function('PluginAPI', SCRIPT)(api);

const send = (msg) => api.__handler(msg);
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label}${detail ? ' | ' + detail : ''}`);
  }
};

await api.__ready();

// ---------- preview ----------

const p1 = await send({ type: 'preview', playlistId: PLAYLIST.playlistId });
check('preview lists every video', p1.videos.length === 4);
check('preview carries durations', p1.videos.filter((v) => v.durationSec).length === 3);
check('preview carries ages', p1.videos[0].publishedDays === 2200);
check('preview carries the description', p1.description === PLAYLIST.description);
check('unavailable video flagged', p1.videos.find((v) => v.videoId === 'vid3').unavailable);
check('no task before the first import', p1.taskId === null);
check('first preview reads YouTube', p1.fromCache === false);

// ---------- first import ----------

const chosen = p1.videos
  .filter((v) => !v.unavailable && v.videoId !== 'vid4')
  .map((v) => ({ videoId: v.videoId, title: v.title, durationSec: v.durationSec }));

const r1 = await send({
  type: 'apply',
  playlistId: PLAYLIST.playlistId,
  playlistTitle: PLAYLIST.title,
  description: PLAYLIST.description,
  videos: chosen,
  title: 'My list',
  projectId: null,
  taskId: null,
  newProject: false,
  withLinks: true,
  withEstimates: true,
  withDescription: true,
  numberTitles: true,
  autoRefresh: true,
  refreshHours: 12,
  knownIds: p1.videos.map((v) => v.videoId),
});
check('apply adds the selected videos', r1.added === 2, JSON.stringify(r1));

const parent = tasks.find((t) => t.id === r1.taskId);
const kids = tasks.filter((t) => t.parentId === r1.taskId);
check('subtask titles are numbered from one', kids.map((k) => k.title).join('|') === '1. First video|2. Second video');
check('task keeps the typed name', parent.title === 'My list');
check('playlist link on the task', parent.attachments.length === 1);
check('subtasks have links', kids.every((k) => k.attachments.length === 1));
check('subtasks have estimates', kids.every((k) => k.timeEstimate > 0));
check('description appended once', parent.notes === PLAYLIST.description, JSON.stringify(parent.notes));

const state = await send({ type: 'state' });
check('registry has one entry', state.entries.length === 1);
check('registry keeps 12 hours', state.entries[0].refreshHours === 12);
check('registry keeps the description flag', state.entries[0].withDescription === true);
check('registry knows the skipped video', (state.entries[0].knownIds || []).includes('vid4'));

// ---------- re-import ----------

const p2 = await send({ type: 'preview', playlistId: PLAYLIST.playlistId });
check('preview finds the existing task', p2.taskId === parent.id);
check('preview marks the two imported videos', p2.videos.filter((v) => v.present).length === 2);
check('second preview uses the cache', p2.fromCache === true);
const forced = await send({ type: 'preview', playlistId: PLAYLIST.playlistId, force: true });
check('forced preview reads YouTube again', forced.fromCache === false);

const realExecute = api.executeNodeScript;
let failedReads = 0;
api.executeNodeScript = async () => {
  failedReads++;
  return { success: false, error: { message: 'Playlist not found (is it public?)' } };
};
let permanentError = null;
try {
  await send({ type: 'preview', playlistId: PLAYLIST.playlistId, force: true });
} catch (e) {
  permanentError = e;
}
api.executeNodeScript = realExecute;
check(
  'a 404 fails on the first attempt',
  failedReads === 1 && String(permanentError && permanentError.message).startsWith('PERMANENT: '),
);

await send({
  type: 'apply',
  playlistId: PLAYLIST.playlistId,
  playlistTitle: PLAYLIST.title,
  description: PLAYLIST.description,
  videos: chosen,
  title: '',
  projectId: null,
  taskId: p2.taskId,
  newProject: false,
  withLinks: true,
  withEstimates: true,
  withDescription: true,
  autoRefresh: true,
  refreshHours: 12,
  knownIds: p2.videos.map((v) => v.videoId),
});
check('second apply adds nothing', tasks.filter((t) => t.parentId === parent.id).length === 2);
check('notes are not repeated', parent.notes === PLAYLIST.description, JSON.stringify(parent.notes));

// ---------- background check ----------

playlistData = clone(PLAYLIST);
playlistData.videos.push({
  videoId: 'vid5',
  title: 'Brand new video',
  durationSec: 120,
  publishedDays: 0.1,
  publishedText: '2 hours ago',
});

// Pretend the window is behind another app, which should raise a system
// notification instead of a snackbar.
globalThis.document = { hasFocus: () => false };
const checkNow = await send({ type: 'checkNow' });
delete globalThis.document;

check('check now adds only the new video', checkNow.added === 1, JSON.stringify(checkNow));
const fresh = tasks.find((t) => t.parentId === parent.id && t.title === 'Brand new video');
check('new video got an estimate', fresh && fresh.timeEstimate === 120000);
check('unfocused window gets a notification', notifications === 1 && snacks === 0);

// Same check with the window in front: a snackbar, no notification.
playlistData.videos.push({
  videoId: 'vid6',
  title: 'Another new video',
  durationSec: 60,
  publishedDays: 0.05,
  publishedText: '1 hour ago',
});
globalThis.document = { hasFocus: () => true };
const checkVisible = await send({ type: 'checkNow' });
delete globalThis.document;
check('focused window gets a snackbar', checkVisible.added === 1 && snacks === 1 && notifications === 1);

const after = await send({ type: 'state' });
check('last check recorded', after.entries[0].lastChecked > 0);

// ---------- forget ----------

const forgotten = await send({ type: 'forget', playlistId: PLAYLIST.playlistId });
const empty = await send({ type: 'state' });
check('forget clears the entry', forgotten.ok === true && empty.entries.length === 0);

if (api.__unload) api.__unload();

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('ok   preview, import, re-import, background check and forget');
process.exit(0);
