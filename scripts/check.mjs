#!/usr/bin/env node
// Static checks that catch the mistakes the app would only show at runtime:
// a manifest the host rejects, a syntax error in either script, or an embedded
// scraper that no longer asks for https (which takes it out of the node sandbox).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const problems = [];

const fail = (msg) => problems.push(msg);
const read = (name) => readFileSync(join(ROOT, name), 'utf8');

function syntaxCheck(label, source) {
  const dir = mkdtempSync(join(tmpdir(), 'ytp-check-'));
  const file = join(dir, 'script.js');
  writeFileSync(file, source);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    fail(`${label} does not parse: ${String(e.stderr || e.message).trim()}`);
  }
}

// ---------- manifest ----------

let manifest = {};
try {
  manifest = JSON.parse(read('manifest.json'));
} catch (e) {
  fail(`manifest.json is not valid JSON: ${e.message}`);
}

for (const key of ['id', 'name', 'version', 'manifestVersion', 'minSupVersion']) {
  if (!manifest[key]) fail(`manifest.json needs "${key}"`);
}
if (manifest.id && manifest.id.includes(':')) {
  fail('manifest.json "id" must not contain ":"');
}
if (manifest.version && !/^\d+(\.\d+)*$/.test(manifest.version)) {
  fail(`manifest.json "version" must look like 1.3.0, got "${manifest.version}"`);
}
if (manifest.iFrame && !manifest.icon) fail('an iframe plugin needs "icon"');
if (manifest.iFrame) {
  const html = read('index.html');
  if (!html.trim()) fail('index.html is empty');
}
if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('nodeExecution')) {
  fail('manifest.json must list the nodeExecution permission');
}
if (!Array.isArray(manifest.dataSharing) || manifest.dataSharing.length) {
  fail('dataSharing must be an empty array: the plugin shares nothing');
}

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== manifest.version) {
  fail(`package.json is ${pkg.version} but manifest.json is ${manifest.version}`);
}

// ---------- files ----------

const html = read('index.html');
const uiScripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (uiScripts.length !== 1) fail(`index.html should hold exactly one inline <script>, found ${uiScripts.length}`);
uiScripts.forEach((script, i) => syntaxCheck(`index.html script ${i + 1}`, script));

const pluginScript = read('plugin.js');
syntaxCheck('plugin.js', pluginScript);

// The scraper is a template literal inside plugin.js. Pull it back out the same
// way the host does, then check the generated source rather than the wrapper.
const NODE_START = 'const NODE_SCRIPT = `';
const start = pluginScript.indexOf(NODE_START);
const end = start === -1 ? -1 : pluginScript.indexOf('\n`;', start);
if (start === -1 || end === -1) {
  fail('plugin.js must define NODE_SCRIPT as a template literal');
} else {
  const body = pluginScript.slice(start + NODE_START.length, end + 1);
  const flat = new Function('MAX_VIDEOS', `return \`${body}\``)(5000);
  syntaxCheck('the embedded node script', flat);
  if (!flat.includes("require('https')")) {
    fail("the embedded node script must require('https') so the host spawns real node");
  }
  if (!flat.includes('INNERTUBE_API_KEY')) {
    fail('the embedded node script no longer reads the YouTube session key');
  }
}

if (pluginScript.includes('<<<<<<<') || pluginScript.includes('>>>>>>>')) {
  fail('plugin.js has merge conflict markers');
}
if (html.includes('<<<<<<<') || html.includes('>>>>>>>')) {
  fail('index.html has merge conflict markers');
}

// ---------- result ----------

if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
console.log(`ok   ${manifest.name} ${manifest.version}`);
console.log('ok   manifest, both scripts and the embedded scraper');
