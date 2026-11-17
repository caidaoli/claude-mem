# Claude-Mem development

@AGENTS.md

Before changing capture, retries, or recovery, follow the canonical
[observer lifecycle contract](docs/architecture/observer-lifecycle.md).

Run the full suite in parallel: `npm test -- --parallel=12` (about a minute;
plain `npm test` runs files serially and takes several minutes). The test
preload isolates each file's data directory, so parallel runs are safe.
