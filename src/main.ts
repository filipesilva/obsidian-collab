import { Notice, Plugin } from 'obsidian';
import * as Y from 'yjs';
import type { WebrtcProvider } from 'y-webrtc';
import { createProvider } from './network';
import { CollabSettings, CollabSettingTab, DEFAULT_SETTINGS } from './settings';

export default class CollabPlugin extends Plugin {
  settings!: CollabSettings;
  hello: { doc: Y.Doc; provider: WebrtcProvider } | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CollabSettingTab(this.app, this));
    this.addCommand({
      id: 'hello',
      name: 'Hello: toggle network test',
      callback: () => (this.hello ? this.stopHello() : this.startHello()),
    });
  }

  onunload() {
    this.stopHello();
  }

  startHello() {
    if (!this.settings.server) {
      new Notice('Collab: set a server URL in settings first');
      return;
    }
    const doc = new Y.Doc();
    const provider = createProvider(doc, {
      server: this.settings.server,
      room: 'hello',
      secret: 'hello',
    });
    provider.on('status', ({ connected }) => {
      new Notice(`Collab hello: signaling ${connected ? 'connected' : 'disconnected'}`);
    });
    provider.on('peers', ({ webrtcPeers, bcPeers }) => {
      new Notice(`Collab hello: ${webrtcPeers.length} webrtc peers, ${bcPeers.length} local peers`);
    });
    this.hello = { doc, provider };
    new Notice(`Collab hello: started on ${this.settings.server}`);
  }

  stopHello() {
    if (!this.hello) return;
    this.hello.provider.destroy();
    this.hello.doc.destroy();
    this.hello = null;
    new Notice('Collab hello: stopped');
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CollabSettings>) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
