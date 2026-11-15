import * as vscode from 'vscode';
import {
  Analysis,
  ColumnReport,
  DbtProject,
  InheritanceCandidate,
  offsetToPosition,
  OffsetRange,
  resourceLabel,
  ResourceReport,
  YamlFileIndex,
} from '@dbt-docs-helper/core';

export function toRange(index: YamlFileIndex, range: OffsetRange): vscode.Range {
  const s = offsetToPosition(index.lineStarts, range[0]);
  const e = offsetToPosition(index.lineStarts, range[1]);
  return new vscode.Range(s.line, s.character, e.line, e.character);
}

export function toPosition(index: YamlFileIndex, offset: number): vscode.Position {
  const p = offsetToPosition(index.lineStarts, offset);
  return new vscode.Position(p.line, p.character);
}

/** Resource reports documented in a given YAML file. */
export function reportsInFile(analysis: Analysis, relFile: string): ResourceReport[] {
  return [...analysis.resources.values()].filter((r) => r.yaml?.file === relFile);
}

/** A column (or resource) addressed by ids, for passing to commands. */
export interface ColumnRef {
  root: string;
  resourceId: string;
  column: string;
}

export function findColumn(analysis: Analysis, ref: ColumnRef): { resource: ResourceReport; column: ColumnReport } | undefined {
  const resource = analysis.resources.get(ref.resourceId);
  const column = resource?.columns.find((c) => c.name.toLowerCase() === ref.column.toLowerCase());
  return resource && column ? { resource, column } : undefined;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(1, max - 1))}…` : oneLine;
}

export function kindLabel(c: InheritanceCandidate): string {
  const via = c.via === 'sql' ? 'traced in SQL' : 'matched by name';
  return `${c.kind}, ${via}`;
}

export function chainLabel(project: DbtProject, chain: string[]): string {
  return [...chain]
    .reverse()
    .map((id) => {
      const r = project.manifest.resources.get(id);
      return r ? resourceLabel(r) : id;
    })
    .join(' → ');
}

export function fileUri(project: DbtProject, relFile: string): vscode.Uri {
  return vscode.Uri.file(project.absolute(relFile));
}

/** Escape text for use inside a MarkdownString. */
export function md(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
