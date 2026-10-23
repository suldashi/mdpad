# Mdpad

A self-hosted Markdown notes editor with real-time collaborative editing.

- **Plain files.** Every note is a `.md` file in one folder. The note's title is its file name. There is no database.
- **Real-time collaboration.** Several people (or tabs, or devices) can edit the same note at once. Changes are merged with operational transformation, implemented from scratch in [`src/shared/ot.ts`](src/shared/ot.ts).
- **Works with other editors.** If you change a note's file with another program while it is open in Mdpad, the change is merged into the live note.
- **Offline tolerant.** If the connection drops, keep typing; your edits are merged in when it comes back.
- **Phone friendly.** The editor fills the screen, and the note list is a drawer you can tuck away.
- **No runtime dependencies.** The server uses only Node's built-in modules, including its own small WebSocket implementation. TypeScript is the only (dev) dependency.
- **No authentication.** Mdpad expects to sit behind whatever already protects your network or reverse proxy. Don't expose it to the internet on its own.

## Run it

You need Node.js 22 or newer.

```sh
npm install      # installs TypeScript, used only for the build
npm run build    # compiles src/ and test/ into dist/
npm start        # http://127.0.0.1:3000
```

Notes are stored in `notes/` in the project folder. That folder is in `.gitignore`, so your notes never end up in the repository.

### Settings

Set these as environment variables:

| Variable    | Default     | What it does                                                                 |
|-------------|-------------|------------------------------------------------------------------------------|
| `PORT`      | `3000`      | Port to listen on.                                                           |
| `HOST`      | `127.0.0.1` | Address to listen on. Use `0.0.0.0` to reach it from other devices, such as your phone on the same network. |
| `NOTES_DIR` | `notes`     | Folder for the `.md` files, relative to the project folder or absolute.     |

For example: `HOST=0.0.0.0 PORT=8080 NOTES_DIR=/srv/notes npm start`

### Behind a reverse proxy

The proxy has to pass WebSocket upgrades through for `/ws`, and keep the `Host` header (or send `X-Forwarded-Host`), because the server refuses WebSocket connections opened from another site. With nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
}
```

## Using it

- **Title:** the large field above the text. Changing it renames the `.md` file (press Enter or click away to apply). Titles can't contain `/ \ < > : " | ? *`.
- **Notes list:** the ☰ button (or Ctrl+\\) shows and hides it. On a phone it slides over the editor.
- **Preview:** the eye button (or Ctrl+E) switches between editing and the rendered Markdown.
- **Undo/redo:** Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y. Undo only takes back your own edits, not other people's.
- **Lists:** pressing Enter in a list item starts the next item; pressing it on an empty item ends the list.
- The dot next to the menu button shows whether everything is saved (green), saving or connecting (amber), or offline (red). The "2 editing" badge appears when someone else has the same note open.

Supported Markdown: headings, paragraphs and line breaks, bold, italic, strikethrough, inline code and fenced code blocks, links and images, bare URLs, block quotes, ordered, unordered and task lists (nested), tables and horizontal rules. Raw HTML is shown as text, not rendered.

## Development

```sh
npm test           # build, then run all tests
npm run typecheck  # type-check without writing dist/
```

Project layout:

```
src/shared/ot.ts        OT: operations, compose, transform, and the client and server state machines
src/shared/markdown.ts  Markdown renderer (used by the browser; tested in Node)
src/server/main.ts      Entry point and settings
src/server/app.ts       HTTP API, static files, WebSocket protocol
src/server/docs.ts      Open notes: applying edits, saving to disk, picking up outside edits
src/server/store.ts     Reading and writing .md files
src/server/websocket.ts Minimal WebSocket server (RFC 6455)
src/client/             Browser code: app shell, textarea binding, connection, sync session
public/                 index.html, CSS, icon
test/                   Tests (node:test)
```

### How syncing works

The server holds each open note in memory with a revision number. A client sends each edit together with the revision it was made on and waits for the server to confirm it before sending the next one, collecting any further typing meanwhile. The server transforms an incoming edit past everything that happened since that revision, applies it, confirms it to the sender, and forwards it to everyone else. Clients transform incoming edits past their own unconfirmed ones.

Notes are written to disk shortly after each change (atomically, through a temporary file and a rename), and the server checks open notes' files for outside changes about once a second. A file's line endings (LF or CRLF) are kept.

When a client reconnects it asks for the edits it missed and recognises its own among them, so nothing is applied twice. If the server restarted in the meantime, the client instead gets a fresh copy of the note and re-applies its unsaved edits on top.

### HTTP API

| Method   | Path                  | Body                 | Result                         |
|----------|-----------------------|----------------------|--------------------------------|
| `GET`    | `/api/notes`          |                      | `{ notes: [{ title, mtime, size }] }`, newest first |
| `POST`   | `/api/notes`          | `{ title?, text? }`  | `201 { title }`; a number is added if the title is taken |
| `PATCH`  | `/api/notes/:title`   | `{ title }`          | `{ title }`, renames the file  |
| `DELETE` | `/api/notes/:title`   |                      | `204`, deletes the file        |

Requests with a body must be sent as `application/json`.

## License

MIT
