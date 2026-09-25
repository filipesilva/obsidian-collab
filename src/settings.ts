import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from 'obsidian';
import type CollabPlugin from './main';
import { checkTurn } from './nat';
import { COMMUNITY_RELAYS, DEFAULT_RELAYS, DEFAULT_STUN } from './network';
import { notices, settings as labels } from './text';

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
          .setTooltip(labels.reset)
          .onClick(() => {
            apply();
            void this.plugin.saveSettings();
            this.update();
          }),
    ];
    return [
      {
        name: labels.name.name,
        desc: labels.name.desc,
        control: { type: 'text', key: 'name' },
      },
      {
        type: 'group',
        heading: labels.signalling,
        extraButtons: reset(() => {
          settings.community = [...COMMUNITY_RELAYS];
          settings.relays = [...DEFAULT_RELAYS];
        }),
        items: [
          {
            name: labels.community.name,
            desc: this.desc(labels.community.desc, 'signalling'),
            control: { type: 'textarea', key: 'community', rows: 3 },
          },
          {
            name: labels.relays.name,
            desc: labels.relays.desc,
            control: { type: 'textarea', key: 'relays', rows: 5 },
          },
        ],
      },
      {
        type: 'group',
        heading: labels.stun,
        extraButtons: reset(() => (settings.stun = [...DEFAULT_STUN])),
        items: [
          {
            name: labels.stunServers.name,
            desc: this.desc(labels.stunServers.desc, 'stun'),
            control: { type: 'textarea', key: 'stun', rows: 5 },
          },
        ],
      },
      {
        type: 'group',
        heading: labels.turn,
        items: [
          {
            name: labels.turnServer.name,
            desc: this.desc(labels.turnServer.desc, 'turn'),
            control: { type: 'text', key: 'turn.url' },
          },
          { name: labels.username, control: { type: 'text', key: 'turn.username' } },
          {
            name: labels.credential,
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
            name: labels.always.name,
            desc: labels.always.desc,
            control: { type: 'toggle', key: 'turn.always' },
          },
          {
            name: labels.test.name,
            desc: labels.test.desc,
            render: (setting: Setting) => {
              setting.addButton((button) =>
                button.setButtonText(labels.test.action).onClick(async () => {
                  const turn = turnServer(settings);
                  if (!turn) return void new Notice(notices.turnMissing);
                  button.setDisabled(true).setButtonText(labels.test.testing);
                  const ok = await checkTurn(turn);
                  button.setDisabled(false).setButtonText(labels.test.action);
                  new Notice(ok ? notices.turnTestWorks : notices.turnTestFailed, 8000);
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
      fragment.createEl('a', { text: labels.docsLink, href: `${DOCS}#${anchor}` });
    });
  }
}
