import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import type CollabPlugin from './main';
import { checkTurn } from './nat';
import { COMMUNITY_RELAYS, DEFAULT_RELAYS, DEFAULT_STUN } from './network';

export interface TurnSettings {
  url: string;
  username: string;
  credential: string;
  // Skip direct attempts and always go through the relay.
  always: boolean;
}

export interface CollabSettings {
  name: string;
  community: string[];
  relays: string[];
  stun: string[];
  turn: TurnSettings;
}

export const DEFAULT_SETTINGS: CollabSettings = {
  name: '',
  community: COMMUNITY_RELAYS,
  relays: DEFAULT_RELAYS,
  stun: DEFAULT_STUN,
  turn: { url: '', username: '', credential: '', always: false },
};

const DOCS = 'https://github.com/filipesilva/obsidian-collab/blob/master/README.md';

// A bare host:port is taken as turn:host:port. Chrome refuses a TURN server
// without credentials, so the three fields count only together.
export function turnServer(settings: CollabSettings): RTCIceServer | null {
  const { url, username, credential } = settings.turn;
  if (!url || !username || !credential) return null;
  const urls = /^turns?:/.test(url) ? url : `turn:${url}`;
  return { urls, username, credential };
}

export function rtcConfig(settings: CollabSettings): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  if (settings.stun.length) iceServers.push({ urls: settings.stun });
  const turn = turnServer(settings);
  if (turn) iceServers.push(turn);
  return turn && settings.turn.always ? { iceServers, iceTransportPolicy: 'relay' } : { iceServers };
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

// Textareas hold one server per line, and the TURN fields live under `turn`.
export class CollabSettingTab extends PluginSettingTab {
  plugin: CollabPlugin;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings } = this.plugin;
    const reset = (apply: () => void) => [
      (button: import('obsidian').ExtraButtonComponent) =>
        button
          .setIcon('rotate-ccw')
          .setTooltip('Reset to defaults')
          .onClick(() => {
            apply();
            void this.plugin.saveSettings();
            this.update();
          }),
    ];
    return [
      {
        name: 'Name',
        desc: 'Shown to peers next to your cursor.',
        control: { type: 'text', key: 'name' },
      },
      {
        type: 'group',
        heading: 'Signalling',
        extraButtons: reset(() => {
          settings.community = [...COMMUNITY_RELAYS];
          settings.relays = [...DEFAULT_RELAYS];
        }),
        items: [
          {
            name: 'Community Collab relays',
            desc: this.desc(
              'Relays run for Collab by its users, one per line. A new collab dials five relays and its URL tells guests which. It takes these first. Relays see your IP address and a room id, never the notes.',
              'signalling',
            ),
            control: { type: 'textarea', key: 'community', rows: 3 },
          },
          {
            name: 'Public Nostr relays',
            desc: 'Used to fill up to five when the community relays are not enough, one per line.',
            control: { type: 'textarea', key: 'relays', rows: 5 },
          },
        ],
      },
      {
        type: 'group',
        heading: 'STUN',
        extraButtons: reset(() => (settings.stun = [...DEFAULT_STUN])),
        items: [
          {
            name: 'Servers',
            desc: this.desc('Help peers discover their public address so they can connect directly, one per line.', 'stun'),
            control: { type: 'textarea', key: 'stun', rows: 5 },
          },
        ],
      },
      {
        type: 'group',
        heading: 'TURN',
        items: [
          {
            name: 'Server',
            desc: this.desc(
              'Relays traffic when a direct connection fails, for example on mobile networks. Only the peer behind the strict network needs one, as turn:host:3478. Leave empty unless connections fail.',
              'turn',
            ),
            control: { type: 'text', key: 'turn.url' },
          },
          { name: 'Username', control: { type: 'text', key: 'turn.username' } },
          {
            name: 'Credential',
            render: (setting: Setting) => {
              setting.addText((text) => {
                text.inputEl.type = 'password';
                text.setValue(settings.turn.credential).onChange((value) => {
                  settings.turn.credential = value.trim();
                  void this.plugin.saveSettings();
                });
              });
            },
          },
          {
            name: 'Always relay',
            desc: 'Skip direct connection attempts and always go through the TURN server. For networks where direct connections keep failing.',
            control: { type: 'toggle', key: 'turn.always' },
          },
          {
            name: 'Test',
            desc: 'Asks the server for a relay with these credentials.',
            render: (setting: Setting) => {
              setting.addButton((button) =>
                button.setButtonText('Test').onClick(async () => {
                  const turn = turnServer(settings);
                  if (!turn) return void new Notice('Collab: fill in the TURN server, username and credential first');
                  button.setDisabled(true).setButtonText('Testing…');
                  const ok = await checkTurn(turn);
                  button.setDisabled(false).setButtonText('Test');
                  new Notice(ok ? 'Collab: TURN works' : 'Collab: TURN did not answer. Check the URL, username and credential.', 8000);
                }),
              );
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const { settings } = this.plugin;
    if (key === 'name') return settings.name;
    if (key === 'community') return settings.community.join('\n');
    if (key === 'relays') return settings.relays.join('\n');
    if (key === 'stun') return settings.stun.join('\n');
    if (key === 'turn.always') return settings.turn.always;
    if (key.startsWith('turn.')) return settings.turn[key.slice(5) as 'url' | 'username' | 'credential'];
    return undefined;
  }

  setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    const text = String(value);
    if (key === 'name') settings.name = text.trim();
    else if (key === 'community') settings.community = lines(text);
    else if (key === 'relays') settings.relays = lines(text);
    else if (key === 'stun') settings.stun = lines(text);
    else if (key === 'turn.always') settings.turn.always = value === true;
    else if (key.startsWith('turn.')) settings.turn[key.slice(5) as 'url' | 'username' | 'credential'] = text.trim();
    return this.plugin.saveSettings();
  }

  private desc(text: string, anchor: string): DocumentFragment {
    return createFragment((fragment) => {
      fragment.appendText(`${text} `);
      fragment.createEl('a', { text: 'Self-hosting and details.', href: `${DOCS}#${anchor}` });
    });
  }
}
