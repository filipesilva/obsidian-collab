import { App, FuzzySuggestModal, Modal, Setting, TFile, normalizePath } from 'obsidian';
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
    contentEl.createEl('h2', { text: 'Join collab room' });
    contentEl.createEl('p', {
      text: `Someone shared "${invite.note}". Your edits go directly to the other peers over WebRTC. Peers find each other through ${invite.relays.join(', ')}, which only relay connection setup and cannot read the note.`,
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

// Asks for a pasted invite link. Undefined when dismissed.
export class AskLink extends Modal {
  private link: string | undefined;
  private resolve!: (link: string | undefined) => void;

  ask(): Promise<string | undefined> {
    this.open();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Join collab room' });
    let value = '';
    const submit = () => {
      this.link = value;
      this.close();
    };
    new Setting(contentEl).setName('Invite link').addText((text) => {
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
    this.resolve(this.link);
  }
}

// Picks an existing note, or null for a new one. Undefined when dismissed.
export class PickNote extends FuzzySuggestModal<TFile | null> {
  private chosen: TFile | null | undefined;
  private resolve!: (file: TFile | null | undefined) => void;

  constructor(
    app: App,
    private noteName: string,
  ) {
    super(app);
    this.setPlaceholder('Where should the shared note go?');
  }

  ask(): Promise<TFile | null | undefined> {
    this.open();
    return new Promise((resolve) => (this.resolve = resolve));
  }

  getItems(): (TFile | null)[] {
    return [null, ...this.app.vault.getMarkdownFiles()];
  }

  getItemText(item: TFile | null): string {
    return item ? item.path : `New note "${this.noteName}"`;
  }

  onChooseItem(item: TFile | null): void {
    this.chosen = item;
  }

  // Obsidian closes the modal before it reports the choice.
  onClose(): void {
    queueMicrotask(() => this.resolve(this.chosen));
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
