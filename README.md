<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="AngkorDB" width="128" height="128" />
</p>

<h1 align="center">AngkorDB</h1>

<p align="center">
  A fast, native-feeling PostgreSQL client for macOS.<br />
  Browse, query, edit and administer your databases without the weight of a full IDE.
</p>

<p align="center">
  <a href="https://github.com/putheka/AngkorDB/releases">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#keyboard-shortcuts">Shortcuts</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS-lightgrey" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue" />
  <img alt="Built with" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React-orange" />
</p>

<p align="center">
  <img src="docs/screenshots/data-grid.png" alt="AngkorDB showing a table with striped rows, the connection rail and the schema sidebar" width="900" />
</p>

---

AngkorDB runs entirely on your Mac. There is no account, no server and no telemetry: it talks straight to your database, and your passwords stay in the macOS Keychain. It is a small Tauri app (a Rust backend with a React UI), so it starts fast and stays light on memory, even with a million-row table open.

It is PostgreSQL only, on purpose. That lets every screen use what Postgres actually has: schemas, enums, ranges, `jsonb`, materialized views, roles and privileges, `EXPLAIN`.

## Screenshots

|                                                                                              |                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| <img src="docs/screenshots/filter.png" alt="Filter bar with a raw WHERE condition" />        | <img src="docs/screenshots/sql-editor.png" alt="SQL editor with a result grid" />     |
| **Filter** by conditions or a raw `WHERE`                                                    | **SQL editor** with syntax colours and result tabs                                    |
| <img src="docs/screenshots/structure.png" alt="Table structure: columns, types, defaults" /> | <img src="docs/screenshots/light.png" alt="The same table in the light appearance" /> |
| **Structure** view: columns, indexes, constraints, triggers, DDL                             | **Light** appearance, for when you want it                                            |

<sub>Screenshots are from the browser development build, with sample data.</sub>

## Features

### Connections

- Several connections open at once, in a **left rail** like a tab strip. Switch with one click; each keeps its own tabs and queries.
- **Multiple windows** (⇧⌘N). A connection is open in one window at a time.
- Connect by form or by pasting a `postgres://` URL. Colour-code connections (for example, red for production).
- **SSH tunnel** with password, private key (with passphrase) or `ssh-agent`, plus an optional jump host. Host keys are checked against `~/.ssh/known_hosts`, and a new key asks you first.
- **SSL** modes from Disable to Verify Full, with your own CA and client certificates.
- Export and import saved connections as a file.
- Passwords live in the macOS Keychain, one item per connection. Nothing secret is written to disk by the app.
- Reopening restores your tabs, query text, sort, filters and column layout for each connection.

### Safe by default

Each connection has a **safe mode**:

| Mode                | Writes                                    |
| ------------------- | ----------------------------------------- |
| Writes allowed      | Run freely                                |
| Confirm writes      | Ask before every write                    |
| Touch ID for writes | Authenticate with Touch ID before a write |
| Read-only           | Blocked                                   |

Row edits are **staged**, not sent. You see the exact SQL (⇧⌘P), then commit with ⌘S or discard. Closing a tab or quitting with unsaved edits asks first.

### Browse and edit data

- A fast virtual grid for very large tables, with zebra rows, sort, paging, column resize, reorder and hide.
- **Filter bar** with conditions combined by AND (equals, `ILIKE`, between, in a list, is null, and more), or one raw `WHERE`.
- Edit cells inline, add rows (⌘I), delete rows, set NULL or default.
- **Row detail panel** with a JSON editor (tree and raw), foreign-key picker, and "referenced by" rows from other tables.
- Follow a foreign key from a cell to the row it points to.
- Copy cells or rows as TSV, CSV, JSON, Markdown or SQL `INSERT`; paste a spreadsheet range into the grid.
- Correct display of Postgres types: `jsonb`, arrays, `numeric`, `bytea`, ranges, enums, timestamps with time zones, Khmer and other non-Latin text.

### SQL editor

- Schema-aware **autocomplete** for tables, columns (after you type an alias) and functions.
- Run the statement under the cursor (⌘↵), the selection, or everything (⇧⌘↵). Stop a running query (⌘.).
- Several result tabs for a multi-statement script.
- **EXPLAIN** (⌘E) and **EXPLAIN ANALYZE** (⌥⌘E) with a readable plan view.
- **History** of what you ran, and **saved queries**.
- Format SQL, comment lines, duplicate a line, select the next occurrence, optional **Vim** keys.
- Export any result to CSV, JSON, NDJSON, SQL or Markdown.

### Structure and administration

- Browse schemas, tables, views, materialized views, sequences, enums, functions and triggers.
- Table **structure view**: columns, indexes, constraints, foreign keys, triggers, and the generated DDL. Edit and save columns.
- Create and drop tables, schemas, sequences, enums and databases.
- **Roles and privileges**: create roles, grant and revoke, set default privileges.
- **Activity monitor**: see running sessions and queries, cancel or terminate one.

### Import, export, backup

- **Import** CSV and JSON into a table, with column mapping and a preview. Drop a file on the window to start.
- **Export** a table or a query result in several formats.
- **Backup and restore** a database with `pg_dump` and `pg_restore` (needs PostgreSQL's client tools on your Mac, for example `brew install libpq`).

### Feels like a Mac app

- ⌘K command palette, ⌘P find any table or view, ⌘O switch database.
- Light, dark and system appearance. The dark theme is soft grey, not pure black, to be easy on the eyes with a lot of rows.
- Native menu bar, Dock integration, zoom, and a full shortcuts sheet (⇧⌘/).
- **Auto-update** from GitHub Releases, verified with a signature key.

## Install

1. Download `AngkorDB_<version>_universal.dmg` from the [Releases page](https://github.com/putheka/AngkorDB/releases), open it and drag AngkorDB to Applications. It runs natively on Apple Silicon and Intel.
2. The first time, macOS says it can't verify the app, because releases are not notarized by Apple. Open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
3. If macOS says the app is "damaged", run this once, then open it again:

```bash
xattr -cr /Applications/AngkorDB.app
```

After that it opens normally. Later updates install from inside the app (**AngkorDB → Check for Updates…**). Updates are checked against the project's own key, not Apple's.

Requires macOS 11 or newer.

## Keyboard shortcuts

The full list is in the app (⇧⌘/). The ones you will use most:

| Action                        | Shortcut |
| ----------------------------- | -------- |
| Command palette               | ⌘K       |
| Find a table or view          | ⌘P       |
| Switch database               | ⌘O       |
| New connection / new window   | ⌘N / ⇧⌘N |
| New query tab / close tab     | ⌘T / ⌘W  |
| Run statement or selection    | ⌘↵       |
| Run everything                | ⇧⌘↵      |
| Explain / explain and run     | ⌘E / ⌥⌘E |
| Format SQL                    | ⇧⌘F      |
| Save changes / show their SQL | ⌘S / ⇧⌘P |
| Add a row                     | ⌘I       |
| Filter rows                   | ⌘F       |
| Reload schema and rows        | ⌘R       |
| Settings                      | ⌘,       |

## Where your data lives

| What                             | Where                                                             |
| -------------------------------- | ----------------------------------------------------------------- |
| Saved connections (no passwords) | `~/Library/Application Support/com.angkordb.app/connections.json` |
| Passwords                        | macOS login Keychain, service `com.angkordb.app`                  |
| Tabs, queries and layout         | `…/com.angkordb.app/workspaces/`, one file per connection         |

Deleting a connection removes its Keychain item too.

## Development

### Requirements

| Tool                     | Version | Install                                        |
| ------------------------ | ------- | ---------------------------------------------- |
| macOS                    | 11+     | —                                              |
| Xcode Command Line Tools | latest  | `xcode-select --install`                       |
| Node.js                  | 20+     | `brew install node`                            |
| Rust                     | stable  | `brew install rustup && rustup default stable` |
| Docker Desktop           | any     | optional, for the test database                |

If you installed Rust with Homebrew's `rustup`, add it to your `PATH` once:

```bash
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

### Run

```bash
npm install          # first time only
npm run tauri dev    # opens the app with hot reload
```

The first run compiles the Rust side and takes a minute or two.

For UI work without the native app, `npm run dev` serves the UI at <http://localhost:1420> in a normal browser. A small in-memory mock ([src/dev/mockBackend.ts](src/dev/mockBackend.ts)) stands in for the Rust backend, with sample connections.

### Test database

A local Postgres 16 with awkward data, for development and integration tests:

```bash
npm run db:up        # start; the first start seeds it (~30 s)
```

Connection URL: `postgres://angkor:angkor@localhost:54329/angkordb_dev`

| Command            | What it does                      |
| ------------------ | --------------------------------- |
| `npm run db:seed`  | Drop and recreate all test data   |
| `npm run db:psql`  | Open a `psql` shell               |
| `npm run db:down`  | Stop (data kept)                  |
| `npm run db:reset` | Delete everything and start fresh |

The seed ([dev/seed.sql](dev/seed.sql)) covers `jsonb`, arrays, enums, `numeric`, `bytea`, ranges, Khmer text, tables without a primary key, a composite key, a cross-schema foreign-key chain, views, a materialized view, functions, a trigger and a 1M-row table. `dev/sshd` and `dev/tls` hold containers for testing SSH tunnels and SSL.

### Checks

```bash
npm run check        # everything below in one go
```

| Command                | What it checks                                        |
| ---------------------- | ----------------------------------------------------- |
| `npm run typecheck`    | TypeScript (strict, no `any`)                         |
| `npm run lint`         | ESLint                                                |
| `npm run format:check` | Prettier (`npm run format` to fix)                    |
| `npm run test:unit`    | Unit tests for the UI logic                           |
| `npm run rust:check`   | `cargo fmt`, `cargo clippy -D warnings`, `cargo test` |

Database tests skip when the test database is down. Set `ANGKORDB_REQUIRE_DB=1` to make a missing database fail them, as CI does.

[CI](.github/workflows/ci.yml) runs these on every push to `main` and every pull request, with a Postgres 16 service seeded from `dev/seed.sql`.

### Architecture

```
src/                      React UI
  app/                    App root and providers
  components/             Window shell (rail, sidebar, tabs, status bar) and shared UI
  features/               One folder per feature: connections, grid, query, structure, admin, ...
  stores/                 Zustand state
  bindings.ts             Generated Rust command and type bindings (`npm run bindings`)
src-tauri/                Rust backend
  src/commands/           Tauri commands called from the UI
  src/db/                 PostgreSQL layer: sessions, introspection, queries, SSH, TLS, import/export
  src/storage/            Saved connections, Keychain, workspaces
  src/windows.rs          Window registry and quit/close rules
  tests/                  IPC tests that call the real handlers
```

The UI and the backend share one typed contract. Rust commands and types are exported to TypeScript with [tauri-specta](https://github.com/specta-rs/tauri-specta), so a mismatch is a compile error, and a test fails if `src/bindings.ts` is out of date. Tables are read a page at a time, so the UI only holds the rows you are looking at.

### Build and release

```bash
npm run tauri build
```

This writes `AngkorDB.app` and a DMG under `src-tauri/target/release/bundle/`.

To release: set the same `version` in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `package.json`, commit, then push a tag with that number (`git tag v0.2.0 && git push origin v0.2.0`). The [Release workflow](.github/workflows/release.yml) builds a universal DMG and creates a **draft** release; review it and publish. The updater key lives in the repository secret `TAURI_SIGNING_PRIVATE_KEY`. Keep a backup of it: without it, installed apps can't be updated.

## Roadmap

Planned and in progress work is tracked in [Linear](https://linear.app/angkordb/project/angkordb-mac-postgres-client-e5ff7c750294).

## Contributing

Bug reports and ideas are welcome as GitHub issues. For a code change, open an issue first so we can agree on the approach, then run `npm run check` before sending a pull request.

## License

[MIT](LICENSE)
