/**
 * A small in-memory stand-in for the `vscode` module, good enough to activate
 * the extension and call its providers in unit tests (vitest), without
 * downloading VS Code. The real API is exercised by the integration tests in
 * test/integration (run in CI with @vscode/test-electron).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'node:fs';
import * as path from 'node:path';

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(readonly scheme: string, readonly fsPath: string) {}
  static file(p: string): Uri {
    return new Uri('file', path.resolve(p));
  }
  get path(): string {
    return this.fsPath;
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Position {
  constructor(readonly line: number, readonly character: number) {}
  isBefore(o: Position) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isAfter(o: Position) {
    return o.isBefore(this);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    if (typeof a === 'number') {
      this.start = new Position(a, b as number);
      this.end = new Position(c!, d!);
    } else {
      this.start = a;
      this.end = b as Position;
    }
  }
  contains(p: Position): boolean {
    return !p.isBefore(this.start) && !p.isAfter(this.end);
  }
}
export class Selection extends Range {}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  source?: string;
  code?: string | number;
  constructor(readonly range: Range, readonly message: string, readonly severity: DiagnosticSeverity) {}
}

export class MarkdownString {
  isTrusted: any;
  constructor(public value = '', readonly supportThemeIcons = false) {}
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
}

export class InlayHintLabelPart {
  tooltip?: any;
  command?: any;
  constructor(readonly value: string) {}
}
export class InlayHint {
  paddingLeft?: boolean;
  tooltip?: any;
  constructor(readonly position: Position, readonly label: string | InlayHintLabelPart[]) {}
}
export class Hover {
  constructor(readonly contents: MarkdownString, readonly range?: Range) {}
}

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  static readonly RefactorRewrite = new CodeActionKind('refactor.rewrite');
  static readonly Source = new CodeActionKind('source');
  constructor(readonly value: string) {}
  append(s: string) {
    return new CodeActionKind(`${this.value}.${s}`);
  }
}
export class CodeAction {
  command?: any;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  constructor(readonly title: string, readonly kind: CodeActionKind) {}
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export class TreeItem {
  description?: string;
  tooltip?: any;
  iconPath?: any;
  command?: any;
  contextValue?: string;
  constructor(readonly label: string, readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {}
}
export class ThemeIcon {
  constructor(readonly id: string, readonly color?: ThemeColor) {}
}
export class ThemeColor {
  constructor(readonly id: string) {}
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
export enum ProgressLocation {
  Notification = 15,
}
export class LanguageModelError extends Error {}
export const LanguageModelChatMessage = { User: (s: string) => ({ role: 'user', content: s }) };

// -----------------------------------------------------------------------------
// Documents

export class TextDocument {
  version = 1;
  isDirty = false;
  constructor(readonly uri: Uri, private text: string) {}
  getText(): string {
    return this.text;
  }
  setText(t: string): void {
    this.text = t;
    this.version++;
    this.isDirty = true;
  }
  private lineStarts(): number[] {
    const s = [0];
    for (let i = 0; i < this.text.length; i++) if (this.text[i] === '\n') s.push(i + 1);
    return s;
  }
  offsetAt(p: Position): number {
    const s = this.lineStarts();
    return Math.min(this.text.length, (s[p.line] ?? this.text.length) + p.character);
  }
  positionAt(offset: number): Position {
    const s = this.lineStarts();
    let line = 0;
    while (line + 1 < s.length && s[line + 1] <= offset) line++;
    return new Position(line, offset - s[line]);
  }
  lineAt(line: number) {
    const s = this.lineStarts();
    const start = s[line];
    let end = (s[line + 1] ?? this.text.length + 1) - 1;
    if (end > start && this.text[end - 1] === '\r') end--;
    return { range: new Range(this.positionAt(start), this.positionAt(end)), text: this.text.slice(start, end) };
  }
}

export class WorkspaceEdit {
  readonly ops: { uri: Uri; range?: Range; position?: Position; text?: string; create?: boolean }[] = [];
  replace(uri: Uri, range: Range, text: string) {
    this.ops.push({ uri, range, text });
  }
  insert(uri: Uri, position: Position, text: string) {
    this.ops.push({ uri, position, text });
  }
  createFile(uri: Uri) {
    this.ops.push({ uri, create: true });
  }
}

// -----------------------------------------------------------------------------
// State shared with tests

export const __state = {
  commands: new Map<string, (...args: any[]) => any>(),
  inlayProviders: [] as any[],
  hoverProviders: [] as any[],
  codeActionProviders: [] as any[],
  treeProviders: new Map<string, any>(),
  diagnostics: new Map<string, Diagnostic[]>(),
  config: new Map<string, unknown>(),
  messages: [] as string[],
  quickPickAnswers: [] as ((items: any[]) => any)[],
  inputBoxAnswers: [] as (string | undefined)[],
  terminalText: [] as string[],
  workspaceRoot: '',
  docEvents: {
    change: new EventEmitter<{ document: TextDocument }>(),
    open: new EventEmitter<TextDocument>(),
    close: new EventEmitter<TextDocument>(),
    save: new EventEmitter<TextDocument>(),
  },
  textDocuments: [] as TextDocument[],
};

function defaults(): Record<string, unknown> {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries<any>(pkg.contributes.configuration.properties)) out[k] = v.default;
  return out;
}

export function __reset(root: string): void {
  __state.commands.clear();
  __state.inlayProviders = [];
  __state.hoverProviders = [];
  __state.codeActionProviders = [];
  __state.treeProviders.clear();
  __state.diagnostics.clear();
  __state.config.clear();
  __state.messages = [];
  __state.quickPickAnswers = [];
  __state.inputBoxAnswers = [];
  __state.terminalText = [];
  __state.textDocuments = [];
  __state.workspaceRoot = root;
}

/** Open (or get) a document; it is then part of workspace.textDocuments. */
export function __open(fsPath: string): TextDocument {
  const uri = Uri.file(fsPath);
  let doc = __state.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  if (!doc) {
    doc = new TextDocument(uri, fs.existsSync(uri.fsPath) ? fs.readFileSync(uri.fsPath, 'utf8') : '');
    __state.textDocuments.push(doc);
    __state.docEvents.open.fire(doc);
  }
  return doc;
}

function applyToText(doc: TextDocument, ops: WorkspaceEdit['ops']): void {
  const edits = ops
    .filter((o) => !o.create)
    .map((o) => {
      const start = doc.offsetAt(o.range ? o.range.start : o.position!);
      const end = o.range ? doc.offsetAt(o.range.end) : start;
      return { start, end, text: o.text ?? '' };
    })
    .sort((a, b) => b.start - a.start);
  let text = doc.getText();
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  doc.setText(text);
  __state.docEvents.change.fire({ document: doc });
}

// -----------------------------------------------------------------------------
// Namespaces

const disposable = { dispose() {} };

export const commands = {
  registerCommand(id: string, fn: (...args: any[]) => any) {
    __state.commands.set(id, fn);
    return { dispose: () => __state.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: any[]) {
    const fn = __state.commands.get(id);
    return fn ? fn(...args) : undefined;
  },
};

export const languages = {
  createDiagnosticCollection() {
    return {
      set(uri: Uri, d: Diagnostic[]) {
        __state.diagnostics.set(uri.fsPath, d);
      },
      delete(uri: Uri) {
        __state.diagnostics.delete(uri.fsPath);
      },
      clear() {
        __state.diagnostics.clear();
      },
      dispose() {},
    };
  },
  registerInlayHintsProvider(_s: unknown, p: unknown) {
    __state.inlayProviders.push(p);
    return disposable;
  },
  registerHoverProvider(_s: unknown, p: unknown) {
    __state.hoverProviders.push(p);
    return disposable;
  },
  registerCodeActionsProvider(_s: unknown, p: unknown) {
    __state.codeActionProviders.push(p);
    return disposable;
  },
};

export const window = {
  activeTextEditor: undefined as any,
  terminals: [] as any[],
  createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  createStatusBarItem: () => ({ text: '', tooltip: undefined, command: undefined, show() {}, hide() {}, dispose() {} }),
  showWarningMessage: async (m: string) => {
    __state.messages.push(m);
    return undefined;
  },
  showInformationMessage: async (m: string) => {
    __state.messages.push(m);
    return undefined;
  },
  showQuickPick: async (items: any[]) => {
    const answer = __state.quickPickAnswers.shift();
    return answer ? answer(items) : undefined;
  },
  showInputBox: async (opts: { value?: string; validateInput?: (v: string) => string | undefined }) => {
    const answer = __state.inputBoxAnswers.length ? __state.inputBoxAnswers.shift() : opts.value;
    if (answer !== undefined && opts.validateInput?.(answer)) return undefined;
    return answer;
  },
  registerTreeDataProvider(id: string, p: unknown) {
    __state.treeProviders.set(id, p);
    return disposable;
  },
  onDidChangeActiveTextEditor: () => disposable,
  createTerminal: (opts: any) => ({ creationOptions: opts, name: opts.name, show() {}, sendText: (t: string) => __state.terminalText.push(t) }),
  withProgress: async (_o: unknown, task: (p: unknown, t: unknown) => unknown) => task({}, { isCancellationRequested: false }),
  showTextDocument: async () => undefined,
};

export const workspace = {
  get textDocuments() {
    return __state.textDocuments;
  },
  workspaceFolders: undefined as any,
  getConfiguration(section: string) {
    const d = defaults();
    return {
      get<T>(key: string, fallback?: T): T {
        const full = `${section}.${key}`;
        if (__state.config.has(full)) return __state.config.get(full) as T;
        return (full in d ? d[full] : fallback) as T;
      },
      async update(key: string, value: unknown) {
        __state.config.set(`${section}.${key}`, value);
      },
    };
  },
  async findFiles(pattern: string) {
    if (pattern !== '**/dbt_project.yml') return [];
    const out: Uri[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && !['node_modules', 'target', '.git', 'dbt_packages'].includes(e.name)) walk(path.join(d, e.name));
        else if (e.name === 'dbt_project.yml') out.push(Uri.file(path.join(d, e.name)));
      }
    };
    walk(__state.workspaceRoot);
    return out;
  },
  createFileSystemWatcher: () => ({
    onDidChange: () => disposable,
    onDidCreate: () => disposable,
    onDidDelete: () => disposable,
    dispose() {},
  }),
  onDidChangeTextDocument: (l: Listener<{ document: TextDocument }>) => __state.docEvents.change.event(l),
  onDidOpenTextDocument: (l: Listener<TextDocument>) => __state.docEvents.open.event(l),
  onDidCloseTextDocument: (l: Listener<TextDocument>) => __state.docEvents.close.event(l),
  onDidSaveTextDocument: (l: Listener<TextDocument>) => __state.docEvents.save.event(l),
  onDidChangeWorkspaceFolders: () => disposable,
  onDidChangeConfiguration: () => disposable,
  async applyEdit(edit: WorkspaceEdit) {
    const byUri = new Map<string, WorkspaceEdit['ops']>();
    for (const op of edit.ops) {
      const list = byUri.get(op.uri.fsPath) ?? [];
      list.push(op);
      byUri.set(op.uri.fsPath, list);
    }
    for (const [fsPath, ops] of byUri) applyToText(__open(fsPath), ops);
    return true;
  },
  async openTextDocument(uri: Uri) {
    return __open(uri.fsPath);
  },
  asRelativePath(p: string) {
    return path.relative(__state.workspaceRoot, p);
  },
};

export const lm = undefined;
