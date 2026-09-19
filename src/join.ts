import { App, Modal, Setting, TFile, normalizePath } from 'obsidian';
import type { Invite } from './invite';

export class ConfirmJoin extends Modal {
  private ok = false;
  private resolve!: (ok: boolean) => void;

  constructor(
    app: App,
    private invite: Invite,
  ) {
    super(app);
  }

  ask(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen() {
    const { contentEl, invite } = this;
    const what = invite.folder !== undefined ? `the folder "${invite.folder || '/'}"` : `the file "${invite.file}"`;
    contentEl.createEl('h2', { text: 'Join shared ' + (invite.folder !== undefined ? 'folder' : 'file') });
    contentEl.createEl('p', {
      text: `Someone shared ${what}. Your edits go directly to the other peers over WebRTC. Peers find each other through ${invite.relays.join(', ')}, which only relay connection setup and cannot read the content.`,
    });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Join')
          .setCta()
          .onClick(() => {
            this.ok = true;
            this.close();
          }),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.ok);
  }
}

// A yes or no question. Resolves false when dismissed.
export class Confirm extends Modal {
  private ok = false;
  private resolve!: (ok: boolean) => void;

  constructor(
    app: App,
    private title: string,
    private text: string,
    private action: string,
  ) {
    super(app);
  }

  ask(): Promise<boolean> {
    this.open();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    contentEl.createEl('p', { text: this.text });
    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(this.action)
          .setCta()
          .onClick(() => {
            this.ok = true;
            this.close();
          }),
      )
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.ok);
  }
}

// Asks for a pasted invite URL. Undefined when dismissed.
export class AskUrl extends Modal {
  private url: string | undefined;
  private resolve!: (url: string | undefined) => void;

  ask(): Promise<string | undefined> {
    this.open();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Join URL' });
    let value = '';
    const submit = () => {
      this.url = value;
      this.close();
    };
    new Setting(contentEl).setName('Collab URL').addText((text) => {
      text.onChange((v) => (value = v));
      text.inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });
      window.setTimeout(() => text.inputEl.focus());
    });
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Join').setCta().onClick(submit))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.url);
  }
}

export async function createNote(app: App, name: string): Promise<TFile> {
  const base = name || 'Shared note';
  // The adapter check is case-insensitive where the file system is.
  for (let n = 0; ; n++) {
    const path = normalizePath(`${base}${n ? ` ${n}` : ''}.md`);
    if (!(await app.vault.adapter.exists(path))) return app.vault.create(path, '');
  }
}
