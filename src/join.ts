import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type { Invite } from './invite';

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

function describe(invite: Invite): { kind: string; what: string } {
  const kind = invite.folder !== undefined ? 'folder' : 'file';
  const what = invite.folder !== undefined ? `the folder "${invite.folder || '/'}"` : `the file "${invite.file}"`;
  return { kind, what };
}

// With known, the share is already here and the URL replaces its stored one.
export function confirmJoin(app: App, invite: Invite, known = false): Promise<boolean> {
  const { kind, what } = describe(invite);
  const relays = `Peers find each other through ${invite.relays.join(', ')}, which only relay connection setup and cannot read the content.`;
  if (known) {
    return new Confirm(app, `Update shared ${kind} URL`, `This URL is for ${what}, which is already shared here. It replaces the stored one and connects with it. ${relays}`, 'Update').ask();
  }
  return new Confirm(app, `Join shared ${kind}`, `Someone shared ${what}. Your edits go directly to the other peers over WebRTC. ${relays}`, 'Join').ask();
}

export function confirmRegenerate(app: App, invite: Invite): Promise<boolean> {
  const { kind, what } = describe(invite);
  return new Confirm(
    app,
    `Regenerate ${kind} URL`,
    `Makes a new URL for ${what}, with fresh signalling servers and a new secret. The old one stops working. Everyone else pastes the new URL into Open collab URL, or opens it, and it replaces theirs. Their notes and edits carry over.`,
    'Regenerate',
  ).ask();
}

// Shows gathered diagnostics in a box, with a copy button.
export class ShowText extends Modal {
  constructor(
    app: App,
    private title: string,
    private text: string,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: this.title });
    const box = contentEl.createEl('textarea', { text: this.text, cls: 'collab-text-box' });
    box.readOnly = true;
    box.rows = 20;
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText('Copy')
        .setCta()
        .onClick(() => void navigator.clipboard.writeText(this.text).then(() => new Notice('Collab: copied'))),
    );
  }

  onClose() {
    this.contentEl.empty();
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
    contentEl.createEl('h2', { text: 'Open collab URL' });
    let value = '';
    const submit = () => {
      this.url = value;
      this.close();
    };
    const input = contentEl.createEl('input', { type: 'text', placeholder: 'obsidian://collab?…', cls: 'collab-url-input' });
    input.addEventListener('input', () => (value = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    window.setTimeout(() => input.focus());
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Open').setCta().onClick(submit))
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
