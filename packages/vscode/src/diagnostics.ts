import * as vscode from 'vscode';
import { Analysis, conflicts, Conflict, DbtProject, docsBlockCandidates, DocsBlockCandidate, docRefName, orphanDocBlocks } from '@dbt-docs-helper/core';
import { settings, severity } from './config';
import { ProjectManager } from './projectManager';
import { reportsInFile, toRange, truncate } from './util';

export const DIAG_SOURCE = 'dbt-docs-helper';

export const Codes = {
  missing: 'missing-description',
  missingModel: 'missing-model-description',
  inheritable: 'inheritable',
  conflict: 'conflicting-descriptions',
  candidate: 'docs-block-candidate',
  orphan: 'orphan-docs-block',
  unknownBlock: 'unknown-docs-block',
  notInYaml: 'columns-not-in-yaml',
} as const;

interface ProjectInsights {
  version: number;
  conflicts: Map<string, Conflict>;
  candidates: Map<string, DocsBlockCandidate>;
  orphans: Map<string, string[]>; // file -> block names
}

export class Diagnostics implements vscode.Disposable {
  private collection = vscode.languages.createDiagnosticCollection(DIAG_SOURCE);
  private insights = new Map<string, ProjectInsights>();
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: ProjectManager) {
    this.disposables.push(
      manager.onDidChange(() => this.refreshAll()),
      vscode.workspace.onDidOpenTextDocument((d) => this.refresh(d)),
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (settings.diagnosticsScope() === 'openFiles') this.collection.delete(d.uri);
      }),
    );
  }

  private projectInsights(project: DbtProject, analysis: Analysis): ProjectInsights {
    const cached = this.insights.get(project.root);
    if (cached && cached.version === project.version) return cached;
    const scope = vscode.Uri.file(project.root);
    const orphans = new Map<string, string[]>();
    for (const o of orphanDocBlocks(analysis, settings.namePattern(scope))) {
      const list = orphans.get(o.file) ?? [];
      list.push(o.name);
      orphans.set(o.file, list);
    }
    const value: ProjectInsights = {
      version: project.version,
      conflicts: new Map(conflicts(analysis).map((c) => [c.column, c])),
      candidates: new Map(
        docsBlockCandidates(analysis, { minModels: settings.minModels(scope), sharedNamePattern: settings.sharedNamePattern(scope) }).map((c) => [c.column, c]),
      ),
      orphans,
    };
    this.insights.set(project.root, value);
    return value;
  }

  refreshAll(): void {
    this.collection.clear();
    if (settings.diagnosticsScope() === 'workspace') {
      for (const state of this.manager.projects()) {
        const files = [...state.project.yamlFiles.keys(), ...state.project.docFiles.keys()];
        for (const f of files) this.refreshUri(vscode.Uri.file(state.project.absolute(f)));
      }
    } else {
      for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
    }
  }

  refresh(doc: vscode.TextDocument): void {
    if (doc.uri.scheme !== 'file') return;
    this.refreshUri(doc.uri);
  }

  private refreshUri(uri: vscode.Uri): void {
    const found = this.manager.analysisFor(uri);
    if (!found) return;
    const { state, analysis } = found;
    const project = state.project;
    const rel = project.relative(uri.fsPath);
    if (/\.md$/i.test(rel)) {
      this.collection.set(uri, this.markdownDiagnostics(project, analysis, rel, uri));
      return;
    }
    const index = project.yamlFiles.get(rel);
    if (!index) return;
    const insights = this.projectInsights(project, analysis);
    const out: vscode.Diagnostic[] = [];
    const sev = {
      missing: severity('missingDescription', 'information', uri),
      inheritable: severity('inheritable', 'hint', uri),
      conflict: severity('conflictingDescriptions', 'hint', uri),
      candidate: severity('docsBlockCandidate', 'hint', uri),
      unknownBlock: severity('unknownDocsBlock', 'warning', uri),
      notInYaml: severity('columnsNotInYaml', 'information', uri),
    };
    const blocks = project.docBlocks();

    for (const r of reportsInFile(analysis, rel)) {
      const yr = r.yaml!.resource;
      if (!r.hasDescription && sev.missing !== undefined) {
        out.push(diag(toRange(index, yr.nameRange), `${r.label} has no description.`, sev.missing, Codes.missingModel));
      }
      const notInYaml = r.columns.filter((c) => c.notInYaml);
      if (notInYaml.length > 0 && sev.notInYaml !== undefined) {
        out.push(
          diag(
            toRange(index, yr.nameRange),
            `${notInYaml.length} column${notInYaml.length === 1 ? '' : 's'} in the warehouse but not in YAML: ${notInYaml.map((c) => c.name).join(', ')}`,
            sev.notInYaml,
            Codes.notInYaml,
          ),
        );
      }
      for (const c of r.columns) {
        if (!c.yaml) continue;
        const range = toRange(index, c.yaml.column.nameRange);
        if (c.status === 'missing' && sev.missing !== undefined) {
          out.push(diag(range, `${c.name}: no description, and none can be inherited from upstream.`, sev.missing, Codes.missing));
        } else if (c.status === 'inheritable' && sev.inheritable !== undefined) {
          const k = c.candidates[0];
          out.push(diag(range, `${c.name} can inherit from ${k.fromLabel}.${k.fromColumn}: "${truncate(k.description, 80)}"`, sev.inheritable, Codes.inheritable));
        }
        const lower = c.name.toLowerCase();
        const conflict = insights.conflicts.get(lower);
        if (c.status === 'documented' && conflict && sev.conflict !== undefined) {
          const others = conflict.variants.filter((v) => v.description !== c.description.trim());
          out.push(
            diag(
              range,
              `"${c.name}" has ${conflict.variants.length} different descriptions in the project. Other: ${others
                .map((v) => `"${truncate(v.description, 50)}" (${v.usages.map((u) => u.label).slice(0, 3).join(', ')})`)
                .join('; ')}`,
              sev.conflict,
              Codes.conflict,
            ),
          );
        }
        const cand = insights.candidates.get(lower);
        if (cand && !c.docBlock && sev.candidate !== undefined) {
          const strength = cand.sameText ? 'with the same text' : '';
          out.push(
            diag(
              range,
              `"${c.name}" is used in ${cand.usages.length} models ${strength}. Consider a shared doc block (${cand.suggestedName}).`.replace('  ', ' '),
              sev.candidate,
              Codes.candidate,
            ),
          );
        }
        const ref = docRefName(c.rawDescription);
        if (ref && !blocks.has(ref) && sev.unknownBlock !== undefined && c.yaml.column.description) {
          out.push(diag(toRange(index, c.yaml.column.description.valueRange), `Unknown doc block "${ref}".`, sev.unknownBlock, Codes.unknownBlock));
        }
      }
    }
    this.collection.set(uri, out);
  }

  private markdownDiagnostics(project: DbtProject, analysis: Analysis, rel: string, uri: vscode.Uri): vscode.Diagnostic[] {
    const sev = severity('orphanDocsBlock', 'warning', uri);
    const blocks = project.docFiles.get(rel);
    if (sev === undefined || !blocks) return [];
    const orphans = new Set(this.projectInsights(project, analysis).orphans.get(rel) ?? []);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (!doc) return [];
    return blocks
      .filter((b) => orphans.has(b.name))
      .map((b) =>
        diag(
          new vscode.Range(doc.positionAt(b.nameRange[0]), doc.positionAt(b.nameRange[1])),
          `The name of "${b.name}" refers to a model that does not exist (renamed or removed?). The block still works, but the name is misleading.`,
          sev,
          Codes.orphan,
        ),
      );
  }

  dispose(): void {
    this.collection.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function diag(range: vscode.Range, message: string, sev: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const d = new vscode.Diagnostic(range, message, sev);
  d.source = DIAG_SOURCE;
  d.code = code;
  return d;
}
