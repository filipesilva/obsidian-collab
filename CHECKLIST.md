# Manual checklist

`npm run e2e` covers the collab flows: share, join, edit, regenerate, folders,
TURN. What is left here needs a real editor, the UI, or a network the script
cannot fake. Run it in a dev vault after changes to editor binding or the UI.
Most steps can be driven from the CLI with `obsidian vault=<name> eval code=...`;
the shared doc is at `[...app.plugins.plugins['collab'].collabs.values()][0].docs.get(path)`.

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
- Join from another vault by the protocol handler and by the **Open collab
  URL** command. A new note is created with the property and opened, and the
  notice says it is waiting until the host is online.
- Set a different **Name** in each vault's settings. With the same note open
  in both, a click in one shows a coloured cursor with that name in the
  other, and a selection shows as a highlight. Close the note, the cursor
  goes. The status bar menu and **Show connected** list each peer indented
  under its collab, with the note they are in.
  Change the name while connected, the label follows.
- Join a folder URL when a folder already exists at that path without the
  marker. It is refused with a message, before any join dialog. A
  whole-vault URL is refused in a vault with notes, and joins in one without.
- **Share file** is not offered on a note in a shared folder, connected or
  not. **Share folder** is not offered on a folder that holds a shared note.
  Joining a folder URL whose path is inside a shared folder, or a file URL
  in a vault shared as a whole, is refused with a message.
- Make a note in a shared folder read-only, then join the folder from a
  vault that has the note but no history. A notice names the note, and the
  other notes still sync.
- The status bar shows how many collabs are connected. Clicking it lists
  them with their peer counts, each disconnects on click, and **Disconnect
  all** empties it. The command does the same.
- **Check network** reports the verdict in a notice. On a phone on cellular
  it should say symmetric NAT and point at TURN, also on its own when
  connecting without TURN configured.
- Make the local worker the only line in **Community Collab relays** and
  empty **Public Nostr relays**. Start and join work with the worker running and nothing
  else reachable.
- Reset a settings list. The defaults come back and the textarea shows them.
