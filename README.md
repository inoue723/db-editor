# db editor

PostgreSQL GUI client for macOS and Linux, built with Tauri 2 (Rust) and React.

Status: early development. Nothing to download yet.

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
