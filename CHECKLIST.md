# Manual checklist

Run in a dev vault after changes to editor binding or rooms. Most steps can
be driven from the CLI with `obsidian vault=<name> eval code=...`; the shared
doc is at `app.plugins.plugins['obsidian-collab'].room.docs.get(path)`.

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
- Start a room in one vault, join from another with the copied link. Also
  join with the **Join room from invite link** command and the pasted link.
  The confirm modal names the relays, the picker offers a new note, the
  new note gets the host's content, edits flow both ways, both sides show
  a peer count. Leave the room on the host, the guest's peer count drops.
- Set the signalling servers to the local worker only. Start and join work
  with the worker running and nothing else reachable.
- Reset a settings list. The defaults come back and the textarea shows them.
- Reload the plugin. `obsidian dev:errors` is empty.
