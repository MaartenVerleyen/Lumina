# Contributing to Lumina

Thank you for your interest in contributing to Lumina! We welcome bug reports, feature requests, and pull requests.

## Development Workflow

1. Fork the repository and create your feature branch from `main`:
   ```bash
   git checkout -b feature/amazing-feature
   ```
2. Make your changes in Rust (`src-tauri/src/lib.rs`) or React (`src/`).
3. Test locally using Tauri dev mode:
   ```bash
   npm run tauri dev
   ```
4. Ensure all database migrations or new Tauri commands are fully tested against local datasets.
5. Push to your fork and open a Pull Request.

## Code Standards
* **Rust:** Adhere to standard `rustfmt` formatting. Ensure all heavy operations are offloaded to `spawn_blocking` or Rayon pools.
* **React:** Maintain the Obsidian darkroom theme (`#070a11`, `#0c0d14`, `#10121a`, zinc/indigo accents) and keep virtualized components performant.