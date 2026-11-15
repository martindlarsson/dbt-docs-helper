# dbt Docs Helper

**Write a column description once, document it everywhere.**

dbt does not pass column descriptions on to downstream models. A `customer_id` documented in
`stg_customers` is undocumented in `customers`, `orders` and every mart that selects it.
dbt Docs Helper shows those inherited descriptions right in your YAML, writes them for you when you
want, and helps you move repeated texts into shared `{% docs %}` blocks.

Works with dbt Core and dbt Fusion: it only reads `target/manifest.json` and your YAML files.
No Python, no dbt adapter, no database connection.

## Features

### Inherited descriptions, inline

Columns without a description get an inlay hint with the description from upstream:

```yaml
columns:
  - name: customer_id    ↳ stg_customers: "Unique id of a customer"
```

Click the hint to write it into the file. If the upstream column uses a doc block, the same
`{{ doc('…') }}` reference is written, so no text is duplicated.

The upstream column is found by reading the model SQL (`c.id as customer_id`, import CTEs,
`select * from final`) and, when that is not possible, by matching column names through
`depends_on`. Renamed and transformed columns (`sum(p.amount) as amount`) are only suggested,
never written in bulk.

### Hover with lineage

Hover a column to see where its description comes from:
`crm.customers → stg_customers → customers`, and whether it is passed through, renamed or transformed.

### Quick fixes (Ctrl+.)

- **Inherit from upstream**, as text or as the same doc-block reference
- **Move to doc block and link both**: turn the upstream text into `{% docs col_stg_customers__customer_id %}` and link both columns (and, if you want, every other column with the same text)
- **Link to an existing doc block**, with blocks that have the same text listed first
- **Add missing columns** from `catalog.json` (columns in the warehouse but not in YAML), optionally with inherited descriptions
- **Inherit all safe descriptions** in a model or in the whole file
- **Suggest a description with AI** (opt-in, uses the language model you already have in VS Code, e.g. GitHub Copilot; you confirm the text before it is written)

### Problems panel

Configurable per rule (`error`, `warning`, `information`, `hint`, `off`):

| Setting | Default | |
|---|---|---|
| `diagnostics.missingDescription` | information | Nothing to inherit: must be written by hand |
| `diagnostics.inheritable` | hint | Can be inherited |
| `diagnostics.conflictingDescriptions` | hint | Same column name, different texts |
| `diagnostics.docsBlockCandidate` | hint | Used in ≥ 3 models: share a doc block |
| `diagnostics.unknownDocsBlock` | warning | `{{ doc('x') }}` where `x` does not exist |
| `diagnostics.orphanDocsBlock` | warning | Block name refers to a model that was renamed or removed |
| `diagnostics.columnsNotInYaml` | information | Columns in `catalog.json` that are not in YAML |

### Documentation editor: write docs without opening the YAML

Open a model's SQL file and click **Document this model** (the book icon in the editor title).
The documentation editor opens in a tab next to the SQL, with the model name, its columns and
their data types, and a text field for every description:

- Type a description and leave the field (or press Enter): it is written to YAML and saved.
  Comments and formatting in the YAML are kept. Clearing a field removes the description.
- Columns that are not in YAML yet (from `catalog.json`, or from the SQL for a model that has not
  been built) are added when you describe them. A model without a YAML entry gets one, in the
  YAML file in its folder or in a new `_<folder>__models.yml`.
- Empty columns show what they can inherit; **Use ↳ stg_orders** writes it (the same
  `{{ doc() }}` reference when upstream uses a doc block).
- A column linked to a doc block shows the block's text: edit it to change it everywhere, or
  **Unlink** to change it for this column only.
- Upstream and downstream models, with their coverage, are one click away.

The editor follows the file you have open, and the same editor is in the side bar (**Document**).
Turn off automatic saving with `dbt-docs-helper.docEditor.autoSave`.

### Coverage, work list and doc-block candidates

The **dbt Docs Helper** view in the activity bar shows

- **Coverage** per layer, folder, tag, owner (`meta.owner` / group) or resource type, including sources and seeds
- a **Work list** with the columns that must be written by hand first, then the ones that can be inherited, and the columns that are in the warehouse (`catalog.json`) but not in YAML, with a button to add them
- **Doc block candidates**: columns used in many models, strongest when the text is already the same everywhere

### Stale manifest, without nagging

YAML and Markdown are read directly, so editing documentation never needs a new manifest. Only
changes to SQL/Python models, seeds, `dbt_project.yml` and new sources do.

`dbt-docs-helper.staleManifest` decides what happens then:

| Value | Behaviour |
|---|---|
| `auto` (default) | If another tool keeps `manifest.json` up to date (the dbt extension with Fusion, dbt Power User, or you in a terminal), only a warning icon in the status bar. Otherwise one notification per session, after 30 seconds |
| `statusBar` | Only the status bar icon. Click it to run the parse command |
| `notification` | A notification, at most once per session |
| `autoParse` | Run the parse command silently in the background |
| `off` | Nothing |

Set `dbt-docs-helper.parseCommand` to e.g. `dbtf parse` for Fusion or `uv run dbt parse`.

## Doc block names

Blocks created from **Doc block candidates** are shared by many models and get a global name,
`col_{column}` (e.g. `col_customer_id`); change it with `dbt-docs-helper.docsBlocks.sharedNamePattern`.

Blocks created with **Move to doc block** on one column are named `col_{model}__{column}`, where
`{model}` is the model the column originates from (for sources `{source}_{table}`), e.g.
`col_stg_customers__customer_id` or `col_crm_customers__id`. Change it with
`dbt-docs-helper.docsBlocks.namePattern`, and set
`dbt-docs-helper.docsBlocks.defaultFile` (e.g. `models/_docs/columns.md`) to skip the question
of where to save new blocks.

## Requirements

- A dbt project with `target/manifest.json` (`dbt parse`, `dbtf parse` or any dbt command).
- Optional: `target/catalog.json` (`dbt docs generate`) to find columns missing from YAML.

## Same checks in CI

The `dbt-docs-helper` CLI uses the same engine:

```bash
npx -p dbt-docs-helper-cli dbt-docs-helper check --fail-under 80 --by layer --format markdown
```

## License

MIT
