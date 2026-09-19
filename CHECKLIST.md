# Manual checklist

Run in a dev vault after changes to editor binding or collabs. Most steps can
be driven from the CLI with `obsidian vault=<name> eval code=...`; the shared
doc is at `[...app.plugins.plugins['obsidian-collab'].collabs.values()][0].docs.get(path)`.

- Share a note that is open in two panes. Type in each pane. Both panes and
  the Y.Text agree at once, disk follows within 3 s.
- Insert into the Y.Text directly, as a remote edit would. The bound pane
  updates at once, the other pane within 1 s, disk within 3 s.
- Switch the bound pane to reading mode. A Y.Text insert reaches disk and the
  reading view. Switch back to source. Nothing is lost, the pane is bound.
- Close every pane of the note. A Y.Text insert reaches disk. Edit the file
  from outside Obsidian. The Y.Text follows. Reopen the note. Editor, disk
  and Y.Text agree and the editor is bound.
- Undo after a remote edit reverts only the local edit. From the CLI, send a
  Cmd+Z keydown to `cm.contentDOM`; the `editor:undo` command does nothing
  without a focused editor.
- Rename the shared note. It stays shared under the new path. Delete it. It
  is unshared.
- Share a file in one vault. It gets a `collab-url` property, the URL is on
  the clipboard, and `state/<collab id>.yjs` appears in the plugin folder.
- Join from another vault with the URL, by the protocol handler and by the
  **Join URL** command. A new note is created with the property and opened,
  the notice says it is waiting, and once the host is online the note takes
  the shared text. Edits flow both ways, both sides show a peer count.
  Disconnect on one side, the other's peer count drops.
- Disconnect the guest, edit on both sides, **Connect file** on the guest's
  note. Both edits are present on both sides.
- Stop sharing on the guest. The property and the state file are gone, the
  note stays.
- Share a folder with nested notes from its context menu or with **Share
  folder** on a note inside it. `collab.md` appears in it with the URL, and
  every markdown file becomes a doc.
- Join the folder URL from another vault. The folder is created at the same
  path with `collab.md` and every note, nested ones included. A note created,
  renamed, or deleted on either side appears, moves, or lands in the trash
  on the other within seconds. Edits flow both ways.
- Join a folder URL when a folder already exists at that path without the
  marker. It is refused with a message.
- Disconnect and **Connect folder** again. Everything binds without waiting.
  Stop sharing the folder: `collab.md` and the state file are gone, the
  notes stay.
- The status bar shows how many collabs are connected. Clicking it lists
  them with their peer counts, each disconnects on click, and **Disconnect
  all** empties it. The command does the same.
- Set the signalling servers to the local worker only. Start and join work
  with the worker running and nothing else reachable.
- Reset a settings list. The defaults come back and the textarea shows them.
- Reload the plugin. `obsidian dev:errors` is empty.
