import * as vscode from 'vscode';
import type { GroupBy } from '@dbt-docs-helper/core';

export const SECTION = 'dbt-docs-helper';

export type SeveritySetting = 'error' | 'warning' | 'information' | 'hint' | 'off';

function cfg(scope?: vscode.Uri) {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

export function severity(key: string, fallback: SeveritySetting, scope?: vscode.Uri): vscode.DiagnosticSeverity | undefined {
  const value = cfg(scope).get<SeveritySetting>(`diagnostics.${key}`, fallback);
  switch (value) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return undefined;
  }
}

export const settings = {
  manifestPath: (scope?: vscode.Uri) => cfg(scope).get<string>('manifestPath', 'target/manifest.json'),
  catalogPath: (scope?: vscode.Uri) => cfg(scope).get<string>('catalogPath', ''),
  parseCommand: (scope?: vscode.Uri) => cfg(scope).get<string>('parseCommand', 'dbt parse'),
  staleManifest: (scope?: vscode.Uri) => cfg(scope).get<'auto' | 'statusBar' | 'notification' | 'autoParse' | 'off'>('staleManifest', 'auto'),
  defaultDocsFile: (scope?: vscode.Uri) => cfg(scope).get<string>('docsBlocks.defaultFile', ''),
  namePattern: (scope?: vscode.Uri) => cfg(scope).get<string>('docsBlocks.namePattern', 'col_{model}__{column}'),
  modelNamePattern: (scope?: vscode.Uri) => cfg(scope).get<string>('docsBlocks.modelNamePattern', 'model_{model}'),
  sharedNamePattern: (scope?: vscode.Uri) => cfg(scope).get<string>('docsBlocks.sharedNamePattern', 'col_{column}'),
  minModels: (scope?: vscode.Uri) => cfg(scope).get<number>('docsBlocks.minModels', 3),
  inlayHints: (scope?: vscode.Uri) => cfg(scope).get<boolean>('inlayHints.enabled', true),
  inlayHintsDocBlocks: (scope?: vscode.Uri) => cfg(scope).get<boolean>('inlayHints.showDocBlockText', true),
  inlayMaxLength: (scope?: vscode.Uri) => cfg(scope).get<number>('inlayHints.maxLength', 60),
  diagnosticsScope: () => cfg().get<'openFiles' | 'workspace'>('diagnostics.scope', 'openFiles'),
  groupBy: () => cfg().get<GroupBy>('coverage.groupBy', 'layer'),
  includeInheritable: () => cfg().get<boolean>('coverage.includeInheritable', false),
  docEditorAutoSave: () => cfg().get<boolean>('docEditor.autoSave', true),
  typeCase: (scope?: vscode.Uri) => cfg(scope).get<'lower' | 'upper' | 'asIs'>('dataTypes.case', 'lower'),
  aiEnabled: () => cfg().get<boolean>('ai.enabled', false),
  aiModelFamily: () => cfg().get<string>('ai.modelFamily', ''),
  layers: () => cfg().get<string[]>('layers', ['staging', 'intermediate', 'marts', 'mart', 'core', 'base', 'reporting']),
};
