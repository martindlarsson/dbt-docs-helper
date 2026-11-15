# Changelog

## 0.1.0

First version.

- Inherited descriptions as inlay hints, with one-click inherit.
- Hover with the lineage of a column (passthrough, renamed, transformed).
- Quick fixes: inherit, move to doc block (and link both), link to doc block, add missing columns, AI suggestion (opt-in).
- Problems: missing descriptions, inheritable columns, conflicting texts, doc-block candidates, unknown and orphaned doc blocks.
- Views: coverage per layer/folder/tag/owner/kind, a work list, and doc-block candidates.
- Warning with "Run dbt parse" when manifest.json is out of date (`dbt-docs-helper.parseCommand`, e.g. `dbtf parse`).
