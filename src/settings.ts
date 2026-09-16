import { App, PluginSettingTab, Setting } from 'obsidian';
import type CollabPlugin from './main';

export interface CollabSettings {
  server: string;
}

export const DEFAULT_SETTINGS: CollabSettings = {
  server: '',
};

export class CollabSettingTab extends PluginSettingTab {
  plugin: CollabPlugin;

  constructor(app: App, plugin: CollabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Server')
      .setDesc('Signaling server URL, for example wss://collab.example.workers.dev')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.server)
          .onChange(async (value) => {
            this.plugin.settings.server = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
