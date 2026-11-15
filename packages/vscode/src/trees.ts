import * as vscode from 'vscode';
import {
  addResource,
  Analysis,
  emptyCounts,
  groupKeys,
  ColumnReport,
  coverage,
  CoverageCounts,
  docsBlockCandidates,
  DocsBlockCandidate,
  GroupBy,
  percent,
  ResourceReport,
  workList,
} from '@dbt-docs-helper/core';
import { settings } from './config';
import { ProjectManager, ProjectState } from './projectManager';
import { truncate } from './util';

type Node =
  | { type: 'project'; state: ProjectState }
  | { type: 'group'; state: ProjectState; key: string; counts: CoverageCounts; by: GroupBy }
  | { type: 'resource'; state: ProjectState; report: ResourceReport }
  | { type: 'column'; state: ProjectState; report: ResourceReport; column: ColumnReport }
  | { type: 'section'; state: ProjectState; status: 'missing' | 'inheritable'; items: { report: ResourceReport; column: ColumnReport }[] }
  | { type: 'notInYamlSection'; state: ProjectState; reports: ResourceReport[] }
  | { type: 'notInYaml'; state: ProjectState; report: ResourceReport }
  | { type: 'candidate'; state: ProjectState; candidate: DocsBlockCandidate }
  | { type: 'usage'; state: ProjectState; report: ResourceReport; column: ColumnReport }
  | { type: 'message'; text: string; command?: vscode.Command };

const MAX_ITEMS = 500;

function pctLabel(c: CoverageCounts): string {
  const strict = percent(c).toFixed(0);
  const inh = c.inheritable > 0 ? ` (+${c.inheritable} inheritable)` : '';
  return `${strict}% · ${c.documented}/${c.columns}${inh}`;
}

function statusIcon(c: ColumnReport): vscode.ThemeIcon {
  if (c.status === 'documented') return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
  if (c.status === 'inheritable') return new vscode.ThemeIcon('arrow-circle-down', new vscode.ThemeColor('charts.blue'));
  return new vscode.ThemeIcon('circle-large-outline', new vscode.ThemeColor('problemsWarningIcon.foreground'));
}

/**
 * Open the column in YAML, else the resource in YAML, else the resource's own
 * file (SQL/CSV), e.g. for columns that are only in catalog.json.
 */
function openCommand(state: ProjectState, report: ResourceReport, column?: ColumnReport): vscode.Command | undefined {
  const file = column?.yaml?.file ?? report.yaml?.file ?? (report.resource.originalFilePath || undefined);
  if (!file) return undefined;
  const offset = column?.yaml?.column.nameRange[0] ?? report.yaml?.resource.nameRange[0] ?? 0;
  return { title: 'Open', command: 'dbt-docs-helper.openLocation', arguments: [state.project.root, file, offset] };
}

function columnItem(state: ProjectState, report: ResourceReport, column: ColumnReport, withResource: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(withResource ? `${report.label}.${column.name}` : column.name);
  item.iconPath = statusIcon(column);
  if (column.status === 'inheritable') {
    const k = column.candidates[0];
    item.description = `↳ ${k.fromLabel}`;
    item.tooltip = new vscode.MarkdownString(`Can inherit from **${k.fromLabel}.${k.fromColumn}** (${k.kind})\n\n> ${k.description}`);
  } else if (column.status === 'documented') {
    item.description = column.docBlock ? `{{ doc('${column.docBlock}') }}` : truncate(column.description, 60);
    item.tooltip = column.description;
  } else {
    item.description = column.notInYaml ? 'not in YAML' : 'write by hand';
  }
  item.command = openCommand(state, report, column);
  item.contextValue = `column-${column.status}`;
  return item;
}

abstract class BaseTree implements vscode.TreeDataProvider<Node> {
  protected emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(protected readonly manager: ProjectManager) {
    manager.onDidChange(() => this.emitter.fire(undefined));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  protected analysis(state: ProjectState): Analysis {
    return this.manager.analysis(state.project);
  }

  protected roots(): Node[] {
    const projects = this.manager.projects();
    if (projects.length === 0) {
      const failures = [...this.manager.failures()];
      if (failures.length > 0) {
        return [
          { type: 'message', text: `manifest.json not found or unreadable (${failures.length} project${failures.length === 1 ? '' : 's'})`, command: { title: 'Show log', command: 'dbt-docs-helper.showOutput' } },
          { type: 'message', text: 'Run dbt parse', command: { title: 'Run dbt parse', command: 'dbt-docs-helper.runParse', arguments: [failures[0][0]] } },
        ];
      }
      return [{ type: 'message', text: 'No dbt project found in the workspace' }];
    }
    if (projects.length === 1) return this.projectChildren(projects[0]);
    return projects.map((state) => ({ type: 'project', state }));
  }

  protected abstract projectChildren(state: ProjectState): Node[];

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();
    if (node.type === 'project') return this.projectChildren(node.state);
    return this.children(node);
  }

  protected abstract children(node: Node): Node[];

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'project': {
        const item = new vscode.TreeItem(node.state.project.config.name, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('database');
        item.description = node.state.stale?.stale ? '⚠ manifest out of date' : vscode.workspace.asRelativePath(node.state.project.root);
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.command = node.command;
        item.iconPath = new vscode.ThemeIcon(node.command ? 'run' : 'info');
        return item;
      }
      default:
        return this.item(node);
    }
  }

  protected abstract item(node: Node): vscode.TreeItem;
}

// -----------------------------------------------------------------------------

export class CoverageTree extends BaseTree {
  protected projectChildren(state: ProjectState): Node[] {
    const by = settings.groupBy();
    const report = coverage(this.analysis(state), by);
    const nodes: Node[] = [];
    if (state.stale?.stale) {
      nodes.push({ type: 'message', text: 'manifest.json is out of date — run dbt parse', command: { title: 'Run dbt parse', command: 'dbt-docs-helper.runParse', arguments: [state.project.root] } });
    }
    nodes.push({ type: 'group', state, key: `Total`, counts: report.total, by });
    for (const g of report.groups) nodes.push({ type: 'group', state, key: g.key, counts: g, by });
    return nodes;
  }

  protected children(node: Node): Node[] {
    if (node.type === 'group') {
      const analysis = this.analysis(node.state);
      const reports = [...analysis.resources.values()].filter((r) => node.key === 'Total' || groupKeys(r, node.by).includes(node.key));
      if (node.key === 'Total') return [];
      return reports
        .sort((a, b) => percent(countsOf(a)) - percent(countsOf(b)) || a.label.localeCompare(b.label))
        .map((report) => ({ type: 'resource', state: node.state, report }));
    }
    if (node.type === 'resource') {
      return node.report.columns.map((column) => ({ type: 'column', state: node.state, report: node.report, column }));
    }
    return [];
  }

  protected item(node: Node): vscode.TreeItem {
    switch (node.type) {
      case 'group': {
        const total = node.key === 'Total';
        const item = new vscode.TreeItem(total ? 'Total' : node.key, total ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
        item.description = pctLabel(node.counts);
        item.iconPath = new vscode.ThemeIcon(total ? 'graph' : node.by === 'folder' ? 'folder' : node.by === 'tag' ? 'tag' : node.by === 'owner' ? 'person' : 'layers');
        item.tooltip = new vscode.MarkdownString(
          `**${node.key}**\n\n| | |\n|---|---:|\n| Columns | ${node.counts.columns} |\n| Documented | ${node.counts.documented} |\n| Inheritable | ${node.counts.inheritable} |\n| Missing | ${node.counts.missing} |\n| Coverage | ${percent(node.counts).toFixed(1)}% |\n| With inheritance | ${percent(node.counts, true).toFixed(1)}% |\n| Resources with description | ${node.counts.resourcesWithDescription}/${node.counts.resources} |`,
        );
        return item;
      }
      case 'resource': {
        const c = countsOf(node.report);
        const item = new vscode.TreeItem(node.report.label, c.columns > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.description = pctLabel(c) + (node.report.hasDescription ? '' : ' · no description');
        item.iconPath = new vscode.ThemeIcon(node.report.resource.kind === 'source' ? 'plug' : node.report.resource.kind === 'seed' ? 'file' : 'symbol-class');
        item.command = openCommand(node.state, node.report);
        item.contextValue = 'resource';
        return item;
      }
      case 'column':
        return columnItem(node.state, node.report, node.column, false);
      default:
        return new vscode.TreeItem('');
    }
  }
}

function countsOf(r: ResourceReport): CoverageCounts {
  const c = emptyCounts();
  addResource(c, r);
  return c;
}

// -----------------------------------------------------------------------------

export class WorkListTree extends BaseTree {
  protected projectChildren(state: ProjectState): Node[] {
    const items = workList(this.analysis(state)).map((i) => ({ report: i.resource, column: i.column }));
    const missing = items.filter((i) => i.column.status === 'missing');
    const inheritable = items.filter((i) => i.column.status === 'inheritable');
    const notInYaml = [...this.analysis(state).resources.values()]
      .filter((r) => r.columns.some((c) => c.notInYaml))
      .sort((a, b) => a.label.localeCompare(b.label));
    if (items.length === 0 && notInYaml.length === 0) return [{ type: 'message', text: 'Every column is documented 🎉' }];
    const nodes: Node[] = [
      { type: 'section', state, status: 'missing', items: missing },
      { type: 'section', state, status: 'inheritable', items: inheritable },
    ];
    if (notInYaml.length > 0) nodes.push({ type: 'notInYamlSection', state, reports: notInYaml });
    return nodes;
  }

  protected children(node: Node): Node[] {
    if (node.type === 'notInYamlSection') return node.reports.map((report) => ({ type: 'notInYaml', state: node.state, report }));
    if (node.type !== 'section') return [];
    return node.items.slice(0, MAX_ITEMS).map((i) => ({ type: 'column', state: node.state, report: i.report, column: i.column }));
  }

  protected item(node: Node): vscode.TreeItem {
    if (node.type === 'section') {
      const item = new vscode.TreeItem(
        node.status === 'missing' ? 'Write by hand' : 'Can be inherited',
        node.status === 'missing' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${node.items.length}${node.items.length > MAX_ITEMS ? ` (showing ${MAX_ITEMS})` : ''}`;
      item.iconPath = new vscode.ThemeIcon(node.status === 'missing' ? 'edit' : 'arrow-circle-down');
      return item;
    }
    if (node.type === 'notInYamlSection') {
      const item = new vscode.TreeItem('Not in YAML', vscode.TreeItemCollapsibleState.Collapsed);
      const count = node.reports.reduce((n, r) => n + r.columns.filter((c) => c.notInYaml).length, 0);
      item.description = `${count} columns in ${node.reports.length} models`;
      item.tooltip = 'Columns that exist in the warehouse (catalog.json) but are not listed in YAML.';
      item.iconPath = new vscode.ThemeIcon('database');
      return item;
    }
    if (node.type === 'notInYaml') {
      const cols = node.report.columns.filter((c) => c.notInYaml).map((c) => c.name);
      const item = new vscode.TreeItem(node.report.label);
      item.description = cols.join(', ');
      item.tooltip = node.report.yaml
        ? `Not in ${node.report.yaml.file}: ${cols.join(', ')}. Use the + button to add them.`
        : `${node.report.label} has no YAML entry yet. Columns: ${cols.join(', ')}`;
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = openCommand(node.state, node.report);
      item.contextValue = node.report.yaml ? 'notInYaml-addable' : 'notInYaml';
      return item;
    }
    if (node.type === 'column') return columnItem(node.state, node.report, node.column, true);
    return new vscode.TreeItem('');
  }
}

// -----------------------------------------------------------------------------

export class CandidatesTree extends BaseTree {
  protected projectChildren(state: ProjectState): Node[] {
    const scope = vscode.Uri.file(state.project.root);
    const list = docsBlockCandidates(this.analysis(state), { minModels: settings.minModels(scope), sharedNamePattern: settings.sharedNamePattern(scope) });
    if (list.length === 0) return [{ type: 'message', text: 'No columns to share as doc blocks' }];
    return list.slice(0, MAX_ITEMS).map((candidate) => ({ type: 'candidate', state, candidate }));
  }

  protected children(node: Node): Node[] {
    if (node.type !== 'candidate') return [];
    const analysis = this.analysis(node.state);
    return node.candidate.usages
      .map((u) => ({ report: analysis.resources.get(u.resourceId)!, column: u.column }))
      .filter((u) => u.report)
      .map((u) => ({ type: 'usage', state: node.state, report: u.report, column: u.column }));
  }

  protected item(node: Node): vscode.TreeItem {
    if (node.type === 'candidate') {
      const c = node.candidate;
      const item = new vscode.TreeItem(c.column, vscode.TreeItemCollapsibleState.Collapsed);
      const texts = c.sameText ? 'same text' : c.descriptions.length === 0 ? 'no text yet' : `${c.descriptions.length} texts`;
      item.description = `${c.usages.length} models · ${texts}${c.docBlocks.length ? ` · ${c.docBlocks.join(', ')}` : ''}`;
      item.iconPath = new vscode.ThemeIcon(c.sameText ? 'star-full' : 'symbol-field');
      item.tooltip = new vscode.MarkdownString(
        `Suggested doc block: \`${c.suggestedName}\`\n\n${c.descriptions.map((d) => `- ${truncate(d, 120)}`).join('\n')}`,
      );
      item.contextValue = 'candidate';
      return item;
    }
    if (node.type === 'usage') return columnItem(node.state, node.report, node.column, true);
    return new vscode.TreeItem('');
  }
}

/** Argument for `createDocsBlockForCandidate` from a tree node. */
export function candidateArg(node: Node): { root: string; column: string } | undefined {
  return node.type === 'candidate' ? { root: node.state.project.root, column: node.candidate.column } : undefined;
}

/** Arguments for `addMissingColumns` from a "Not in YAML" tree node. */
export function addColumnsArgs(node: Node): [string, string] | undefined {
  return node.type === 'notInYaml' ? [node.state.project.root, node.report.resource.uniqueId] : undefined;
}

export type TreeNode = Node;
