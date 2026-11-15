import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  addColumns,
  Analysis,
  blocksWithText,
  ColumnReport,
  DbtProject,
  docBlockAppendText,
  docBlockName,
  docRef,
  docsBlockCandidates,
  inheritedValue,
  isSafeInheritance,
  ResourceReport,
  setColumnDescription,
  setColumnDataType,
  removeColumnDataType,
  formatType,
  setResourceDescription,
  TextEdit,
  YamlColumn,
} from '@dbt-docs-helper/core';
import { settings } from './config';
import { ProjectManager } from './projectManager';
import { ColumnRef, fileUri, findColumn, toPosition, toRange, truncate } from './util';
import { suggestWithAi } from './ai';

export class Commands {
  constructor(private readonly manager: ProjectManager) {}

  register(context: vscode.ExtensionContext): void {
    const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    reg('dbt-docs-helper.refresh', () => this.manager.discover());
    reg('dbt-docs-helper.runParse', (root?: string) => this.manager.runParse(typeof root === 'string' ? root : undefined));
    reg('dbt-docs-helper.inherit', (ref: ColumnRef, candidate = 0) => this.inherit(ref, candidate));
    reg('dbt-docs-helper.inheritAll', (arg?: vscode.Uri | { root: string; resourceId: string }) => this.inheritAll(arg));
    reg('dbt-docs-helper.linkDocsBlock', (ref: ColumnRef, block?: string) => this.linkDocsBlock(ref, block));
    reg('dbt-docs-helper.moveToDocsBlock', (ref: ColumnRef, fromCandidate?: number) => this.moveToDocsBlock(ref, fromCandidate));
    reg('dbt-docs-helper.addMissingColumns', (root: string, resourceId: string) => this.addMissingColumns(root, resourceId));
    reg('dbt-docs-helper.editDescription', (ref: ColumnRef) => this.editDescription(ref));
    reg('dbt-docs-helper.editModelDescription', (root: string, resourceId: string) => this.editModelDescription(root, resourceId));
    reg('dbt-docs-helper.setDataType', (ref: ColumnRef, type?: string) => this.setDataType(ref, type));
    reg('dbt-docs-helper.setAllDataTypes', (arg?: vscode.Uri | { root: string; resourceId: string }, fixMismatches?: boolean) =>
      this.setAllDataTypes(arg, fixMismatches === true),
    );
    reg('dbt-docs-helper.suggestWithAi', (ref: ColumnRef) => this.suggest(ref));
    reg('dbt-docs-helper.createDocsBlockForCandidate', (arg: { root: string; column: string }) => this.createBlockForCandidate(arg));
    reg('dbt-docs-helper.openLocation', (root: string, file: string, offset: number) => this.open(root, file, offset));
    reg('dbt-docs-helper.showOutput', () => this.manager.output.show());
  }

  // ---------------------------------------------------------------------------

  private get(ref: ColumnRef) {
    const state = this.manager.projects().find((s) => s.project.root === ref.root);
    if (!state) return undefined;
    const analysis = this.manager.analysis(state.project);
    const found = findColumn(analysis, ref);
    return found ? { project: state.project, analysis, ...found } : undefined;
  }

  private columnEdit(edit: vscode.WorkspaceEdit, project: DbtProject, file: string, column: YamlColumn, value: string): void {
    const index = project.yamlFiles.get(file);
    if (!index) return;
    const te = setColumnDescription(index, column, value);
    edit.replace(fileUri(project, file), toRange(index, [te.start, te.end]), te.newText);
  }

  private textEdits(edit: vscode.WorkspaceEdit, project: DbtProject, file: string, edits: TextEdit[]): void {
    const index = project.yamlFiles.get(file);
    if (!index) return;
    for (const te of edits) edit.replace(fileUri(project, file), toRange(index, [te.start, te.end]), te.newText);
  }

  async inherit(ref: ColumnRef, candidateIndex = 0): Promise<void> {
    const found = this.get(ref);
    const cand = found?.column.candidates[candidateIndex];
    if (!found || !cand || !found.column.yaml) return;
    const edit = new vscode.WorkspaceEdit();
    this.columnEdit(edit, found.project, found.column.yaml.file, found.column.yaml.column, inheritedValue(cand));
    await vscode.workspace.applyEdit(edit);
  }

  async inheritAll(arg?: vscode.Uri | { root: string; resourceId: string }): Promise<void> {
    let targets: { project: DbtProject; analysis: Analysis; resources: ResourceReport[] } | undefined;
    if (arg && !(arg instanceof vscode.Uri) && 'resourceId' in arg) {
      const state = this.manager.projects().find((s) => s.project.root === arg.root);
      if (state) {
        const analysis = this.manager.analysis(state.project);
        const r = analysis.resources.get(arg.resourceId);
        targets = { project: state.project, analysis, resources: r ? [r] : [] };
      }
    } else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      const found = uri && this.manager.analysisFor(uri);
      if (found && uri) {
        const rel = found.state.project.relative(uri.fsPath);
        targets = {
          project: found.state.project,
          analysis: found.analysis,
          resources: [...found.analysis.resources.values()].filter((r) => r.yaml?.file === rel),
        };
      }
    }
    if (!targets || targets.resources.length === 0) {
      void vscode.window.showInformationMessage('dbt-docs-helper: open a dbt YAML file with models to inherit descriptions.');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    let applied = 0;
    let skipped = 0;
    for (const r of targets.resources) {
      for (const c of r.columns) {
        if (c.status !== 'inheritable') continue;
        if (!isSafeInheritance(c)) {
          skipped++;
          continue;
        }
        this.columnEdit(edit, targets.project, c.yaml!.file, c.yaml!.column, inheritedValue(c.candidates[0]));
        applied++;
      }
    }
    if (applied > 0) await vscode.workspace.applyEdit(edit);
    const skippedText = skipped > 0 ? ` ${skipped} skipped (renamed, transformed, matched only by name or ambiguous): use the quick fixes for those.` : '';
    void vscode.window.showInformationMessage(`dbt-docs-helper: inherited ${applied} description${applied === 1 ? '' : 's'}.${skippedText}`);
  }

  // ---------------------------------------------------------------------------
  // Doc blocks

  async linkDocsBlock(ref: ColumnRef, blockName?: string): Promise<void> {
    const found = this.get(ref);
    if (!found?.column.yaml) return;
    const { project, analysis, column } = found;
    let name = blockName;
    if (!name) {
      const sameText = new Set(column.description ? blocksWithText(analysis, column.description) : []);
      const suffix = `__${column.name.toLowerCase()}`;
      const items = [...project.docBlocks().values()]
        .map((b) => ({
          label: b.name,
          description: sameText.has(b.name) ? 'same text' : b.name.toLowerCase().endsWith(suffix) ? 'same column name' : undefined,
          detail: truncate(b.contents, 120),
          rank: sameText.has(b.name) ? 0 : b.name.toLowerCase().endsWith(suffix) ? 1 : 2,
        }))
        .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
      if (items.length === 0) {
        void vscode.window.showInformationMessage('dbt-docs-helper: the project has no doc blocks yet. Use "Move to docs block" to create one.');
        return;
      }
      const pick = await vscode.window.showQuickPick(items, { placeHolder: `Doc block for ${found.resource.label}.${column.name}`, matchOnDetail: true });
      if (!pick) return;
      name = pick.label;
    }
    const edit = new vscode.WorkspaceEdit();
    this.columnEdit(edit, project, column.yaml!.file, column.yaml!.column, docRef(name));
    await vscode.workspace.applyEdit(edit);
  }

  /**
   * Create a doc block from a description and link to it. With
   * `fromCandidate`, the text comes from an upstream column, and both the
   * upstream column and this column are linked.
   */
  async moveToDocsBlock(ref: ColumnRef, fromCandidate?: number): Promise<void> {
    const found = this.get(ref);
    if (!found) return;
    const { project, analysis, column, resource } = found;
    const pattern = settings.namePattern(vscode.Uri.file(project.root));

    let text: string;
    let originResource = resource.resource;
    let originColumn = column.name;
    const targets: { file: string; column: YamlColumn }[] = [];
    if (fromCandidate !== undefined) {
      const cand = column.candidates[fromCandidate];
      if (!cand) return;
      text = cand.description;
      const up = analysis.resources.get(cand.fromId);
      const upCol = up?.columns.find((c) => c.name.toLowerCase() === cand.fromColumn.toLowerCase());
      if (up) originResource = up.resource;
      originColumn = cand.fromColumn;
      if (upCol?.yaml) targets.push(upCol.yaml);
    } else {
      text = column.description;
      const origin = analysis.originOf(resource.resource, column.name);
      originResource = origin.resource;
      originColumn = origin.column;
    }
    if (column.yaml) targets.push(column.yaml);
    if (!text.trim()) {
      void vscode.window.showInformationMessage('dbt-docs-helper: there is no description to move. Write one first, or link an existing doc block.');
      return;
    }

    // Name
    const blocks = project.docBlocks();
    const suggested = docBlockName(pattern, originResource, originColumn);
    const name = await vscode.window.showInputBox({
      title: 'Doc block name',
      value: suggested,
      prompt: `Pattern: ${pattern}`,
      validateInput: (v) => {
        if (!/^[A-Za-z_]\w*$/.test(v)) return 'Use letters, digits and underscores only.';
        const existing = blocks.get(v);
        if (existing && existing.contents.trim() !== text.trim()) return `A doc block named "${v}" already exists with a different text.`;
        return undefined;
      },
    });
    if (!name) return;

    // Other columns with exactly the same text can be linked at the same time.
    const others: { label: string; description: string; picked: boolean; target: { file: string; column: YamlColumn } }[] = [];
    for (const r of analysis.resources.values()) {
      for (const c of r.columns) {
        if (!c.yaml || c.docBlock || targets.some((t) => t.file === c.yaml!.file && t.column.range[0] === c.yaml!.column.range[0])) continue;
        if (c.status === 'documented' && c.description.trim() === text.trim()) {
          others.push({ label: `${r.label}.${c.name}`, description: 'same text', picked: true, target: c.yaml });
        } else if (c.status !== 'documented' && c.name.toLowerCase() === originColumn.toLowerCase() && c.candidates.some((k) => k.description.trim() === text.trim())) {
          others.push({ label: `${r.label}.${c.name}`, description: 'inherits this text', picked: true, target: c.yaml });
        }
      }
    }
    if (others.length > 0) {
      const picks = await vscode.window.showQuickPick(others, {
        canPickMany: true,
        title: `Also link ${others.length} other column${others.length === 1 ? '' : 's'} to "${name}"?`,
        placeHolder: 'Unselect the ones that should keep their own description',
      });
      if (picks === undefined) return;
      targets.push(...picks.map((p) => p.target));
    }

    const edit = new vscode.WorkspaceEdit();
    if (!blocks.has(name)) {
      const file = await this.chooseDocsFile(project);
      if (!file) return;
      await this.appendBlock(edit, project, file, name, text);
    }
    const byFile = new Map<string, TextEdit[]>();
    for (const t of targets) {
      const index = project.yamlFiles.get(t.file);
      if (!index) continue;
      const list = byFile.get(t.file) ?? [];
      list.push(setColumnDescription(index, t.column, docRef(name)));
      byFile.set(t.file, list);
    }
    for (const [file, list] of byFile) this.textEdits(edit, project, file, list);
    await vscode.workspace.applyEdit(edit);
  }

  private async chooseDocsFile(project: DbtProject): Promise<string | undefined> {
    const configured = settings.defaultDocsFile(vscode.Uri.file(project.root));
    if (configured) return configured.replace(/\\/g, '/');
    const stateKey = `docsFile:${project.root}`;
    const last = this.manager.extensionContext.workspaceState.get<string>(stateKey);
    const files = project.docFilePaths();
    type Item = vscode.QuickPickItem & { file?: string };
    const items: Item[] = [];
    if (last) items.push({ label: last, description: 'last used', file: last });
    for (const f of files) if (f !== last) items.push({ label: f, file: f, description: `${project.docFiles.get(f)?.length ?? 0} blocks` });
    items.push({ label: '$(new-file) New file…' });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Where should the doc block be saved?',
      placeHolder: 'Tip: set "dbt-docs-helper.docsBlocks.defaultFile" to skip this question',
    });
    if (!pick) return undefined;
    let file = pick.file;
    if (!file) {
      file = await vscode.window.showInputBox({
        title: 'New docs file (relative to the dbt project)',
        value: `${project.config.modelPaths[0] ?? 'models'}/_docs/columns.md`,
        validateInput: (v) => (v.toLowerCase().endsWith('.md') ? undefined : 'Doc blocks must be in a .md file.'),
      });
      if (!file) return undefined;
      file = file.replace(/\\/g, '/');
      const inDocsPaths = project.config.docsPaths.some((d) => file!.startsWith(`${d.replace(/\/$/, '')}/`));
      if (!inDocsPaths) {
        void vscode.window.showWarningMessage(
          `dbt-docs-helper: "${file}" is not inside docs-paths (${project.config.docsPaths.join(', ')}), so dbt will not find it.`,
        );
      }
    }
    await this.manager.extensionContext.workspaceState.update(stateKey, file);
    return file;
  }

  private async appendBlock(edit: vscode.WorkspaceEdit, project: DbtProject, file: string, name: string, text: string): Promise<void> {
    const uri = fileUri(project, file);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    let existing: string | undefined;
    if (open) existing = open.getText();
    else if (fs.existsSync(uri.fsPath)) existing = fs.readFileSync(uri.fsPath, 'utf8');
    if (existing === undefined) {
      edit.createFile(uri, { ignoreIfExists: true });
      edit.insert(uri, new vscode.Position(0, 0), docBlockAppendText('', name, text));
      return;
    }
    const lines = existing.split('\n');
    const end = new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
    edit.insert(uri, end, docBlockAppendText(existing, name, text));
  }

  async createBlockForCandidate(arg: { root: string; column: string }): Promise<void> {
    const state = this.manager.projects().find((s) => s.project.root === arg.root);
    if (!state) return;
    const analysis = this.manager.analysis(state.project);
    const cand = docsBlockCandidates(analysis, { minModels: 1, sharedNamePattern: settings.sharedNamePattern(vscode.Uri.file(state.project.root)) }).find((c) => c.column === arg.column);
    if (!cand) return;
    let text = cand.descriptions[0] ?? '';
    if (cand.descriptions.length > 1) {
      const pick = await vscode.window.showQuickPick(
        cand.descriptions.map((d) => ({ label: truncate(d, 100), detail: d.length > 100 ? d : undefined, text: d })),
        { title: `"${cand.column}" has ${cand.descriptions.length} different descriptions. Which one should the doc block use?` },
      );
      if (!pick) return;
      text = pick.text;
    }
    if (!text) {
      text =
        (await vscode.window.showInputBox({ title: `Description for "${cand.column}"`, prompt: 'No model has a description for this column yet.' })) ??
        '';
      if (!text) return;
    }
    const existingBlocks = state.project.docBlocks();
    const name = await vscode.window.showInputBox({
      title: 'Doc block name',
      value: cand.suggestedName,
      validateInput: (v) => {
        if (!/^[A-Za-z_]\w*$/.test(v)) return 'Use letters, digits and underscores only.';
        const existing = existingBlocks.get(v);
        if (existing && existing.contents.trim() !== text.trim()) return `A doc block named "${v}" already exists with a different text.`;
        return undefined;
      },
    });
    if (!name) return;
    const items = cand.usages
      .filter((u) => u.column.yaml)
      .map((u) => ({
        label: `${u.label}.${u.column.name}`,
        description: u.column.docBlock ? `→ ${u.column.docBlock}` : u.column.description ? truncate(u.column.description, 60) : '(no description)',
        picked: !u.column.docBlock && (!u.column.description || u.column.description.trim() === text.trim()),
        usage: u,
      }));
    const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: `Link these columns to "${name}"` });
    if (!picks) return;
    const edit = new vscode.WorkspaceEdit();
    const blocks = state.project.docBlocks();
    if (!blocks.has(name)) {
      const file = await this.chooseDocsFile(state.project);
      if (!file) return;
      await this.appendBlock(edit, state.project, file, name, text);
    }
    const byFile = new Map<string, TextEdit[]>();
    for (const p of picks) {
      const y = p.usage.column.yaml!;
      const index = state.project.yamlFiles.get(y.file);
      if (!index) continue;
      const list = byFile.get(y.file) ?? [];
      list.push(setColumnDescription(index, y.column, docRef(name)));
      byFile.set(y.file, list);
    }
    for (const [file, list] of byFile) this.textEdits(edit, state.project, file, list);
    await vscode.workspace.applyEdit(edit);
  }

  // ---------------------------------------------------------------------------

  async addMissingColumns(root: string, resourceId: string): Promise<void> {
    const state = this.manager.projects().find((s) => s.project.root === root);
    if (!state) return;
    const analysis = this.manager.analysis(state.project);
    const r = analysis.resources.get(resourceId);
    if (!r?.yaml) return;
    const missing = r.columns.filter((c) => c.notInYaml);
    if (missing.length === 0) return;
    const withInheritance = missing.map((c) => ({ c, cand: analysis.findInheritance(r.resource, c.name)[0] }));
    let includeDescriptions = false;
    if (withInheritance.some((x) => x.cand)) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Names and inherited descriptions', include: true },
          { label: 'Names only', include: false },
        ],
        { title: `Add ${missing.length} column${missing.length === 1 ? '' : 's'} to ${r.label}` },
      );
      if (!pick) return;
      includeDescriptions = pick.include;
    }
    const index = state.project.yamlFiles.get(r.yaml.file)!;
    const te = addColumns(
      index,
      r.yaml.resource,
      withInheritance.map(({ c, cand }) => ({ name: c.name, description: includeDescriptions && cand ? inheritedValue(cand) : undefined })),
    );
    if (!te) {
      void vscode.window.showWarningMessage('dbt-docs-helper: cannot add columns to a flow-style (inline) YAML mapping.');
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    this.textEdits(edit, state.project, r.yaml.file, [te]);
    await vscode.workspace.applyEdit(edit);
  }

  /** Write or change a column description in an input box. */
  async editDescription(ref: ColumnRef): Promise<void> {
    const found = this.get(ref);
    const yaml = found?.column.yaml;
    if (!found || !yaml) return;
    const { column } = found;
    const value = await vscode.window.showInputBox({
      title: `Description for ${found.resource.label}.${column.name}`,
      value: column.rawDescription || column.candidates[0]?.description || '',
      prompt: column.rawDescription ? undefined : column.candidates[0] ? `Prefilled from ${column.candidates[0].fromLabel}` : undefined,
    });
    if (value === undefined || value === column.rawDescription) return;
    const edit = new vscode.WorkspaceEdit();
    this.columnEdit(edit, found.project, yaml.file, yaml.column, value);
    await vscode.workspace.applyEdit(edit);
  }

  /** Write or change a model description in an input box. */
  async editModelDescription(root: string, resourceId: string): Promise<void> {
    const state = this.manager.projects().find((s) => s.project.root === root);
    if (!state) return;
    const r = this.manager.analysis(state.project).resources.get(resourceId);
    const y = r?.yaml;
    if (!r || !y) return;
    const current = y.resource.description?.value ?? '';
    const value = await vscode.window.showInputBox({ title: `Description for ${r.label}`, value: current });
    if (value === undefined || value === current) return;
    const index = state.project.yamlFiles.get(y.file);
    if (!index) return;
    const edit = new vscode.WorkspaceEdit();
    this.textEdits(edit, state.project, y.file, [setResourceDescription(index, y.resource, value)]);
    await vscode.workspace.applyEdit(edit);
  }

  /**
   * Set `data_type` of a column: the given type, or the suggested one. An
   * empty string removes it.
   */
  async setDataType(ref: ColumnRef, type?: string): Promise<void> {
    const found = this.get(ref);
    const yaml = found?.column.yaml;
    if (!found || !yaml) return;
    const value = type ?? found.column.typeSuggestion?.type;
    if (value === undefined) return;
    const index = found.project.yamlFiles.get(yaml.file);
    if (!index) return;
    const te =
      value.trim() === ''
        ? removeColumnDataType(index, yaml.column)
        : setColumnDataType(index, yaml.column, formatType(value, settings.typeCase(vscode.Uri.file(found.project.root))));
    if (!te) return;
    const edit = new vscode.WorkspaceEdit();
    this.textEdits(edit, found.project, yaml.file, [te]);
    await vscode.workspace.applyEdit(edit);
  }

  /** Set every suggested `data_type` that is missing in a model or a file (and, if asked, fix mismatches). */
  async setAllDataTypes(arg: vscode.Uri | { root: string; resourceId: string } | undefined, fixMismatches: boolean): Promise<number> {
    const targets = this.resolveTargets(arg);
    if (!targets) return 0;
    const typeCase = settings.typeCase(vscode.Uri.file(targets.project.root));
    const byFile = new Map<string, TextEdit[]>();
    let count = 0;
    for (const r of targets.resources) {
      for (const c of r.columns) {
        if (!c.yaml) continue;
        let type: string | undefined;
        if (!c.dataType && c.typeSuggestion) type = c.typeSuggestion.type;
        else if (fixMismatches && c.typeMismatch) type = c.typeMismatch.warehouse;
        if (!type) continue;
        const index = targets.project.yamlFiles.get(c.yaml.file);
        if (!index) continue;
        const list = byFile.get(c.yaml.file) ?? [];
        list.push(setColumnDataType(index, c.yaml.column, formatType(type, typeCase)));
        byFile.set(c.yaml.file, list);
        count++;
      }
    }
    if (count > 0) {
      const edit = new vscode.WorkspaceEdit();
      for (const [file, list] of byFile) this.textEdits(edit, targets.project, file, list);
      await vscode.workspace.applyEdit(edit);
    }
    void vscode.window.showInformationMessage(
      count > 0 ? `dbt-docs-helper: set ${count} data type${count === 1 ? '' : 's'}.` : 'dbt-docs-helper: no data types to set (none missing, or nothing known about them).',
    );
    return count;
  }

  /** A model (by id) or every model in a YAML file (by uri, default: the active editor). */
  private resolveTargets(arg: vscode.Uri | { root: string; resourceId: string } | undefined): { project: DbtProject; resources: ResourceReport[] } | undefined {
    if (arg && !(arg instanceof vscode.Uri) && 'resourceId' in arg) {
      const state = this.manager.projects().find((s) => s.project.root === arg.root);
      const r = state && this.manager.analysis(state.project).resources.get(arg.resourceId);
      return state && r ? { project: state.project, resources: [r] } : undefined;
    }
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    const found = uri && this.manager.analysisFor(uri);
    if (!found || !uri) return undefined;
    const rel = found.state.project.relative(uri.fsPath);
    return { project: found.state.project, resources: [...found.analysis.resources.values()].filter((r) => r.yaml?.file === rel) };
  }

  async suggest(ref: ColumnRef): Promise<void> {
    const found = this.get(ref);
    if (!found?.column.yaml) return;
    const text = await suggestWithAi(found.analysis, found.resource, found.column);
    if (!text) return;
    const edit = new vscode.WorkspaceEdit();
    this.columnEdit(edit, found.project, found.column.yaml.file, found.column.yaml.column, text);
    await vscode.workspace.applyEdit(edit);
  }

  async open(root: string, file: string, offset: number): Promise<void> {
    const state = this.manager.projects().find((s) => s.project.root === root);
    const abs = state ? state.project.absolute(file) : path.join(root, file);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
    const index = state?.project.yamlFiles.get(file);
    const pos = index && offset >= 0 ? toPosition(index, offset) : doc.positionAt(Math.max(0, offset));
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }
}
