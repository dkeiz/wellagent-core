# Ripgrep plugin

Registers the unprefixed `ripgrep` tool for fast, local project search.

- Uses an existing `rg` on `PATH` or installs the pinned native release on demand.
- Stores managed binaries under `agentin/plugin-data/ripgrep/`.
- Verifies the official SHA-256 checksum before installation.
- Runs one short-lived process per search; no server remains running.
- Ripgrep is distributed under the MIT License or the Unlicense.

Upstream: https://github.com/BurntSushi/ripgrep
