// Every string the user sees, in one place. scripts/e2e.mjs matches the
// status bar on "connected", and src/nat.test.ts matches the network verdicts.

export const commands = {
  shareFile: 'Share file',
  shareFolder: 'Share folder',
  openUrl: 'Open collab URL',
  connectFile: 'Connect file',
  connectFolder: 'Connect folder',
  copyFileUrl: 'Copy file URL',
  copyFolderUrl: 'Copy folder URL',
  regenerateFileUrl: 'Regenerate file URL',
  regenerateFolderUrl: 'Regenerate folder URL',
  disconnectFile: 'Disconnect file',
  disconnectFolder: 'Disconnect folder',
  disconnectAll: 'Disconnect all',
  showConnected: 'Show connected',
  diagnostics: 'Diagnostics',
  checkNetwork: 'Check network',
  stopSharingFile: 'Stop sharing file',
  stopSharingFolder: 'Stop sharing folder',
};

export const names = {
  vault: 'the vault',
  anonymous: 'Anonymous',
  newNote: 'Shared note',
  unknownNote: 'a note',
};

export function plural(n: number, word: 'peer' | 'relay'): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

// The body of collab.md, under the property with the URL.
export const markerBody = `This folder is shared with the Collab plugin. Every markdown file in it syncs
with everyone who joined the URL above. This file itself is not synced.
`;

export const status = {
  none: '0 connected',
  some: (collabs: number, peers: number) => `${collabs} connected, ${plural(peers, 'peer')}`,
  peers: (peers: number, paths: string[]) => `${plural(peers, 'peer')}${paths.length ? `, ${paths.join(', ')}` : ''}`,
  collab: (name: string, peers: string) => `${name}: ${peers}`,
  disconnect: (name: string, peers: string) => `Disconnect ${name} (${peers})`,
  peerIn: (name: string, note: string) => `${name} in ${note}`,
};

export const notices = {
  invalidUrl: 'Collab: invalid URL',
  notAUrl: 'Collab: that is not a collab URL',
  nothingConnected: 'Collab: nothing connected',
  addRelay: 'Collab: add a relay in settings first',
  checkingRelays: 'Collab: checking relays…',
  noRelay: 'Collab: no relay answered. Check the network and the relay lists in settings.',
  alreadyConnected: 'Collab: already connected',
  vaultShared: 'Collab: the whole vault is shared, and a note can only be in one share.',
  insideShare: (path: string, above: string) =>
    `Collab: "${path}" would be inside the shared ${above ? `folder "${above}"` : 'vault'}, and a note can only be in one share.`,
  folderExists: (path: string) => `Collab: "${path}" already exists. Move it away first, the shared folder must use that path.`,
  vaultNotEmpty: 'Collab: this URL shares a whole vault. Open it in a vault with no notes.',
  markerInvalid: (marker: string, folder: string) => `Collab: ${marker} in "${folder}" has no valid URL`,
  noHistory: (name: string) =>
    `Collab: no local history for ${name}. A peer has to be online to send it, and it will replace what is here. Obsidian's file recovery keeps the current version.`,
  network: (verdict: string) => `Collab: ${verdict}.`,
  networkWhy: (verdict: string) => ` Network check: ${verdict}.`,
  turnWorks: 'Collab: TURN works.',
  turnFailed: 'Collab: TURN did not answer. Check the URL, username and credential in settings.',
  turnTestWorks: 'Collab: TURN works',
  turnTestFailed: 'Collab: TURN did not answer. Check the URL, username and credential.',
  turnMissing: 'Collab: fill in the TURN server, username and credential first',
  gathering: 'Collab: gathering diagnostics…',
  connecting: (name: string) => `Collab: connecting ${name}…`,
  connectingRelays: (name: string, relays: number) => `Collab: connecting ${name}, ${plural(relays, 'relay')} open…`,
  unreachable: (name: string, why: string) =>
    `Collab: ${name} could not reach any signalling server. Check the network and the signalling list. Still trying…${why}`,
  waitingPeers: (name: string) => `Collab: ${name} ready, waiting for peers…`,
  waitingContent: (name: string) => `Collab: waiting for someone who has ${name}…`,
  receiving: (name: string) => `Collab: receiving ${name}…`,
  received: (name: string) => `Collab: received ${name}, editing`,
  failedWithTurn: (name: string, why: string) =>
    `Collab: a peer was found for ${name} but connections keep failing, even with TURN. Test the TURN settings.${why}`,
  failed: (name: string, why: string) => `Collab: a peer was found for ${name} but the connection failed. A TURN server in settings may help.${why}`,
  peerFound: (name: string) => `Collab: peer found for ${name}, connecting…`,
  peers: (count: number) => (count ? `Collab: ${plural(count, 'peer')} connected` : 'Collab: no peers connected'),
  disconnected: 'Collab: disconnected',
  unshared: (name: string) => `Collab: ${name} is no longer shared`,
  copied: (name: string) => `Collab: URL for ${name} copied`,
  copyFailed: (name: string) => `Collab: could not copy. The URL for ${name} is in its collab-url property.`,
  textCopied: 'Collab: copied',
  syncFailed: (path: string, error: string) => `Collab: could not sync ${path}. ${error}`,
};

// The network verdict, from checkNat.
export const nat = {
  offline: 'no network, will connect when it is back',
  blocked: 'UDP is blocked here, a TURN server in settings is required',
  symmetric: 'symmetric NAT here, direct connections depend on the other side. A TURN server in settings makes them reliable',
  ok: 'direct connections should work',
};

export const modals = {
  cancel: 'Cancel',
  shareVault: {
    title: 'Share the whole vault?',
    text: 'Every Markdown file in this vault will sync with everyone who joins, and no other folder or note in it can be shared on its own.',
    action: 'Share vault',
  },
  kind: (folder: boolean) => (folder ? 'folder' : 'file'),
  what: (folder: string | undefined, file: string | undefined) => (folder !== undefined ? `the folder "${folder || '/'}"` : `the file "${file}"`),
  relays: (relays: string[]) => `Peers find each other through ${relays.join(', ')}. Relays see your IP address and a room id, never the notes.`,
  update: {
    title: (kind: string) => `Update shared ${kind} URL`,
    text: (what: string, relays: string) => `This URL is for ${what}, which is already shared here. It replaces the stored one and connects with it. ${relays}`,
    action: 'Update',
  },
  join: {
    title: (kind: string) => `Join shared ${kind}`,
    text: (what: string, relays: string) => `Someone shared ${what}. Your edits go directly to the other peers over WebRTC. ${relays}`,
    action: 'Join',
  },
  regenerate: {
    title: (kind: string) => `Regenerate ${kind} URL`,
    text: (what: string) =>
      `Makes a new URL for ${what}, with fresh signalling servers and a new secret. The old one stops working. Everyone else pastes the new URL into Open collab URL, or opens it, and it replaces theirs. Their notes and edits carry over.`,
    action: 'Regenerate',
  },
  diagnostics: { title: 'Collab diagnostics', action: 'Copy' },
  openUrl: { title: 'Open collab URL', placeholder: 'obsidian://collab?…', action: 'Open' },
};

export const settings = {
  reset: 'Reset to defaults',
  docsLink: 'Self-hosting and details.',
  name: { name: 'Name', desc: 'Shown to peers next to your cursor.' },
  signalling: 'Signalling',
  community: {
    name: 'Community Collab relays',
    desc: 'Relays run for Collab by its users. One per line. A new Collab share uses five relays on the URL, preferring community ones. Relays see only your IP address and a room id.',
  },
  relays: { name: 'Public Nostr relays', desc: 'Used to fill up to five when the community relays are not enough. One per line.' },
  stun: 'STUN',
  stunServers: { name: 'Servers', desc: 'Lets peers discover their public address so they can connect directly. One per line.' },
  turn: 'TURN',
  turnEnabled: { name: 'Enabled', desc: 'Turn off never use TURN even if configured.' },
  turnServer: {
    name: 'Server',
    desc: 'Relays traffic when a direct connection fails, for example on mobile networks. Only the peer behind the strict network needs one, as turn:host:3478. Leave empty unless connections fail.',
  },
  username: 'Username',
  credential: 'Credential',
  always: {
    name: 'Always relay',
    desc: 'Skip direct connection attempts and always go through the TURN server. For networks where direct connections keep failing.',
  },
  test: { name: 'Test', desc: 'Asks the server for a relay with these credentials.', action: 'Test', testing: 'Testing…' },
};
