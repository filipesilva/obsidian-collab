import { App, Notice, PluginSettingTab, Setting, type SecretStorage, type SettingDefinitionItem, type SettingDefinitionRender } from 'obsidian';
import type CollabPlugin from './main';
import { checkTurn } from './nat';
import { COMMUNITY_RELAYS, DEFAULT_RELAYS, DEFAULT_STUN } from './network';
import { notices, settings as labels } from './text';

export interface TurnSettings {
  // Keeps the credentials but connects without TURN.
  disabled: boolean;
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
  turn: { disabled: false, always: false },
};

const SELF_HOSTING = 'https://github.com/filipesilva/obsidian-collab#self-hosting';

// The TURN server and its credentials live in app.secretStorage as one JSON
// value, so they stay on this device and out of data.json.
export interface TurnCredentials {
  url: string;
  username: string;
  credential: string;
}

const TURN_SECRET = 'collab-turn';

export function loadTurn(secrets: SecretStorage): TurnCredentials | null {
  try {
    const turn = JSON.parse(secrets.getSecret(TURN_SECRET) ?? 'null') as TurnCredentials | null;
    return turn?.url && turn.username && turn.credential ? turn : null;
  } catch {
    return null;
  }
}

function saveTurn(secrets: SecretStorage, turn: TurnCredentials) {
  secrets.setSecret(TURN_SECRET, JSON.stringify(turn));
}

// SecretStorage has no delete.
function clearTurn(secrets: SecretStorage) {
  secrets.setSecret(TURN_SECRET, '');
}

export function turnServer(secrets: SecretStorage, settings: CollabSettings): RTCIceServer | null {
  return settings.turn.disabled ? null : iceServer(loadTurn(secrets));
}

// A bare host:port is taken as turn:host:port.
function iceServer(turn: TurnCredentials | null): RTCIceServer | null {
  if (!turn) return null;
  const urls = /^turns?:/.test(turn.url) ? turn.url : `turn:${turn.url}`;
  return { urls, username: turn.username, credential: turn.credential };
}

export function rtcConfig(secrets: SecretStorage, settings: CollabSettings): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  if (settings.stun.length) iceServers.push({ urls: settings.stun });
  const turn = turnServer(secrets, settings);
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
  // TURN fields being typed, kept until saved.
  private draft: TurnCredentials | null = null;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings } = this.plugin;
    const saved = loadTurn(this.app.secretStorage);
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
            desc: this.desc(labels.community.desc),
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
            desc: this.desc(labels.stunServers.desc),
            control: { type: 'textarea', key: 'stun', rows: 5 },
          },
        ],
      },
      {
        type: 'group',
        heading: labels.turn,
        items: [
          ...(saved && !this.draft ? [this.savedTurn(saved)] : this.turnFields(saved)),
          {
            name: labels.turnDisabled.name,
            desc: labels.turnDisabled.desc,
            control: { type: 'toggle', key: 'turn.disabled', disabled: !saved },
          },
          {
            name: labels.always.name,
            desc: labels.always.desc,
            control: { type: 'toggle', key: 'turn.always', disabled: !saved },
          },
          {
            name: labels.test.name,
            desc: labels.test.desc,
            render: (setting: Setting) => {
              setting.addButton((button) =>
                button
                  .setButtonText(labels.test.action)
                  .setDisabled(!saved)
                  .onClick(async () => {
                    const turn = iceServer(loadTurn(this.app.secretStorage));
                    if (!turn) return;
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
    if (key === 'turn.disabled' || key === 'turn.always') return settings.turn[key.slice(5) as 'disabled' | 'always'];
    return undefined;
  }

  setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.plugin;
    const text = String(value);
    if (key === 'name') settings.name = text.trim();
    else if (key === 'community') settings.community = lines(text);
    else if (key === 'relays') settings.relays = lines(text);
    else if (key === 'stun') settings.stun = lines(text);
    else if (key === 'turn.disabled' || key === 'turn.always') settings.turn[key.slice(5) as 'disabled' | 'always'] = value === true;
    return this.plugin.saveSettings();
  }

  private savedTurn(saved: TurnCredentials): SettingDefinitionRender {
    return {
      name: labels.turnServer.name,
      desc: labels.turnSaved(saved.url),
      render: (setting: Setting) => {
        setting
          .addButton((button) =>
            button.setButtonText(labels.edit).onClick(() => {
              this.draft = { ...saved };
              this.update();
            }),
          )
          .addButton((button) =>
            button
              .setButtonText(labels.remove)
              .setDestructive()
              .onClick(() => {
                clearTurn(this.app.secretStorage);
                this.update();
              }),
          );
      },
    };
  }

  private turnFields(saved: TurnCredentials | null): SettingDefinitionRender[] {
    const draft = (this.draft ??= { url: '', username: '', credential: '' });
    const field = (name: string, key: keyof TurnCredentials, desc?: DocumentFragment): SettingDefinitionRender => ({
      name,
      desc,
      render: (setting: Setting) => {
        setting.addText((text) => {
          if (key === 'credential') text.inputEl.type = 'password';
          text.setValue(draft[key]).onChange((value) => (draft[key] = value.trim()));
        });
      },
    });
    return [
      field(labels.turnServer.name, 'url', this.desc(labels.turnServer.desc)),
      field(labels.username, 'username'),
      field(labels.credential, 'credential'),
      {
        name: '',
        render: (setting: Setting) => {
          if (saved) setting.addButton((button) => button.setButtonText(labels.cancel).onClick(() => this.closeDraft()));
          setting.addButton((button) =>
            button
              .setButtonText(labels.save)
              .setCta()
              .onClick(() => {
                if (!draft.url || !draft.username || !draft.credential) return void new Notice(notices.turnMissing);
                saveTurn(this.app.secretStorage, draft);
                this.closeDraft();
              }),
          );
        },
      },
    ];
  }

  // Obsidian keeps the definitions between visits, so an unsaved draft would come back.
  hide() {
    super.hide();
    this.draft = null;
    this.update();
  }

  private closeDraft() {
    this.draft = null;
    this.update();
  }

  private desc(text: string): DocumentFragment {
    return createFragment((fragment) => {
      fragment.appendText(`${text} `);
      fragment.createEl('a', { text: labels.docsLink, href: SELF_HOSTING });
    });
  }
}
