import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import type { Invite } from './invite';
import { modals, names, notices } from './text';

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
    this.setTitle(this.title);
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
      .addButton((b) => b.setButtonText(modals.cancel).onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.ok);
  }
}

function describe(invite: Invite): { kind: string; what: string } {
  return { kind: modals.kind(invite.folder !== undefined), what: modals.what(invite.folder, invite.file) };
}

// With known, the share is already here and the URL replaces its stored one.
export function confirmJoin(app: App, invite: Invite, known = false): Promise<boolean> {
  const { kind, what } = describe(invite);
  const relays = modals.relays(invite.relays);
  if (known) {
    return new Confirm(app, modals.update.title(kind), modals.update.text(what, relays), modals.update.action).ask();
  }
  return new Confirm(app, modals.join.title(kind), modals.join.text(what, relays), modals.join.action).ask();
}

export function confirmRegenerate(app: App, invite: Invite): Promise<boolean> {
  const { kind, what } = describe(invite);
  return new Confirm(app, modals.regenerate.title(kind), modals.regenerate.text(what), modals.regenerate.action).ask();
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
    this.setTitle(this.title);
    const box = contentEl.createEl('textarea', { text: this.text, cls: 'collab-text-box' });
    box.readOnly = true;
    box.rows = 20;
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(modals.diagnostics.action)
        .setCta()
        .onClick(() => void navigator.clipboard.writeText(this.text).then(() => new Notice(notices.textCopied))),
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
    this.setTitle(modals.openUrl.title);
    let value = '';
    const submit = () => {
      this.url = value;
      this.close();
    };
    const input = contentEl.createEl('input', { type: 'text', placeholder: modals.openUrl.placeholder, cls: 'collab-url-input' });
    input.addEventListener('input', () => (value = input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    window.setTimeout(() => input.focus());
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(modals.openUrl.action).setCta().onClick(submit))
      .addButton((b) => b.setButtonText(modals.cancel).onClick(() => this.close()));
  }

  onClose() {
    this.contentEl.empty();
    this.resolve(this.url);
  }
}

export async function createNote(app: App, name: string): Promise<TFile> {
  const base = name || names.newNote;
  // The adapter check is case-insensitive where the file system is.
  for (let n = 0; ; n++) {
    const path = normalizePath(`${base}${n ? ` ${n}` : ''}.md`);
    if (!(await app.vault.adapter.exists(path))) return app.vault.create(path, '');
  }
}
