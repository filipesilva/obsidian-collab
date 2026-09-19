import { App, PluginSettingTab, Setting } from 'obsidian';
import type CollabPlugin from './main';
import { DEFAULT_RELAYS, DEFAULT_STUN } from './network';

export interface TurnSettings {
  url: string;
  username: string;
  credential: string;
}

export interface CollabSettings {
  relays: string[];
  stun: string[];
  turn: TurnSettings;
}

export const DEFAULT_SETTINGS: CollabSettings = {
  relays: DEFAULT_RELAYS,
  stun: DEFAULT_STUN,
  turn: { url: '', username: '', credential: '' },
};

const DOCS = 'https://github.com/filipesilva/obsidian-collab/blob/master/README.md';

export function iceServers(settings: CollabSettings): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  if (settings.stun.length) servers.push({ urls: settings.stun });
  if (settings.turn.url) {
    servers.push({ urls: settings.turn.url, username: settings.turn.username, credential: settings.turn.credential });
  }
  return servers;
}

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export class CollabSettingTab extends PluginSettingTab {
  plugin: CollabPlugin;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const { settings } = this.plugin;

    this.list(
      'Signalling servers',
      'Nostr relays where peers find each other, one per line. A collab dials a few of them and its URL tells guests which. They see your IP address and a room id, never the notes.',
      'signalling',
      () => settings.relays,
      (value) => (settings.relays = value),
      DEFAULT_RELAYS,
    );

    this.list(
      'STUN servers',
      'Help peers discover their public address so they can connect directly, one per line.',
      'stun',
      () => settings.stun,
      (value) => (settings.stun = value),
      DEFAULT_STUN,
    );

    new Setting(containerEl)
      .setName('TURN server')
      .setDesc(
        this.desc(
          'Relays traffic when a direct connection fails, for example on mobile networks. Only the peer behind the strict network needs one, as turn:host:3478. Leave empty unless connections fail.',
          'turn',
        ),
      )
      .addText((text) =>
        text
          .setValue(settings.turn.url)
          .onChange((value) => this.save(() => (settings.turn.url = value.trim()))),
      );
    new Setting(containerEl)
      .setName('TURN username')
      .addText((text) =>
        text.setValue(settings.turn.username).onChange((value) => this.save(() => (settings.turn.username = value.trim()))),
      );
    new Setting(containerEl)
      .setName('TURN credential')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setValue(settings.turn.credential)
          .onChange((value) => this.save(() => (settings.turn.credential = value.trim())));
      });
  }

  private list(
    name: string,
    description: string,
    anchor: string,
    get: () => string[],
    set: (value: string[]) => void,
    defaults: string[],
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(this.desc(description, anchor))
      .addTextArea((area) => {
        area.inputEl.rows = 5;
        area.inputEl.cols = 40;
        area.setValue(get().join('\n')).onChange((value) => this.save(() => set(lines(value))));
      })
      .addExtraButton((button) =>
        button
          .setIcon('rotate-ccw')
          .setTooltip('Reset to defaults')
          .onClick(() => {
            this.save(() => set([...defaults]));
            this.display();
          }),
      );
  }

  private desc(text: string, anchor: string): DocumentFragment {
    return createFragment((fragment) => {
      fragment.appendText(`${text} `);
      fragment.createEl('a', { text: 'Self-hosting and details.', href: `${DOCS}#${anchor}` });
    });
  }

  private save(apply: () => void) {
    apply();
    void this.plugin.saveSettings();
  }
}
