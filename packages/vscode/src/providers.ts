import * as vscode from 'vscode';
import {
  Analysis,
  blocksWithText,
  ColumnReport,
  docRefName,
  findAt,
  hasDocRef,
  inheritedValue,
  isSafeInheritance,
  ResourceReport,
  YamlFileIndex,
} from '@dbt-docs-helper/core';
import { settings } from './config';
import { ProjectManager, ProjectState } from './projectManager';
import { chainLabel, ColumnRef, kindLabel, reportsInFile, toPosition, toRange, truncate } from './util';

export const YAML_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', pattern: '**/*.yml' },
  { scheme: 'file', pattern: '**/*.yaml' },
];

interface Context {
  state: ProjectState;
  analysis: Analysis;
  rel: string;
  index: YamlFileIndex;
}

function context(manager: ProjectManager, doc: vscode.TextDocument): Context | undefined {
  const found = manager.analysisFor(doc.uri);
  if (!found) return undefined;
  const rel = found.state.project.relative(doc.uri.fsPath);
  const index = found.state.project.yamlFiles.get(rel);
  // Only trust offsets when the index is built from exactly this text.
  if (!index || index.text !== doc.getText()) return undefined;
  return { ...found, rel, index };
}

function at(ctx: Context, offset: number): { resource?: ResourceReport; column?: ColumnReport } {
  const hit = findAt(ctx.index, offset);
  if (!hit) return {};
  const resource = reportsInFile(ctx.analysis, ctx.rel).find((r) => r.yaml?.resource.range[0] === hit.resource.range[0]);
  const column = hit.column && resource?.columns.find((c) => c.yaml?.column.range[0] === hit.column!.range[0]);
  return { resource, column };
}

function ref(ctx: Context, resource: ResourceReport, column: ColumnReport): ColumnRef {
  return { root: ctx.state.project.root, resourceId: resource.resource.uniqueId, column: column.name };
}

// -----------------------------------------------------------------------------
// Inlay hints

export class InlayHints implements vscode.InlayHintsProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.emitter.event;

  constructor(private readonly manager: ProjectManager) {
    manager.onDidChange(() => this.emitter.fire());
  }

  provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): vscode.InlayHint[] {
    if (!settings.inlayHints(doc.uri)) return [];
    const ctx = context(this.manager, doc);
    if (!ctx) return [];
    const max = settings.inlayMaxLength(doc.uri);
    const showBlocks = settings.inlayHintsDocBlocks(doc.uri);
    const hints: vscode.InlayHint[] = [];
    for (const r of reportsInFile(ctx.analysis, ctx.rel)) {
      for (const c of r.columns) {
        if (!c.yaml) continue;
        const nameEnd = toPosition(ctx.index, c.yaml.column.nameRange[1]);
        if (!range.contains(nameEnd)) continue;
        // Put the hint at the end of the line so it does not split a trailing comment.
        const pos = doc.lineAt(nameEnd.line).range.end;
        if (c.status === 'inheritable') {
          const k = c.candidates[0];
          const label = new vscode.InlayHintLabelPart(`↳ ${k.fromLabel}: "${truncate(k.description, max)}"`);
          label.tooltip = new vscode.MarkdownString(
            `Can inherit from **${k.fromLabel}.${k.fromColumn}** (${kindLabel(k)})\n\n> ${k.description}\n\nClick to write ${
              k.docBlock ? `\`{{ doc('${k.docBlock}') }}\`` : 'the text'
            } into this file.`,
          );
          label.command = { title: 'Inherit', command: 'dbt-docs-helper.inherit', arguments: [ref(ctx, r, c), 0] };
          const hint = new vscode.InlayHint(pos, [label]);
          hint.paddingLeft = true;
          hints.push(hint);
        } else if (showBlocks && c.docBlock && c.description) {
          const hint = new vscode.InlayHint(pos, `= "${truncate(c.description, max)}"`);
          hint.paddingLeft = true;
          hint.tooltip = c.description;
          hints.push(hint);
        }
      }
    }
    return hints;
  }
}

// -----------------------------------------------------------------------------
// Hover

export class Hover implements vscode.HoverProvider {
  constructor(private readonly manager: ProjectManager) {}

  provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const ctx = context(this.manager, doc);
    if (!ctx) return undefined;
    const offset = doc.offsetAt(position);
    const { resource, column } = at(ctx, offset);
    if (!resource || !column?.yaml) return undefined;
    // Only when hovering the column name or its description.
    const y = column.yaml.column;
    const onName = offset >= y.nameRange[0] && offset <= y.nameRange[1];
    const onDesc = y.description && offset >= y.description.keyRange[0] && offset <= Math.max(y.description.valueRange[1], y.description.keyRange[1]);
    if (!onName && !onDesc) return undefined;

    const mdText = new vscode.MarkdownString(undefined, true);
    mdText.isTrusted = { enabledCommands: ['dbt-docs-helper.inherit', 'dbt-docs-helper.openLocation'] };
    mdText.appendMarkdown(`**${resource.label}.${column.name}** — ${statusLabel(column.status)}\n\n`);
    const project = ctx.state.project;
    if (column.status === 'documented') {
      if (column.docBlock) {
        const block = project.docBlocks().get(column.docBlock);
        mdText.appendMarkdown(`Doc block \`${column.docBlock}\`${block ? ` in \`${block.file}\`` : ' (not found)'}\n\n`);
      }
      if (column.description) mdText.appendMarkdown(quote(column.description));
      const others = blocksWithText(ctx.analysis, column.description).filter((b) => b !== column.docBlock);
      if (!column.docBlock && others.length > 0) mdText.appendMarkdown(`\n\nSame text as doc block \`${others[0]}\`.`);
    } else if (column.candidates.length > 0) {
      column.candidates.forEach((k, i) => {
        const args = encodeURIComponent(JSON.stringify([ref(ctx, resource, column), i]));
        mdText.appendMarkdown(`${i === 0 ? '' : '\n\n---\n\n'}↳ from **${k.fromLabel}.${k.fromColumn}** (${kindLabel(k)})`);
        if (k.docBlock) mdText.appendMarkdown(` via \`${k.docBlock}\``);
        mdText.appendMarkdown(`\n\n${quote(k.description)}\n\n`);
        mdText.appendMarkdown(`Lineage: ${chainLabel(project, k.chain)}\n\n`);
        mdText.appendMarkdown(`[Inherit](command:dbt-docs-helper.inherit?${args} "Write into this file")`);
      });
    } else {
      mdText.appendMarkdown(column.notInYaml ? 'Not in YAML.' : 'No upstream column with a description was found. This one must be written by hand.');
    }
    return new vscode.Hover(mdText, toRange(ctx.index, onName ? y.nameRange : y.description!.valueRange));
  }
}

function statusLabel(s: ColumnReport['status']): string {
  return s === 'documented' ? 'documented' : s === 'inheritable' ? 'can be inherited' : 'missing';
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
}

// -----------------------------------------------------------------------------
// Code actions

export class CodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.Source];

  constructor(private readonly manager: ProjectManager) {}

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, cc: vscode.CodeActionContext): vscode.CodeAction[] {
    const ctx = context(this.manager, doc);
    if (!ctx) return [];
    const actions: vscode.CodeAction[] = [];
    const { resource, column } = at(ctx, doc.offsetAt(range.start));
    const diagnostics = cc.diagnostics.filter((d) => d.source === 'dbt-docs-helper');

    if (resource && column?.yaml) {
      const r = ref(ctx, resource, column);
      const fixFor = (code: string) => diagnostics.filter((d) => d.code === code);

      if (column.status !== 'documented') {
        column.candidates.slice(0, 3).forEach((k, i) => {
          const value = inheritedValue(k);
          const title = k.docBlock
            ? `Inherit from ${k.fromLabel}: {{ doc('${k.docBlock}') }}`
            : `Inherit text from ${k.fromLabel}: "${truncate(k.description, 50)}"`;
          const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
          a.command = { title, command: 'dbt-docs-helper.inherit', arguments: [r, i] };
          a.diagnostics = fixFor('inheritable');
          a.isPreferred = i === 0 && isSafeInheritance(column);
          actions.push(a);
          if (!k.docBlock && value) {
            const t2 = `Move ${k.fromLabel}.${k.fromColumn}'s description to a doc block and link both`;
            const b = new vscode.CodeAction(t2, vscode.CodeActionKind.RefactorRewrite);
            b.command = { title: t2, command: 'dbt-docs-helper.moveToDocsBlock', arguments: [r, i] };
            actions.push(b);
          }
        });
      } else if (!column.docBlock && column.description && !hasDocRef(column.rawDescription)) {
        for (const name of blocksWithText(ctx.analysis, column.description).slice(0, 3)) {
          const t = `Link to doc block "${name}" (same text)`;
          const a = new vscode.CodeAction(t, vscode.CodeActionKind.QuickFix);
          a.command = { title: t, command: 'dbt-docs-helper.linkDocsBlock', arguments: [r, name] };
          a.diagnostics = fixFor('docs-block-candidate');
          a.isPreferred = true;
          actions.push(a);
        }
        const t = 'Move description to a doc block…';
        const a = new vscode.CodeAction(t, vscode.CodeActionKind.RefactorRewrite);
        a.command = { title: t, command: 'dbt-docs-helper.moveToDocsBlock', arguments: [r] };
        a.diagnostics = fixFor('docs-block-candidate');
        actions.push(a);
      }

      if (!docRefName(column.rawDescription)) {
        const t = 'Link to a doc block…';
        const a = new vscode.CodeAction(t, vscode.CodeActionKind.RefactorRewrite);
        a.command = { title: t, command: 'dbt-docs-helper.linkDocsBlock', arguments: [r] };
        actions.push(a);
      }

      if (column.status !== 'documented' || settings.aiEnabled()) {
        const t = 'Suggest a description with AI…';
        const a = new vscode.CodeAction(t, vscode.CodeActionKind.QuickFix);
        a.command = { title: t, command: 'dbt-docs-helper.suggestWithAi', arguments: [r] };
        a.diagnostics = fixFor('missing-description');
        if (settings.aiEnabled() || column.status === 'missing') actions.push(a);
      }
    }

    if (resource) {
      const notInYaml = resource.columns.filter((c) => c.notInYaml).length;
      if (notInYaml > 0) {
        const t = `Add ${notInYaml} missing column${notInYaml === 1 ? '' : 's'} to ${resource.label}`;
        const a = new vscode.CodeAction(t, vscode.CodeActionKind.QuickFix);
        a.command = { title: t, command: 'dbt-docs-helper.addMissingColumns', arguments: [ctx.state.project.root, resource.resource.uniqueId] };
        a.diagnostics = diagnostics.filter((d) => d.code === 'columns-not-in-yaml');
        actions.push(a);
      }
      const inheritable = resource.columns.filter((c) => c.status === 'inheritable').length;
      if (inheritable > 1) {
        const t = `Inherit all safe descriptions in ${resource.label}`;
        const a = new vscode.CodeAction(t, vscode.CodeActionKind.Source);
        a.command = { title: t, command: 'dbt-docs-helper.inheritAll', arguments: [{ root: ctx.state.project.root, resourceId: resource.resource.uniqueId }] };
        actions.push(a);
      }
    }

    const sourceAll = new vscode.CodeAction('Inherit all safe descriptions in this file', vscode.CodeActionKind.Source.append('dbtDocsHelper.inheritAll'));
    sourceAll.command = { title: sourceAll.title, command: 'dbt-docs-helper.inheritAll', arguments: [doc.uri] };
    actions.push(sourceAll);
    return actions;
  }
}
