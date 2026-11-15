# dbt-docs-helper

> Column descriptions that are inherited – write once, document everywhere.

`dbt-docs-helper` helps you write and maintain documentation in dbt projects. It consists of a
VS Code extension and a CLI for CI, which share the same core (TypeScript, no Python needed).
Works with dbt Core and dbt Fusion: the tool only reads `target/manifest.json` and the YAML files.

## Goals

1. **Central management of recurring columns**: find columns that occur in many models
   (e.g. `customer_id`, `created_at`) and move their descriptions to a central place
   (`{% docs %}` blocks), which are then referenced with `{{ doc('...') }}`.
2. **Coverage**: report how many models and columns lack a description,
   per folder, layer (staging/intermediate/marts), owner or tag.
3. **Inheritance via lineage**: use `manifest.json` and column-level lineage to show which
   descriptions can be inherited from upstream models, so they do not have to be written again.

## Status

Version 0.1.0 – first working version of the VS Code extension and the CLI. Not published yet.
See [docs/design.md](docs/design.md) for decisions and open questions, and the [issues](https://github.com/martindlarsson/dbt-docs-helper/issues) for planned work.

## Structure

```
packages/
  core/     Manifest, YAML index with positions, SQL reading for lineage, inheritance, coverage, YAML edits
  cli/      dbt-docs-helper in the terminal/CI
  vscode/   The extension: inlay hints, hover, quick fixes, Problems, views for coverage/work list
fixtures/
  jaffle/   Small dbt project with a real manifest.json and catalog.json (dbt 1.12) for tests
```

## The VS Code extension

See [packages/vscode/README.md](packages/vscode/README.md) for the features. In short:

- **Inlay hint** on columns without a description: `↳ stg_customers: "Unique id of…"`. Click = write it in.
- **Hover** with the inheritance chain (`crm.customers → stg_customers → customers`) and the kind of inheritance.
- **Quick fixes**: inherit, move to doc block and link both, link to an existing block,
  add missing columns (from `catalog.json`), inherit everything safe in the file, AI suggestion (opt-in).
- **Problems panel** with configurable severity per rule.
- **Side panel**: coverage per layer/folder/tag/owner/kind, work list, doc block candidates.
- **Quiet stale-manifest handling**: documentation edits never need `dbt parse`; when SQL changes, a status bar icon (or one notification per session, or a silent background parse) instead of repeated pop-ups.

### Try it locally

```bash
npm install
```

```bash
npm run package
```

Then install `packages/vscode/dbt-docs-helper.vsix` via *Extensions → … → Install from VSIX*.
Or open the repository in VS Code and press F5 ("Run extension on the fixture project").

## CLI

```bash
node packages/cli/dist/cli.js coverage --project-dir fixtures/jaffle --by layer
```

| Command | What it does |
|---|---|
| `coverage` | Coverage per `--by folder\|layer\|tag\|kind\|owner\|resource`, `--fail-under 80` |
| `check` | For CI: coverage + stale manifest (`--fail-on-stale`) + blocks that refer to removed models (`--fail-on-orphans`) |
| `missing` | Work list: what must be written by hand first, then what can be inherited |
| `candidates` | Columns in ≥ 3 models (`--min-models`) that should become doc blocks, with a suggested name |
| `conflicts` | Same column name, different descriptions |
| `inherit` | Writes inherited descriptions to YAML (dry run unless `--write`). Only safe passthrough unless `--include-renamed` / `--include-name-matches` |
| `add-columns` | Adds columns that exist in `catalog.json` but are missing in YAML |

All commands accept `--format text|json|markdown` (markdown suits `$GITHUB_STEP_SUMMARY`).

## Development

```bash
npm test
```

```bash
npm run typecheck
```

- Unit tests (vitest) for the core, the CLI and the extension (against a mock of the `vscode` API).
- Integration tests in real VS Code: `xvfb-run -a npm run test:integration -w packages/vscode` (run in CI).
- CI also runs a round trip: the CLI writes inherited descriptions, and then `dbt parse` must succeed.
- The fixture manifest is regenerated with `dbt parse` in `fixtures/jaffle` (dbt-duckdb, `profiles.yml` is there).

## Publishing

Push a tag `v0.1.0` → `.github/workflows/release.yml` publishes to the VS Code Marketplace and
Open VSX if the secrets `VSCE_PAT` and `OVSX_PAT` exist. The publisher id in
`packages/vscode/package.json` is `martindlarsson` and must exist in the Marketplace.

## License

MIT, see [LICENSE](LICENSE).
