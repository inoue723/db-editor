# db editor

PostgreSQL GUI client for macOS and Linux, built with Tauri 2 (Rust) and React.

Status: early development. Nothing to download yet.

v0.1 (read and query) covers:

- Saved connections with URL paste, SSL modes, passwords in the OS keychain, a read-only switch
  and environment labels (a red band on production windows)
- Schema tree with estimated row counts and a filter
- Table browsing: virtual scrolling, 500-row pages, multi-column sort, a filter bar (AND/OR or raw
  `WHERE`), foreign key jumps and reverse references, and a read-only structure view
- SQL editor: run the statement at the cursor or all, cancel, format, history, saved queries,
  per-statement result tabs and a transaction indicator
- Copy as TSV, CSV, JSON, Markdown, `INSERT`, `UPDATE` or `WHERE`

SSH tunnels are not in this build yet.

## Development

Requirements:

- [mise](https://mise.jdx.dev/) (installs Node and pnpm from `mise.toml`)
- Rust via [rustup](https://rustup.rs/) (the version comes from `rust-toolchain.toml`)
- Docker or a compatible runtime (OrbStack, Colima) for PostgreSQL integration tests
- Linux only: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libsecret-1-dev libxdo-dev`

```sh
mise install
cargo install --locked cargo-nextest cargo-deny typos-cli
mise run setup   # pnpm install + git hooks
mise run dev     # start the app
```

| Task                                 | Command                |
| ------------------------------------ | ---------------------- |
| All static checks                    | `mise run lint`        |
| Format everything                    | `mise run fmt`         |
| Rust + frontend unit tests           | `mise run test`        |
| E2E tests (browser, IPC mocked)      | `pnpm test:e2e`        |
| Regenerate `src/bindings.ts`         | `mise run bindings`    |
| Local PostgreSQL with 1M sample rows | `docker compose up -d` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout and conventions.

## License

[MIT](LICENSE)
