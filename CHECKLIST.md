# Manual checklist

Run in a dev vault after changes to editor binding or sessions. Most steps can
be driven from the CLI with `obsidian vault=<name> eval code=...`; the shared
doc is at `app.plugins.plugins['obsidian-collab'].session.docs.get(path)`.

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
- Reload the plugin. `obsidian dev:errors` is empty.
