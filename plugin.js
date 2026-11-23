// Host half: everything that touches the network or writes tasks lives here, so the
// auto-refresh timer keeps working while the panel is closed. The panel asks over the
// plugin message channel and renders what it gets back.

const REGISTRY_KEY = 'playlists';
const SCRAPES_KEY = 'scrapes';
const CACHE_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_HOURS = 24;
const MIN_REFRESH_HOURS = 1;
const MAX_REFRESH_HOURS = 168;
const TICK_MS = 10 * 60 * 1000;
const START_DELAY_MS = 15 * 1000;
const MAX_VIDEOS = 5000;
const PLACEHOLDER = /^(private|deleted) video$/i;
const PERMANENT_PREFIX = 'PERMANENT: ';

function markedError(err) {
  const msg = String((err && err.message) || err || 'Could not read the playlist.');
  if (msg.startsWith(PERMANENT_PREFIX)) return err;
  const status = /HTTP\s+(\d{3})/i.exec(msg);
  const code = status ? Number(status[1]) : null;
  const permanent =
    /not found/i.test(msg) ||
    (code !== null && code >= 400 && code < 500 && code !== 429);
  return new Error(permanent ? PERMANENT_PREFIX + msg : msg);
}

const playlistUrl = (id) => 'https://www.youtube.com/playlist?list=' + id;
const videoUrl = (id) => 'https://www.youtube.com/watch?v=' + id;

// Runs in a real Node process (main), not the renderer: YouTube sends no CORS headers,
// so a renderer fetch is blocked. The require('https') also routes it out of the host's
// fs/path/os sandbox into a spawned node.
const NODE_SCRIPT = `
  const https = require('https');

  const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const MAX = ${MAX_VIDEOS};

  const playlistId = String(args[0] || '').trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(playlistId)) {
    throw new Error('Not a valid playlist id: ' + playlistId);
  }

  function get(url, opts) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method: opts.method || 'GET',
          headers: {
            'user-agent': UA,
            'accept-language': 'en-US,en;q=0.9',
            ...(opts.body ? { 'content-type': 'application/json' } : {}),
            ...(opts.headers || {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              resolve(get(new URL(res.headers.location, url).toString(), opts));
              return;
            }
            resolve({ status: res.statusCode, body });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('Network timeout')));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  const text = (n) => {
    if (!n) return '';
    if (typeof n === 'string') return n;
    return (
      n.simpleText ||
      n.content ||
      (n.runs && n.runs.map((r) => r.text).join('')) ||
      ''
    );
  };

  function collect(node, key, out) {
    out = out || [];
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const n of node) collect(n, key, out);
      return out;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (k === key && v && typeof v === 'object') out.push(v);
      else collect(v, key, out);
    }
    return out;
  }

  // "9:53" or "1:02:33" to seconds. "LIVE" and anything else becomes null.
  function toSeconds(raw) {
    const m = /^(\\d+)(?::(\\d{2}))?(?::(\\d{2}))?$/.exec(String(raw || '').trim());
    if (!m || m[2] === undefined) return null;
    if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Number(m[1]) * 60 + Number(m[2]);
  }

  function durationOf(lockup) {
    const badges = [];
    const overlays =
      (lockup.contentImage &&
        lockup.contentImage.thumbnailViewModel &&
        lockup.contentImage.thumbnailViewModel.overlays) ||
      [];
    for (const o of overlays) {
      const list =
        (o.thumbnailBottomOverlayViewModel && o.thumbnailBottomOverlayViewModel.badges) || [];
      for (const b of list) {
        const t = b.thumbnailBadgeViewModel && b.thumbnailBadgeViewModel.text;
        if (t) badges.push(t);
      }
    }
    for (const b of badges) {
      const s = toSeconds(b);
      if (s) return s;
    }
    return null;
  }

  // "6 years ago" to an approximate age in days, for the oldest-first ordering.
  // YouTube gives a relative age on this page, so videos in the same bucket keep
  // their playlist order.
  const AGE_PATTERN = /(\\d+)\\s*(second|minute|hour|day|week|month|year)s?\\s+ago/i;
  const AGE_LABEL_PATTERN = /(\\d+\\s*(?:second|minute|hour|day|week|month|year)s?\\s+ago)/i;

  function ageInDays(raw) {
    const m = AGE_PATTERN.exec(String(raw || ''));
    if (!m) return null;
    const unit = { second: 1 / 86400, minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 }[
      m[2].toLowerCase()
    ];
    return Math.round(Number(m[1]) * unit * 1000) / 1000;
  }

  function ageLabel(raw) {
    const m = AGE_LABEL_PATTERN.exec(String(raw || ''));
    return m ? m[1] : '';
  }

  function ageOf(lockup) {
    const rows =
      (lockup.metadata &&
        lockup.metadata.lockupMetadataViewModel &&
        lockup.metadata.lockupMetadataViewModel.metadata &&
        lockup.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel &&
        lockup.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel
          .metadataRows) ||
      [];
    for (const row of rows) {
      for (const part of row.metadataParts || []) {
        const raw = text(part.text);
        const days = ageInDays(raw);
        if (days !== null) return { days: days, label: raw };
      }
    }
    return { days: null, label: '' };
  }

  function videosIn(data) {
    const out = [];
    const seen = new Set();

    for (const l of collect(data, 'lockupViewModel')) {
      if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;
      const meta = l.metadata && l.metadata.lockupMetadataViewModel;
      const title = text(meta && meta.title);
      if (l.contentId && title && !seen.has(l.contentId)) {
        seen.add(l.contentId);
        const age = ageOf(l);
        out.push({
          videoId: l.contentId,
          title: title,
          durationSec: durationOf(l),
          publishedDays: age.days,
          publishedText: age.label,
        });
      }
    }

    for (const v of collect(data, 'playlistVideoRenderer')) {
      const title = text(v.title);
      if (!v.videoId || !title || seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      let durationSec = null;
      for (const overlay of v.thumbnailOverlays || []) {
        const badge = overlay.thumbnailOverlayTimeStatusRenderer;
        const s = toSeconds(text(badge && badge.text));
        if (s) {
          durationSec = s;
          break;
        }
      }
      const published = text(v.videoInfo);
      out.push({
        videoId: v.videoId,
        title: title,
        durationSec: durationSec,
        publishedDays: ageInDays(published),
        publishedText: ageLabel(published),
      });
    }

    return out;
  }

  function tokensIn(data) {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) {
        for (const x of n) walk(x);
        return;
      }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (k === 'continuationCommand' && v && typeof v === 'object') {
          if (typeof v.token === 'string') out.push(v.token);
          const nested =
            v.innertubeCommand &&
            v.innertubeCommand.continuationCommand &&
            v.innertubeCommand.continuationCommand.token;
          if (typeof nested === 'string') out.push(nested);
        }
        walk(v);
      }
    };
    walk(data);
    return out;
  }

  async function run() {
    const pageUrl =
      'https://www.youtube.com/playlist?list=' + encodeURIComponent(playlistId) + '&hl=en';

    const page = await get(pageUrl, {});
    if (page.status === 404) throw new Error('Playlist not found (is it public?)');
    if (page.status !== 200) throw new Error('YouTube answered HTTP ' + page.status);

    const apiKey = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(page.body) || [])[1];
    const clientVersion =
      (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(page.body) || [])[1] ||
      '2.20250101.00.00';
    if (!apiKey) throw new Error('Could not read YouTube session key (page layout changed?)');

    const context = {
      client: { clientName: 'WEB', clientVersion: clientVersion, hl: 'en', gl: 'US' },
    };
    const apiUrl =
      'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;
    const headers = {
      origin: 'https://www.youtube.com',
      referer: pageUrl,
      'x-youtube-client-name': '1',
      'x-youtube-client-version': clientVersion,
    };

    const first = await get(apiUrl, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ context: context, browseId: 'VL' + playlistId }),
    });
    if (first.status !== 200) throw new Error('YouTube browse HTTP ' + first.status);
    const data = JSON.parse(first.body);

    const header = (data.header && data.header.playlistHeaderRenderer) || {};
    const pageHeader =
      (data.header && data.header.pageHeaderRenderer && data.header.pageHeaderRenderer.pageTitle) ||
      null;
    const htmlTitle = (/<title>([^<]+)<\\/title>/.exec(page.body) || [])[1];
    const title =
      text(header.title) ||
      text(data.metadata && data.metadata.playlistMetadataRenderer && data.metadata.playlistMetadataRenderer.title) ||
      text(pageHeader) ||
      (htmlTitle || '').replace(/\\s*-\\s*YouTube\\s*$/, '').trim() ||
      playlistId;
    const declared = parseInt(text(header.numVideosText).replace(/[^\\d]/g, ''), 10) || null;
    const description =
      text(
        data.metadata &&
          data.metadata.playlistMetadataRenderer &&
          data.metadata.playlistMetadataRenderer.description,
      ) || '';

    const seen = new Set();
    const videos = [];
    const push = (list) => {
      for (const v of list) {
        if (seen.has(v.videoId)) continue;
        seen.add(v.videoId);
        videos.push(v);
      }
    };

    push(videosIn(data));

    const seenTokens = new Set();
    const queue = [];
    for (const t of tokensIn(data)) {
      if (seenTokens.has(t)) continue;
      seenTokens.add(t);
      queue.push(t);
    }

    let pages = 0;
    while (queue.length && videos.length < MAX && pages < 200) {
      pages++;
      const token = queue.shift();
      const res = await get(apiUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ context: context, continuation: token }),
      });
      if (res.status !== 200) throw new Error('YouTube page ' + pages + ' HTTP ' + res.status);
      const parsed = JSON.parse(res.body);
      const before = videos.length;
      push(videosIn(parsed));
      for (const t of tokensIn(parsed)) {
        if (seenTokens.has(t)) continue;
        seenTokens.add(t);
        queue.push(t);
      }
      if (videos.length === before && queue.length === 0) break;
    }

    return {
      playlistId: playlistId,
      title: title,
      description: description,
      videos: videos,
      declared: declared,
      truncated: videos.length >= MAX,
    };
  }

  return run();
`;

const api = PluginAPI;

// ---------- storage ----------

async function loadRegistry() {
  try {
    const raw = await api.loadSyncedData(REGISTRY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

async function saveRegistry(list) {
  await api.persistDataSynced(JSON.stringify(list), REGISTRY_KEY);
}

async function loadScrapes() {
  try {
    const raw = await api.loadSyncedData(SCRAPES_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (e) {
    return {};
  }
}

async function saveScrapes(map) {
  await api.persistDataSynced(JSON.stringify(map), SCRAPES_KEY);
}

function upsertEntry(list, entry) {
  const i = list.findIndex((e) => e.playlistId === entry.playlistId);
  if (i === -1) list.push(entry);
  else list[i] = Object.assign({}, list[i], entry);
  return list;
}

/** Registry entries written before the interval was configurable fall back to 24h. */
function refreshHoursOf(entry) {
  const n = Number(entry && entry.refreshHours);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REFRESH_HOURS;
  return Math.min(MAX_REFRESH_HOURS, Math.max(MIN_REFRESH_HOURS, n));
}

// ---------- reading ----------

async function readPlaylist(id) {
  const res = await api.executeNodeScript({
    script: NODE_SCRIPT,
    args: [id],
    timeout: 180000,
  });
  if (!res || !res.success) {
    const err = res && res.error;
    throw markedError(err);
  }
  return res.result;
}

/** A scrape younger than five minutes is reused; force always goes to YouTube. */
async function readScrape(id, force) {
  const all = await loadScrapes();
  const cached = all[id];
  if (
    !force &&
    cached &&
    Number.isFinite(cached.fetchedAt) &&
    Date.now() - cached.fetchedAt < CACHE_MS
  ) {
    return { data: cached, fromCache: true };
  }

  const data = await readPlaylist(id);
  const saved = Object.assign({ fetchedAt: Date.now() }, data);
  all[id] = saved;
  try {
    await saveScrapes(all);
  } catch (e) {
    // A full or unavailable store must not block an import.
  }
  return { data: saved, fromCache: false };
}

/** Background checks retry on their own, without a panel to show progress. */
async function readPlaylistWithRetry(id) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await readPlaylist(id);
    } catch (e) {
      if (String((e && e.message) || e).startsWith(PERMANENT_PREFIX)) throw e;
      last = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt === 1 ? 1000 : 2000));
    }
  }
  throw last;
}

// ---------- matching existing work ----------

const videoIdFromPath = (path) => {
  if (typeof path !== 'string') return null;
  const a = /[?&]v=([A-Za-z0-9_-]+)/.exec(path);
  if (a) return a[1];
  const b = /youtu\.be\/([A-Za-z0-9_-]+)/.exec(path);
  return b ? b[1] : null;
};

const linksPlaylist = (task, id) =>
  (task.attachments || []).some(
    (a) => typeof a.path === 'string' && new RegExp('[?&]list=' + id + '(?:&|$)').test(a.path),
  );

async function findExistingTask(playlistId) {
  const tasks = await api.getTasks();

  // The registry covers imports that were made without links, where there is no
  // playlist URL on the task to match against.
  const entry = (await loadRegistry()).find((e) => e.playlistId === playlistId);
  if (entry) {
    const known = tasks.find((t) => t.id === entry.taskId && !t.parentId);
    if (known) return { tasks: tasks, task: known };
  }

  const top = tasks.filter((t) => !t.parentId);
  return { tasks: tasks, task: top.find((t) => linksPlaylist(t, playlistId)) || null };
}

/** Video ids already under this task, plus titles as a fallback for tasks imported without links. */
function alreadyThere(tasks, parentId, numbered) {
  const ids = new Set();
  const titles = new Set();
  for (const t of tasks) {
    if (t.parentId !== parentId) continue;
    const title = String(t.title || '').trim().toLowerCase();
    titles.add(title);
    // Numbered titles still refer to the same video on a later import.
    if (numbered) titles.add(title.replace(/^\d+\.\s+/, ''));
    for (const a of t.attachments || []) {
      const id = videoIdFromPath(a.path);
      if (id) ids.add(id);
    }
  }
  return { ids: ids, titles: titles };
}

const isPresent = (seen, video) =>
  seen.ids.has(video.videoId) || seen.titles.has(String(video.title).trim().toLowerCase());

const newId = () => {
  try {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch (e) {
    // not a secure context; fall through
  }
  return 'a' + Math.random().toString(36).slice(2, 12);
};

const linkAttachment = (title, path) => ({
  id: newId(),
  type: 'LINK',
  title: title || path,
  path: path,
  icon: 'bookmark',
});

// ---------- writing ----------

/**
 * Returns 'ok', 'no-links' (the host dropped the field) or 'unverified'.
 * 'unverified' means the task list does not expose attachments, so we assume it worked.
 */
async function ensureLink(taskId, title, url) {
  const tasks = await api.getTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return 'unverified';
  const existing = task.attachments || [];
  if (existing.some((a) => a.path === url)) return 'ok';

  await api.updateTask(taskId, {
    attachments: existing.concat([linkAttachment(title, url)]),
  });

  const after = (await api.getTasks()).find((t) => t.id === taskId);
  if (!after || !Array.isArray(after.attachments)) return 'unverified';
  return after.attachments.some((a) => a.path === url) ? 'ok' : 'no-links';
}

async function addVideos(parentId, videos, withLinks, withEstimates) {
  for (const v of videos) {
    const data = {
      title: v.title,
      parentId: parentId,
      isIgnoreShortSyntax: true,
    };
    if (withEstimates && v.durationSec) data.timeEstimate = v.durationSec * 1000;

    const subId = await api.addTask(data);
    if (withLinks) {
      await api.updateTask(subId, {
        attachments: [linkAttachment(v.title, videoUrl(v.videoId))],
      });
    }
  }
}

async function writeIntoTask(opts) {
  const {
    playlistId,
    playlistTitle,
    videos,
    withLinks,
    withEstimates,
    withDescription,
    description,
  } = opts;
  let { taskId } = opts;

  if (!taskId) {
    taskId = await api.addTask({
      title: playlistTitle,
      projectId: opts.projectId || null,
      isIgnoreShortSyntax: true,
    });
  }

  let linkState = 'ok';
  if (withLinks) linkState = await ensureLink(taskId, playlistTitle, playlistUrl(playlistId));

  const tasks = await api.getTasks();
  const seen = alreadyThere(tasks, taskId, opts.numbered === true);
  const todo = videos.filter((v) => !isPresent(seen, v));
  await addVideos(taskId, todo, withLinks && linkState !== 'no-links', withEstimates);

  // Append only when missing, so re-imports do not stack the same text and the
  // user's own notes survive.
  if (withDescription && description) {
    const task = (await api.getTasks()).find((t) => t.id === taskId);
    const notes = task && typeof task.notes === 'string' ? task.notes : '';
    if (!notes.includes(description)) {
      await api.updateTask(taskId, {
        notes: (notes.trim() ? notes.trimEnd() + '\n\n' : '') + description,
      });
    }
  }

  // A host that drops the attachments field still gets the links somewhere.
  if (withLinks && linkState === 'no-links') {
    const lines = ['Playlist: ' + playlistUrl(playlistId), ''];
    videos.forEach((v, i) => {
      lines.push(i + 1 + '. ' + v.title + ' (' + videoUrl(v.videoId) + ')');
    });
    await api.updateTask(taskId, { notes: lines.join('\n') });
  }

  return {
    taskId: taskId,
    added: todo.length,
    already: videos.length - todo.length,
    linkState: linkState,
  };
}

// ---------- requests from the panel ----------

async function buildDraft(id, force) {
  const { data, fromCache } = await readScrape(id, force === true);
  const found = await findExistingTask(id);
  const entry = (await loadRegistry()).find((e) => e.playlistId === id) || null;
  const numbered = entry && entry.numberTitles === true;
  const seen = found.task
    ? alreadyThere(found.tasks, found.task.id, numbered)
    : { ids: new Set(), titles: new Set() };

  const videos = data.videos.map((v) => ({
    videoId: v.videoId,
    title: v.title,
    durationSec: v.durationSec,
    publishedDays: typeof v.publishedDays === 'number' ? v.publishedDays : null,
    publishedText: v.publishedText || '',
    unavailable: PLACEHOLDER.test(v.title),
    present: isPresent(seen, v),
  }));

  return {
    playlistId: id,
    title: data.title,
    description: data.description || '',
    declared: data.declared,
    truncated: data.truncated,
    cachedAt: data.fetchedAt || null,
    fromCache: fromCache,
    taskId: found.task ? found.task.id : null,
    taskTitle: found.task ? found.task.title : null,
    settings: entry
      ? {
          withLinks: entry.withLinks !== false,
          withEstimates: entry.withEstimates === true,
          withDescription: entry.withDescription === true,
          numberTitles: entry.numberTitles === true,
          autoRefresh: entry.autoRefresh === true,
          refreshHours: refreshHoursOf(entry),
        }
      : null,
    videos: videos,
  };
}

async function apply(msg) {
  const playlistId = String(msg.playlistId || '');
  if (!/^[A-Za-z0-9_-]{10,}$/.test(playlistId)) throw new Error('Bad playlist id.');

  const priorEntry = (await loadRegistry()).find((e) => e.playlistId === playlistId) || null;
  const numbered = priorEntry && priorEntry.numberTitles === true;

  const videos = (Array.isArray(msg.videos) ? msg.videos : [])
    .filter((v) => v && typeof v.videoId === 'string' && typeof v.title === 'string')
    .map((v, i) =>
      msg.numberTitles === true
        ? Object.assign({}, v, { title: i + 1 + '. ' + v.title })
        : v,
    );

  // A task the user deleted between the draft and the import must not be
  // written to, so fall back to creating a fresh one.
  let taskId = msg.taskId || null;
  if (taskId) {
    const exists = (await api.getTasks()).some((t) => t.id === taskId);
    if (!exists) taskId = null;
  }

  if (!videos.length && !taskId) throw new Error('Select at least one video.');

  let projectId = msg.projectId || null;
  let newProjectId = null;
  if (msg.newProject && !taskId) {
    const title = String(msg.title || msg.playlistTitle || '').trim() || 'YouTube playlist';
    newProjectId = await api.addProject({ title: title });
    projectId = newProjectId;
  }

  if (taskId && msg.title) {
    await api.updateTask(taskId, { title: String(msg.title) }, { isIgnoreShortSyntax: true });
  }

  const taskTitle =
    String(msg.title || '').trim() || String(msg.playlistTitle || '').trim() || 'Playlist';

  const result = await writeIntoTask({
    taskId: taskId,
    playlistId: playlistId,
    playlistTitle: taskTitle,
    videos: videos,
    projectId: projectId,
    withLinks: msg.withLinks !== false,
    withEstimates: msg.withEstimates === true,
    withDescription: msg.withDescription === true,
    description: typeof msg.description === 'string' ? msg.description : '',
    numbered: numbered,
  });

  if (newProjectId && result.linkState !== 'no-links') {
    try {
      api.showSnack({ msg: 'Created project and task', type: 'SUCCESS', ico: 'playlist_play' });
    } catch (e) {
      /* snack is cosmetic */
    }
  }

  const list = await loadRegistry();
  const allIds = Array.isArray(msg.knownIds) ? msg.knownIds : [];
  const picked = new Set(videos.map((v) => v.videoId));
  const skippedIds = allIds.filter((id) => typeof id === 'string' && !picked.has(id));

  upsertEntry(list, {
    playlistId: playlistId,
    taskId: result.taskId,
    title: String(msg.playlistTitle || msg.title || '').trim(),
    withLinks: msg.withLinks !== false,
    withEstimates: msg.withEstimates === true,
    withDescription: msg.withDescription === true,
    numberTitles: msg.numberTitles === true,
    refreshHours: refreshHoursOf({ refreshHours: msg.refreshHours }),
    autoRefresh: msg.autoRefresh === true,
    // Videos the user left out stay out: the background check only adds videos
    // the playlist did not have when this import ran.
    knownIds: skippedIds.length ? skippedIds : null,
    lastChecked: Date.now(),
  });
  await saveRegistry(list);

  const saved = (await api.getTasks()).find((t) => t.id === result.taskId);
  return Object.assign({}, result, { title: saved ? saved.title : taskTitle });
}

// ---------- background refresh ----------

let refreshing = false;

async function refreshEntry(entry) {
  const data = await readPlaylistWithRetry(entry.playlistId);
  const tasks = await api.getTasks();
  const parent = tasks.find((t) => t.id === entry.taskId);
  if (!parent) return 0;

  const seen = alreadyThere(tasks, entry.taskId, entry.numberTitles === true);
  const known = new Set(entry.knownIds || []);
  const missing = data.videos.filter(
    (v) => !PLACEHOLDER.test(v.title) && !known.has(v.videoId) && !isPresent(seen, v),
  );
  if (!missing.length) return 0;

  await addVideos(entry.taskId, missing, entry.withLinks === true, entry.withEstimates === true);

  const name = entry.title || data.title;
  const body = missing.length + (missing.length === 1 ? ' new video' : ' new videos') + ' from ' + name;
  try {
    // A snack is easy to miss when the window is behind something else.
    const visible =
      typeof document !== 'undefined' && typeof document.hasFocus === 'function'
        ? document.hasFocus()
        : true;
    if (visible) {
      api.showSnack({ msg: body, type: 'INFO', ico: 'playlist_play' });
    } else {
      api.notify({ title: 'YouTube Playlist to Tasks', body: body, ico: 'playlist_play' });
    }
  } catch (e) {
    /* snack and notify are cosmetic */
  }
  return missing.length;
}

async function refreshAll(force) {
  if (refreshing) return 0;
  refreshing = true;
  let added = 0;
  try {
    const list = await loadRegistry();
    for (const entry of list) {
      if (!entry.autoRefresh) continue;
      const hours = refreshHoursOf(entry);
      const due = force || Date.now() - (entry.lastChecked || 0) >= hours * 60 * 60 * 1000;
      if (!due) continue;

      // Count the attempt, not just the success, so a failing playlist waits a
      // full interval before trying again.
      entry.lastChecked = Date.now();
      try {
        added += await refreshEntry(entry);
        entry.lastError = null;
      } catch (e) {
        entry.lastError = String((e && e.message) || e);
      }
    }
    await saveRegistry(list);
  } finally {
    refreshing = false;
  }
  return added;
}

async function forget(playlistId) {
  const list = await loadRegistry();
  await saveRegistry(list.filter((e) => e.playlistId !== playlistId));
  return { ok: true };
}

// ---------- wiring ----------

const HANDLERS = {
  state: async () => ({
    entries: await loadRegistry(),
    canRefresh: typeof api.executeNodeScript === 'function',
  }),
  draft: (msg) => buildDraft(String(msg.playlistId || ''), msg.force === true),
  apply: (msg) => apply(msg),
  checkNow: async () => ({ added: await refreshAll(true) }),
  forget: (msg) => forget(String(msg.playlistId || '')),
};

let timer = null;

function start() {
  api.onMessage((msg) => {
    const handler = HANDLERS[msg && msg.type];
    if (!handler) throw new Error('Unknown request: ' + (msg && msg.type));
    return handler(msg);
  });

  setTimeout(() => {
    refreshAll(false).catch(() => {});
  }, START_DELAY_MS);

  timer = setInterval(() => {
    refreshAll(false).catch(() => {});
  }, TICK_MS);
}

if (api.onReady) api.onReady(start);
else start();

if (api.onUnload) {
  api.onUnload(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
