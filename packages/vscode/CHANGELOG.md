# Changelog

## Unreleased

- Stale manifest warnings no longer nag: documentation edits never count, a background tool that
  updates the manifest (e.g. the dbt extension with Fusion) is detected, and there is at most one
  notification per session, after 30 seconds. New setting `staleManifest`
  (`auto`, `statusBar`, `notification`, `autoParse`, `off`) replaces `staleManifestWarning`.
- The status bar shows the stale state and runs the parse command when clicked.
- Doc block candidates get a global name, `col_{column}` (setting `docsBlocks.sharedNamePattern`).
- A candidate disappears once you have linked its columns to a doc block.
- Columns that are only in `catalog.json` are no longer listed as candidates or as "Write by hand";
  they have their own "Not in YAML" section in the work list, with a button to add them to YAML.
- Clicking a column that is not in YAML opens the model's YAML entry, or its SQL/CSV file.

## 0.1.0

First version.

- Inherited descriptions as inlay hints, with one-click inherit.
- Hover with the lineage of a column (passthrough, renamed, transformed).
- Quick fixes: inherit, move to doc block (and link both), link to doc block, add missing columns, AI suggestion (opt-in).
- Problems: missing descriptions, inheritable columns, conflicting texts, doc-block candidates, unknown and orphaned doc blocks.
- Views: coverage per layer/folder/tag/owner/kind, a work list, and doc-block candidates.
- Warning with "Run dbt parse" when manifest.json is out of date (`dbt-docs-helper.parseCommand`, e.g. `dbtf parse`).
