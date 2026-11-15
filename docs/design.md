# Design notes

## Decisions so far

| Area | Decision |
|---|---|
| Workflow | The tool edits YAML files (comments and formatting must be preserved) |
| Interface | VS Code extension first |
| Environment | dbt v1 "latest" (dbt Cloud). Support for Fusion is a requirement |
| Size | Must work well with ~500 models, but also for small projects |
| Shared texts | Suggest columns that should be documented centrally, stored as `{% docs %}` blocks in a file the user chooses |
| AI | Yes, as suggestions (opt-in) |
| License | MIT (free, open source) |
| Users | Developers working locally in VS Code. Analysts in dbt Cloud do not need the extension; they benefit from the result (YAML + doc blocks) and from CLI checks in CI |
| Input | `manifest.json` is required (`dbt parse` / Fusion) |
| Renamed columns | Inheritance is only suggested, never applied automatically |
| Coverage | Includes `sources` and seeds |
| Distribution | VS Code Marketplace and Open VSX |
| Doc block candidate | The column occurs in ≥ 3 models (configurable). Stronger suggestion if the text is identical |
| Stale manifest | Must not disturb. Documentation edits never count (YAML/Markdown are read directly); only SQL/Python, seeds, `dbt_project.yml` and new sources do. Default: status bar only when another tool (the dbt extension with Fusion, dbt Power User, a terminal) keeps the manifest updated, otherwise at most one notification per session after a 30 s grace period. Optional `autoParse` runs the parse command (configurable, e.g. `dbtf parse`) in the background |

## Important: inheritance in dbt

dbt Core does **not** automatically pass column descriptions on to downstream models in YAML,
`manifest.json`, `dbt docs` or `persist_docs`. A column without a description is empty, even if a
column with the same name upstream is documented. dbt Catalog/Explorer in dbt Cloud can *display*
inherited descriptions for columns that are only passed through or renamed (this needs to be
verified for the dbt Cloud tier in use). The text is, however, never written into the project.

dbt-docs-helper should therefore make inheritance visible **in the editor**, and be able to make it
persistent in YAML.

### Strategy for persistent inheritance
1. The upstream column has `{{ doc('x') }}` → write the same reference downstream. No duplicated text.
2. The upstream column has plain text → suggest "Move to doc block and link both".
   Inheritance then effectively becomes reuse of doc blocks.
3. The user can choose not to write anything and let dbt-docs-helper show the inheritance virtually
   (it then counts as "inheritable" in coverage, not "missing").

## Features in VS Code

- **Inlay hint / ghost text** on columns without a description in YAML: `↳ from stg_customers: "Unique id of…"`.
- **Hover**: the full inheritance chain (source → staging → mart) and the kind of inheritance (passthrough, renamed, transformed).
- **Quick fixes (code actions)**:
  - Inherit from upstream
  - Move to doc block (choose file, see below)
  - Link to an existing doc block
  - Suggest a description with AI
  - Add missing columns to YAML (skeleton)
- **Diagnostics (Problems panel)**, configurable severity:
  - Column has no description and cannot inherit one
  - The same column name has different descriptions in different models
  - Column occurs in ≥ N models → candidate for a doc block
- **Side panel (tree view)**: coverage per folder/layer/tag, and a work list sorted with
  "must be written by hand" first.

## Doc block file

- Setting `dbt-docs-helper.docsBlocks.defaultFile`, e.g. `models/_docs/columns.md`.
- When extracting: a quick pick with existing `.md` files in `docs-paths`/`model-paths`, or "New file…".

### Naming convention
There are two patterns, depending on how the block is created:

- **Shared blocks** (from *Doc block candidates*, a column used in many models):
  `col_{column}`, e.g. `col_customer_id`. The text lives in a global file and is meant for every
  model that uses the column, so the name should not point at one model.
  Setting: `dbt-docs-helper.docsBlocks.sharedNamePattern`. If a block with that name already exists
  with a different text, the user is asked for another name.
- **Model descriptions**: `model_{model}`, e.g. `model_orders`. Setting:
  `dbt-docs-helper.docsBlocks.modelNamePattern`.
- **Blocks moved from one column** ("Move to doc block"): `col_{model}__{column}`, e.g.
  `col_stg_customers__customer_id`, as described below.

Rules for `col_{model}__{column}`:

- `col_` shows that it is a column description (as opposed to, for example, model descriptions).
- The model name is the model where the column **originates**, not every model that uses it.
  Downstream models that inherit link to the same block.
- Two columns with the same name but different meanings (e.g. `status` in `orders` and `payments`)
  therefore get different blocks.
- For sources: `col_{source}_{table}__{column}`, e.g. `col_crm_customers__customer_id`.
- `__` (double underscore) separates model from column, since both can contain `_`.
- The pattern is configurable: `dbt-docs-helper.docsBlocks.namePattern = "col_{model}__{column}"`.
- If the model is renamed, the block name stays. Add a warning: "The block's prefix matches no
  existing model".

A new reference is written as `description: "{{ doc('col_stg_customers__customer_id') }}"`.

## Technical architecture

```
packages/
  core/        # TypeScript: read manifest, YAML, lineage, rules. No VS Code dependencies
  vscode/      # The extension: hints, hover, code actions, tree views
  cli/         # The same core in the terminal/CI: `dbt-docs-helper coverage --fail-under 80`
```

- **TypeScript all the way**: no Python, dbt-core or dbt-osmosis needed. This means the tool
  works the same with Fusion as with dbt Core.
- **Input**: `target/manifest.json` (written by both dbt Core and Fusion) plus the YAML files
  read directly from disk. Optionally `catalog.json` to find columns that are missing in YAML.
- **YAML editing**: the `yaml` library (eemeli) via the Document API to preserve comments,
  ordering and quoting. Changes are applied as a `WorkspaceEdit` so they can be undone.
- **Fusion compatibility**: write YAML according to the newer rules (e.g. `config:` blocks,
  `arguments:` for tests) and test against dbt Fusion manifests in CI.
- **Lineage**, in steps:
  1. Name matching via `depends_on` in the manifest (simple, covers most passthrough).
  2. Reading compiled SQL to find renames and transformations.
  3. Investigate whether Fusion's own column lineage can be read (LSP or artifacts).
- **AI**: the VS Code Language Model API (`vscode.lm`), which uses the model the user already has
  in the editor, or alternatively an own API key. Context: SQL, upstream descriptions, column names.

## Implemented in 0.1.0

- **Lineage steps 1 and 2**: name matching via `depends_on`, plus a simple SQL reader
  (`packages/core/src/sql.ts`) that follows `alias.column`, `x as y`, import CTEs
  (`orders as (select * from {{ ref('stg_orders') }})`) and `select * from final`. Expressions that
  reference a single column (`sum(p.amount) as amount`) are counted as *transformed*.
  Inheritance found via SQL is ranked above plain name matching.
- **Safe inheritance** (written in bulk by "Inherit all" and `inherit --write`): a single upstream
  text, passthrough, traced in SQL. Renamed/transformed columns and name matches are only suggested.
- **Origin for block names**: follows the column upstream as long as it keeps the same name and
  is passed through unchanged. For candidates, the origin shared by most usages is chosen.
- **Unsaved changes** in YAML/Markdown are used directly (overlay); the manifest is used for
  lineage, SQL and resources.
- **YAML changes** are made as minimal text edits (insert/replace), not by re-serialising the
  document. Comments, quoting, CRLF and ordering are preserved.
- **Performance**: 500 models × 25 columns are analysed in under 0.1 s.
- **Doc block candidates** only count columns that are in YAML (catalog-only columns cannot be
  linked). A candidate is done when at least one usage links to a doc block and every other usage
  has its own, different text (a different meaning, kept on purpose).
- **Columns only in `catalog.json`** are shown in their own "Not in YAML" section of the work
  list, per model, with a button to add them to YAML.

### Planned work

Planned work is tracked as [GitHub issues](https://github.com/martindlarsson/dbt-docs-helper/issues):

- [#1 dbt_project.yml overview and checks for common mistakes](https://github.com/martindlarsson/dbt-docs-helper/issues/1)
- [#2 Model summary panel for the open model](https://github.com/martindlarsson/dbt-docs-helper/issues/2)
- [#3 Set column data types from the data platform or the manifest](https://github.com/martindlarsson/dbt-docs-helper/issues/3)
- [#4 Find unused doc blocks](https://github.com/martindlarsson/dbt-docs-helper/issues/4)
- [#5 Use dbt Fusion's own column lineage](https://github.com/martindlarsson/dbt-docs-helper/issues/5)
- [#6 Support versioned models](https://github.com/martindlarsson/dbt-docs-helper/issues/6)
- [#7 Quick fixes for model descriptions](https://github.com/martindlarsson/dbt-docs-helper/issues/7)
- [#8 Code lens in .md files: which columns use a doc block](https://github.com/martindlarsson/dbt-docs-helper/issues/8)
- [#9 Flag YAML model names that do not match any SQL file, and suggest a fix](https://github.com/martindlarsson/dbt-docs-helper/issues/9)

## Existing tools

| Tool | Gap that dbt-docs-helper fills |
|---|---|
| The official dbt VS Code extension (Fusion) | Focus on compilation/lineage, not documentation work. dbt-docs-helper should work alongside it |
| dbt Power User (AltimateAI) | Broad extension with AI-generated docs and column lineage. dbt-docs-helper focuses on inheritance, doc blocks and coverage |
| dbt-osmosis | Python/dbt-core, rewrites files heavily, does not show why something was inherited |
| dbt-coverage, dbt_project_evaluator | Measure, but do not help fix |

## Open questions

- What happens when there are several manifests (e.g. `target/` and the dbt Cloud CLI's own directory)?
