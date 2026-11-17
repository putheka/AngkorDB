# AngkorDB

A lightweight, native-feeling macOS client for PostgreSQL. Browse, query, edit and manage your databases — a personal replacement for TablePlus.

Built with **Tauri 2** (Rust backend, macOS WebKit UI) + **React / TypeScript**.

## Requirements

| Tool                     | Version | Install                                        |
| ------------------------ | ------- | ---------------------------------------------- |
| macOS                    | 11+     | —                                              |
| Xcode Command Line Tools | latest  | `xcode-select --install`                       |
| Node.js                  | 20+     | `brew install node`                            |
| Rust                     | stable  | `brew install rustup && rustup default stable` |

If you installed Rust with Homebrew's `rustup`, add it to your `PATH` once:

```bash
echo 'export PATH="/opt/homebrew/opt/rustup/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

Check: `cargo --version` should print a version.

## Run

```bash
npm install          # first time only
npm run tauri dev    # opens the AngkorDB window with hot reload
```

The first run compiles the Rust side and takes a minute or two. Later runs start in seconds.

## Dev database

A local Postgres 16 with test data, for development and integration tests. Needs Docker Desktop.

```bash
npm run db:up        # start (first start seeds automatically, ~30 s)
```

Connection URL: `postgres://angkor:angkor@localhost:54329/angkordb_dev`

| Command            | What it does                      |
| ------------------ | --------------------------------- |
| `npm run db:seed`  | Drop and recreate all test data   |
| `npm run db:psql`  | Open a `psql` shell               |
| `npm run db:down`  | Stop (data kept)                  |
| `npm run db:reset` | Delete everything and start fresh |

The seed ([dev/seed.sql](dev/seed.sql)) covers every tricky type (`jsonb`, arrays, enum, `numeric`, `bytea`, ranges, Khmer text), tables without a primary key, a composite key, a cross-schema FK chain, a view, a materialized view, functions, a trigger and a 1M-row table.

## Checks

```bash
npm run check        # everything below in one go
```

| Command                | What it checks                                        |
| ---------------------- | ----------------------------------------------------- |
| `npm run typecheck`    | TypeScript (strict, no `any`)                         |
| `npm run lint`         | ESLint                                                |
| `npm run format:check` | Prettier (`npm run format` to fix)                    |
| `npm run rust:check`   | `cargo fmt`, `cargo clippy -D warnings`, `cargo test` |

## Build the app

```bash
npm run tauri build
```

Output:

- `src-tauri/target/release/bundle/macos/AngkorDB.app`
- `src-tauri/target/release/bundle/dmg/AngkorDB_<version>_aarch64.dmg`

Unsigned builds: if macOS blocks the app, run `xattr -cr /Applications/AngkorDB.app` once after copying it in.

## Project structure

```
src/                      React UI
  app/                    App root + providers
  components/layout/      Window shell: sidebar, tab bar, status bar
  components/ui/          Shared UI components
  features/               One folder per feature (connections, grid, query, ...)
  lib/                    IPC wrappers, helpers
  stores/                 Zustand state
  bindings.ts             Generated Rust command + type bindings (`npm run bindings`)
src-tauri/                Rust backend
  src/commands/           Tauri commands called from the UI
  src/db/                 PostgreSQL layer
  src/models/             Serializable types
  src/error.rs            AppError → { code, message }
  tauri.conf.json         Window, bundle and app config
```

## Roadmap

Tracked in Linear: [AngkorDB — Mac Postgres Client](https://linear.app/angkordb/project/angkordb-mac-postgres-client-e5ff7c750294)

1. Foundation
2. Browse — connections, sidebar, data grid, SQL editor
3. Edit — inline edits, preview SQL, `Cmd+S` commit, safe mode
4. Query editor — autocomplete, history, cancel, EXPLAIN
5. Structure & admin
6. Connectivity & IO — SSH, SSL, import/export, backup/restore
7. Polish
8. Mac release — signed DMG, auto-update
