# AngkorDB

## Git commits

- Auto-commit: after finishing each task (code compiles, checks pass), commit right away. Don't ask first.
- Message: one short line only, imperative mood (e.g. `Add connection manager form`).
- No body, no bullet list, no details.
- No `Co-Authored-By` line and no mention of Claude, AI or any model name.
- Never push unless asked.

## shadcn/ui

- Add components with `npx shadcn@latest add <name>`.
- After adding, replace `import { cn } from "cn"` with `import { cn } from "@/lib/utils"` (we use clsx + tailwind-merge, not the `cn` package).
- Use theme tokens (`bg-background`, `text-muted-foreground`, `border`, `bg-sidebar`), never hardcoded `neutral-*` colors.

## Rust ⇄ TypeScript commands

- New command: `#[tauri::command]` + `#[specta::specta]` on the fn, add it to `collect_commands![…]` in `specta_builder()` (`src-tauri/src/lib.rs`), then `npm run bindings`.
- Shared types: derive `specta::Type`. Never hand-write TS types for Rust data — import from `@/bindings` (or `@/lib/ipc`).
- Never edit `src/bindings.ts` by hand; commit it together with the Rust change.
- `tauri-specta`, `specta`, `specta-typescript` are pinned exactly and must be upgraded together.
- Commands must not take a runtime-typed argument (`AppHandle`, `Window`, `Webview` default to the real `Wry` runtime). That would make them untestable through the mock runtime. Pass what you need via `State<AppState>` or compile-time constants.
- Each new command also needs: a handler in `src/dev/mockBackend.ts` (browser dev mode) and a test in `src-tauri/tests/ipc.rs`, which calls the real handlers with the JSON the UI sends.

## Rust tooling

- Rust lives at `/opt/homebrew/opt/rustup/bin`; prefix shell commands with `export PATH="/opt/homebrew/opt/rustup/bin:$PATH";` if `cargo` isn't found.
- Integration tests need the dev DB (`npm run db:up`); they skip when it's down. Run with `ANGKORDB_REQUIRE_DB=1` to make sure they really ran (a skipped test still passes). Docker restarts don't stop it any more (`restart: unless-stopped`).
- `cargo test keychain_round_trip -- --ignored` exercises the real macOS Keychain (opt-in).
