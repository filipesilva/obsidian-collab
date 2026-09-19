// End to end: runs the collab checks from CHECKLIST.md against two open dev
// vaults by driving them with the Obsidian CLI. Usage: npm run e2e, or
// E2E_ONLY=relay npm run e2e for the steps whose name contains 'relay'.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const OBSIDIAN = '/Applications/Obsidian.app/Contents/MacOS/obsidian';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The vaults in test-vaults/ must be open in Obsidian. Their names are the
// folder names.
const VAULTS = {
  a: { name: 'one', dir: join(ROOT, 'test-vaults/one') },
  b: { name: 'two', dir: join(ROOT, 'test-vaults/two') },
  c: { name: 'three', dir: join(ROOT, 'test-vaults/three') },
};

// Puts the built plugin into a vault, as relative symlinks to the build,
// and enables it. Reloading then picks up every build.
function installPlugin(dir) {
  const plugin = join(dir, '.obsidian/plugins/obsidian-collab');
  mkdirSync(plugin, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    const target = join(plugin, file);
    if (!existsSync(target)) symlinkSync(relative(plugin, join(ROOT, file)), target);
  }
  const enabled = join(dir, '.obsidian/community-plugins.json');
  const list = existsSync(enabled) ? JSON.parse(readFileSync(enabled, 'utf8')) : [];
  if (!list.includes('obsidian-collab')) writeFileSync(enabled, JSON.stringify([...list, 'obsidian-collab'], null, 2) + '\n');
}
const PLUGIN = "app.plugins.plugins['obsidian-collab']";
const PREFIX = 'Check';

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(...args) {
  return execFileSync(OBSIDIAN, args, { encoding: 'utf8' }).trim();
}

// Whether Obsidian has this vault open. Addressing a closed vault makes
// Obsidian open it, with an empty reply the first time.
function isOpen(vault) {
  try {
    return cli(`vault=${VAULTS[vault].name}`, 'eval', 'code=app.workspace.layoutReady') === '=> true';
  } catch {
    return false;
  }
}

// Opens the vaults Obsidian does not have open, one at a time, and remembers
// them so they can be closed again at the end. Obsidian must be running and
// must have seen each vault once.
const opened = [];
async function openVaults() {
  for (const [key, v] of Object.entries(VAULTS)) {
    if (isOpen(key)) continue;
    opened.push(key);
    const started = Date.now();
    while (!isOpen(key)) {
      if (Date.now() - started > 10000) execFileSync('open', [`obsidian://open?path=${v.dir}`]);
      if (Date.now() - started > 30000) throw new Error(`vault ${v.name} did not open. Open test-vaults/${v.name} in Obsidian once.`);
      await sleep(1000);
    }
  }
}

function closeVaults() {
  for (const key of opened) {
    try {
      // From the main process side, and only after the CLI's own connection
      // to the window is gone, or the close is ignored.
      run(key, `setTimeout(() => require('@electron/remote').getCurrentWindow().close(), 2000); 'closing'`);
    } catch {
      /* already gone */
    }
  }
}

// Synchronous eval; returns the printed result.
function run(vault, code) {
  const out = cli(`vault=${VAULTS[vault].name}`, 'eval', `code=${code}`);
  if (out === '=>' || out === '(no output)') return '';
  return out.startsWith('=> ') ? out.slice(3) : out;
}

// Async eval: runs the body in an async function and polls for its result.
async function runAsync(vault, body, timeout = 60000) {
  const slot = `__check_${Math.random().toString(36).slice(2)}`;
  run(
    vault,
    `window.${slot}=null; (async()=>{try{const v=await (async()=>{${body}})(); window.${slot}=JSON.stringify(v===undefined?null:v);}catch(e){window.${slot}='ERR '+String(e.stack||e)}})(); 'started'`,
  );
  const started = Date.now();
  while (Date.now() - started < timeout) {
    await sleep(500);
    const out = run(vault, `window.${slot}`);
    if (out && out !== 'null' && out !== 'undefined') {
      if (out.startsWith('ERR ')) throw new Error(`${vault}: ${out.slice(4)}`);
      return JSON.parse(out);
    }
  }
  throw new Error(`${vault}: timed out waiting for eval`);
}

async function until(what, test, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await test()) return;
    await sleep(1000);
  }
  throw new Error(`timed out: ${what}; a=${JSON.stringify(collabs('a'))} b=${JSON.stringify(collabs('b'))}`);
}

// E2E_ONLY=<text> runs only the steps whose name contains it.
async function step(name, fn) {
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return;
  try {
    await fn();
    results.push(['ok', name]);
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push(['FAIL', name]);
    console.log(`FAIL ${name}\n     ${String(e.message || e).split('\n')[0]}`);
    for (const vault of ['a', 'b', 'c']) {
      const text = await runAsync(vault, `return await ${PLUGIN}.diagnostics();`, 60000).catch((err) => `diagnostics failed: ${err.message}`);
      console.log(`     diagnostics ${vault}:\n     ${text.replace(/\n/g, '\n     ')}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const file = (vault, rel) => join(VAULTS[vault].dir, rel);
const stateDir = (vault) => join(VAULTS[vault].dir, '.obsidian/plugins/obsidian-collab/state');
const status = (vault) => run(vault, `[...document.querySelectorAll('.status-bar-item')].map(e=>e.textContent.trim()).find(t=>t.includes('connected'))`);
const collabs = (vault) => JSON.parse(run(vault, `JSON.stringify([...${PLUGIN}.collabs.values()].map(c=>({id:c.id, path:c.path, peers:c.peers, hasState:c.hasState, docs:[...c.docs.keys()]})))`));
const urlOf = (vault, path) => run(vault, `${PLUGIN}.constructor && app.metadataCache.getFileCache(app.vault.getFileByPath(${JSON.stringify(path)}))?.frontmatter?.['collab-url'] || ''`);

function parseInvite(url) {
  const params = {};
  for (const pair of url.split('?')[1].split('&')) {
    const [k, v] = pair.split('=');
    params[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  const invite = { relays: params.s.split(',').map(decodeURIComponent), id: params.i, secret: params.k };
  if (params.d !== undefined) invite.folder = params.d;
  else invite.file = params.f;
  return invite;
}

const joinIn = (vault, invite) => runAsync(vault, `await ${PLUGIN}.join(${JSON.stringify(invite)}, true); return 'joined';`, 90000);
const connectFileIn = (vault, path) =>
  runAsync(vault, `const f=app.vault.getFileByPath(${JSON.stringify(path)}); await app.workspace.getLeaf(false).openFile(f); const u=app.metadataCache.getFileCache(f).frontmatter['collab-url']; await ${PLUGIN}.join((()=>{const q=u.split('?')[1]; const ps={}; for (const pr of q.split('&')) { const [k,v]=pr.split('='); ps[decodeURIComponent(k)]=decodeURIComponent(v); } const inv={relays:ps.s.split(',').map(decodeURIComponent), id:ps.i, secret:ps.k}; if (ps.d!==undefined) inv.folder=ps.d; else inv.file=ps.f; return inv;})(), true); return 'connected';`, 90000);
const typeIn = (vault, text) => run(vault, `const e=app.workspace.activeEditor.editor; e.replaceRange(${JSON.stringify(text)}, {line:e.lastLine(), ch:e.getLine(e.lastLine()).length}); 'typed'`);
const editorText = (vault) => run(vault, `app.workspace.activeEditor?.editor?.getValue() ?? ''`);
const openIn = (vault, path) => runAsync(vault, `await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath(${JSON.stringify(path)})); return 'open';`);
const disconnectAll = (vault) => runAsync(vault, `await ${PLUGIN}.disconnectAll(); return 'done';`);
const errorsBefore = cli('dev:errors');

async function cleanup() {
  for (const vault of ['a', 'b', 'c']) {
    run(vault, `document.querySelector('.modal-close-button')?.click(); 'closed'`);
    await disconnectAll(vault).catch(() => {});
    await runAsync(
      vault,
      `for (const f of app.vault.getMarkdownFiles()) { if (f.basename.startsWith(${JSON.stringify(PREFIX)}) && ${PLUGIN}.collabOf(f.path)===undefined && f.name!=='collab.md') { const u=app.metadataCache.getFileCache(f)?.frontmatter?.['collab-url']; if (u) await ${PLUGIN}.stopSharingFile(f); } }
       for (const f of app.vault.getMarkdownFiles()) if (f.path.startsWith(${JSON.stringify(PREFIX)})) await app.fileManager.trashFile(f);
       for (const name of [${JSON.stringify(PREFIX + ' folder')}]) { const d=app.vault.getFolderByPath(name); if (d) { const m=app.vault.getFileByPath(name + '/collab.md'); if (m) await ${PLUGIN}.stopSharingFolder(d); await app.fileManager.trashFile(d); } }
       return 'clean';`,
      60000,
    ).catch((e) => console.log(`     cleanup ${vault}: ${e.message}`));
  }
}

if (!existsSync(join(ROOT, 'main.js'))) {
  console.log('no main.js, run npm run build first');
  process.exit(1);
}
console.log(`collab e2e against test-vaults ${Object.values(VAULTS).map((v) => v.name).join(', ')}`);
// Leftover settings must not shape the run.
for (const v of ['a', 'b', 'c']) run(v, `const p=${PLUGIN}; p.settings.turn={url:'', username:'', credential:'', always:false}; p.saveSettings(); 'reset'`);
// A local STUN and TURN server for the relay step, killed at the end.
const turn = spawn(process.execPath, ['test/turn-server.mjs'], { stdio: 'ignore', detached: true });
const stopTurn = () => {
  try {
    if (turn.pid) process.kill(-turn.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
};
process.on('exit', stopTurn);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopTurn();
    closeVaults();
    process.exit(130);
  });
}
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (err) => {
    console.log(`FAIL ${String(err?.stack || err).split('\n')[0]}`);
    stopTurn();
    closeVaults();
    process.exit(1);
  });
}
await openVaults();
for (const [key, v] of Object.entries(VAULTS)) {
  installPlugin(v.dir);
  // A vault opened before the plugin folder existed, or in restricted mode,
  // needs Obsidian to rescan and enable it.
  await runAsync(key, `if (!app.plugins.isEnabled()) await app.plugins.setEnable(true); await app.plugins.loadManifests(); if (!app.plugins.plugins['obsidian-collab']) await app.plugins.enablePluginAndSave('obsidian-collab'); return !!app.plugins.plugins['obsidian-collab'];`, 30000);
}

await cleanup();
for (const vault of ['a', 'b', 'c']) cli(`vault=${VAULTS[vault].name}`, 'plugin:reload', 'id=obsidian-collab');
await sleep(1500);

await step('status bar starts at 0 connected', async () => {
  for (const vault of ['a', 'b', 'c']) assert(status(vault) === '0 connected', `${vault}: ${status(vault)}`);
});

let url = '';
const FILE = `${PREFIX} file.md`;
await step('share a file in a', async () => {
  await runAsync('a', `const f=await app.vault.create(${JSON.stringify(FILE)}, 'first line\\n'); await app.workspace.getLeaf(false).openFile(f); await ${PLUGIN}.shareFile(f); return 'shared';`);
  url = urlOf('a', FILE);
  assert(url.startsWith('obsidian://collab?'), `no url in property: ${url}`);
  assert(collabs('a').length === 1, 'not connected');
  await until('state file in a', () => existsSync(join(stateDir('a'), `${parseInvite(url).id}.yjs`)), 10000);
  assert(status('a').startsWith('1 connected'), status('a'));
});

let guestFile = '';
await step('join the file from b by url', async () => {
  await joinIn('b', parseInvite(url));
  const c = collabs('b');
  assert(c.length === 1, 'b not connected');
  guestFile = c[0].docs[0];
  assert(guestFile.startsWith(PREFIX), `guest file ${guestFile}`);
  await until('b has the content', () => editorText('b').includes('first line'), 20000);
  await until('peers on both sides', () => collabs('a')[0]?.peers === 1 && collabs('b')[0]?.peers === 1, 20000);
});

await step('edits flow both ways and reach disk', async () => {
  typeIn('a', ' +a');
  await until('b sees +a', () => editorText('b').includes('+a'), 15000);
  typeIn('b', ' +b');
  await until('a sees +b', () => editorText('a').includes('+b'), 15000);
  await until('disk on both', () => readFileSync(file('a', FILE), 'utf8').includes('+b') && readFileSync(file('b', guestFile), 'utf8').includes('+b'), 15000);
});

await step('a third peer joins, everyone syncs, then it leaves', async () => {
  await joinIn('c', parseInvite(url));
  const cFile = collabs('c')[0]?.docs[0];
  assert(cFile, 'c not connected');
  await until('everyone has two peers', () => ['a', 'b', 'c'].every((v) => collabs(v)[0]?.peers === 2), 30000);
  await until('c has the content', () => editorText('c').includes('+b'), 15000);
  typeIn('c', ' +c');
  await until('a and b see +c', () => editorText('a').includes('+c') && editorText('b').includes('+c'), 15000);
  typeIn('a', ' +a2');
  await until('b and c see +a2', () => editorText('b').includes('+a2') && editorText('c').includes('+a2'), 15000);
  const same = (v) => editorText(v).replace(/\s+$/, '');
  assert(same('a') === same('b') && same('b') === same('c'), 'texts differ');
  await disconnectAll('c');
  await until('a and b back to one peer', () => collabs('a')[0]?.peers === 1 && collabs('b')[0]?.peers === 1, 15000);
});

await step('disconnect b, edit apart, reconnect and merge', async () => {
  await disconnectAll('b');
  await until('a sees b leave', () => collabs('a')[0]?.peers === 0, 15000);
  typeIn('a', ' +away');
  const path = file('b', guestFile);
  writeFileSync(path, readFileSync(path, 'utf8').replace('first line', 'offline: first line'));
  await sleep(2000);
  await connectFileIn('b', guestFile);
  await until('both merged', () => {
    const a = editorText('a');
    const b = editorText('b');
    return a.includes('+away') && a.includes('offline:') && b.includes('+away') && b.includes('offline:');
  }, 30000);
});

await step('stop sharing on b removes property and state', async () => {
  const id = parseInvite(url).id;
  await runAsync('b', `await ${PLUGIN}.stopSharingFile(app.vault.getFileByPath(${JSON.stringify(guestFile)})); return 'stopped';`);
  await until('property gone', () => !readFileSync(file('b', guestFile), 'utf8').includes('collab-url'), 10000);
  assert(!existsSync(join(stateDir('b'), `${id}.yjs`)), 'state file still there');
  assert(collabs('b').length === 0, 'still connected');
});

await disconnectAll('a');

const FOLDER = `${PREFIX} folder`;
let folderUrl = '';
await step('share a folder with nested notes in a', async () => {
  await runAsync('a', `await app.vault.createFolder(${JSON.stringify(FOLDER)}); await app.vault.createFolder(${JSON.stringify(FOLDER + '/sub')}); await app.vault.create(${JSON.stringify(FOLDER + '/One.md')}, 'one [[Two]]\\n'); await app.vault.create(${JSON.stringify(FOLDER + '/sub/Two.md')}, 'two\\n'); await ${PLUGIN}.shareFolder(app.vault.getFolderByPath(${JSON.stringify(FOLDER)})); return 'shared';`);
  folderUrl = urlOf('a', `${FOLDER}/collab.md`);
  assert(parseInvite(folderUrl).folder === FOLDER, `folder url ${folderUrl}`);
  assert(collabs('a')[0]?.docs.length === 2, `docs ${JSON.stringify(collabs('a'))}`);
});

await step('join the folder from b', async () => {
  await joinIn('b', parseInvite(folderUrl));
  await until('files created in b', () => existsSync(file('b', `${FOLDER}/One.md`)) && existsSync(file('b', `${FOLDER}/sub/Two.md`)), 30000);
  assert(readFileSync(file('b', `${FOLDER}/One.md`), 'utf8').includes('one [[Two]]'), 'content missing');
});

await step('create, rename, delete and edit propagate', async () => {
  await runAsync('a', `await app.vault.create(${JSON.stringify(FOLDER + '/New.md')}, 'new\\n'); return 'ok';`);
  await until('New.md in b', () => existsSync(file('b', `${FOLDER}/New.md`)), 15000);
  // vault.rename, not fileManager.renameFile: the latter may prompt about links.
  await runAsync('b', `await app.vault.rename(app.vault.getFileByPath(${JSON.stringify(FOLDER + '/sub/Two.md')}), ${JSON.stringify(FOLDER + '/sub/Renamed.md')}); return 'ok';`);
  await until('Renamed.md in a', () => existsSync(file('a', `${FOLDER}/sub/Renamed.md`)) && !existsSync(file('a', `${FOLDER}/sub/Two.md`)), 15000);
  await runAsync('a', `await app.fileManager.trashFile(app.vault.getFileByPath(${JSON.stringify(FOLDER + '/New.md')})); return 'ok';`);
  await until('New.md gone in b', () => !existsSync(file('b', `${FOLDER}/New.md`)), 15000);
  await openIn('b', `${FOLDER}/One.md`);
  typeIn('b', ' +b');
  await until('edit in a', () => readFileSync(file('a', `${FOLDER}/One.md`), 'utf8').includes('+b'), 15000);
});

await step('reconnect folder from state and stop sharing', async () => {
  await disconnectAll('b');
  for (const v of ['a', 'b']) run(v, `window.__warns=[]; const w=console.warn; console.warn=(...a)=>{window.__warns.push(new Date().toISOString().slice(11,19)+' '+a.map(String).join(' ')); w(...a)}; 'hooked'`);
  const started = Date.now();
  await connectFileIn('b', `${FOLDER}/collab.md`);
  assert(collabs('b')[0]?.hasState === true, 'no state on reconnect');
  await until('peers again', () => collabs('b')[0]?.peers === 1, 60000);
  console.log(`     reconnect took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const v of ['a', 'b']) {
    const warns = run(v, `window.__warns.join('\\n')`);
    if (warns) console.log(`     warnings in ${v}:\n     ${warns.replace(/\n/g, '\n     ')}`);
  }
  await runAsync('b', `await ${PLUGIN}.stopSharingFolder(app.vault.getFolderByPath(${JSON.stringify(FOLDER)})); return 'ok';`);
  await until('marker gone in b', () => !existsSync(file('b', `${FOLDER}/collab.md`)), 10000);
  assert(existsSync(file('b', `${FOLDER}/One.md`)), 'notes should stay');
});

// Electron refuses a TURN server on a loopback address, so the local one is
// reached by the machine's LAN address.
const LAN = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal)?.address;
const RELAY_FILE = `${PREFIX} relay.md`;
await step('b connects through TURN with Always relay', async () => {
  assert(LAN, 'no LAN address, the relay step needs a network interface');
  const setTurn = (v, on) =>
    run(v, `const p=${PLUGIN}; p.settings.turn=${on ? `{url:'turn:${LAN}:3479', username:'collab', credential:'collab', always:true}` : "{url:'', username:'', credential:'', always:false}"}; p.saveSettings(); 'set'`);
  setTurn('b', true);
  // Trystero reuses an idle connection to a known peer across rooms, so a
  // fresh plugin instance is needed for the policy to apply.
  cli(`vault=${VAULTS.b.name}`, 'plugin:reload', 'id=obsidian-collab');
  await sleep(1500);
  try {
    await runAsync('a', `const f=await app.vault.create(${JSON.stringify(RELAY_FILE)}, 'relayed\\n'); await app.workspace.getLeaf(false).openFile(f); await ${PLUGIN}.shareFile(f); return 'shared';`);
    const relayUrl = urlOf('a', RELAY_FILE);
    const id = parseInvite(relayUrl).id;
    const mine = (v) => collabs(v).find((c) => c.id === id);
    await joinIn('b', parseInvite(relayUrl));
    await until('peers on both sides', () => mine('a')?.peers === 1 && mine('b')?.peers === 1, 30000);
    const paths = await runAsync('b', `return await ${PLUGIN}.collabs.get(${JSON.stringify(id)}).paths();`);
    assert(JSON.stringify(paths) === '["relay"]', `b path ${JSON.stringify(paths)}`);
    typeIn('a', ' +relay');
    await until('b sees the edit via relay', () => editorText('b').includes('+relay'), 15000);
  } finally {
    setTurn('b', false);
  }
});

await step('no plugin errors', async () => {
  const after = cli('dev:errors');
  const fresh = after.replace(errorsBefore, '');
  assert(!/obsidian-collab/.test(fresh), `new errors:\n${fresh.slice(0, 500)}`);
});

await cleanup();
closeVaults();
const failed = results.filter(([r]) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
