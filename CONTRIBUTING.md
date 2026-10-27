# Contributing to Lumina

Bug reports, ideas and pull requests are welcome.

## Workflow

1. Create a branch from `main`:
   ```bash
   git checkout -b fix/short-description
   ```
2. Run the app with `npm run tauri dev`. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains where things
   live.
3. Before opening a pull request, run the checks:
   ```bash
   npx tsc --noEmit
   npm test
   cd src-tauri && cargo test --lib
   ```
4. Describe what changed and how you tested it. Screenshots help for interface changes.

## Guidelines

- **Keep the interface responsive.** Disk, image and model work goes in `async` commands with
  `spawn_blocking`, or on `BG_POOL`. Long jobs send progress events and can be cancelled.
- **Never lose user data.** Database changes are migrations that keep existing rows. File operations are
  staged and undoable where possible, and never overwrite files Lumina didn't write.
- **Put logic in pure, tested functions.** Frontend logic goes in `src/utils` with a test in `tests/`;
  backend logic gets a test in `src-tauri/src/tests.rs`.
- **Use the design tokens** (`surface`, `panel`, `card`, `raised` and the emerald/indigo accents in
  `src/App.css`) instead of hard-coded colours. Keep text at 11 px or larger.
- **Every action needs a keyboard path,** either a shortcut or an entry in the command palette.
- Rust follows `rustfmt`. TypeScript runs with `noUnusedLocals`, so remove anything you stop using.
