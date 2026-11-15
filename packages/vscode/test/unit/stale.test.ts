import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __reset, __state } from '../mock/vscode';
import { activate } from '../../src/extension';

const FIXTURE = path.resolve(__dirname, '../../../../fixtures/jaffle');

describe('stale manifest handling', () => {
  let root: string;
  let manager: any;

  beforeEach(async () => {
    vi.useFakeTimers();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddh-stale-ext-'));
    fs.cpSync(FIXTURE, root, { recursive: true });
    const now = new Date();
    fs.utimesSync(path.join(root, 'target/manifest.json'), now, now);
    __reset(root);
    ({ manager } = await activate({ subscriptions: [], workspaceState: { get() {}, async update() {} } } as any));
    await vi.advanceTimersByTimeAsync(5_000);
    __state.messages = [];
  });

  afterEach(() => vi.useRealTimers());

  const touch = (rel: string) => {
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, rel), t, t);
  };

  it('never complains about documentation edits', async () => {
    touch('models/marts/_marts.yml');
    manager.checkStale();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(__state.messages).toEqual([]);
  });

  it('waits for a grace period and notifies once per session', async () => {
    touch('models/marts/orders.sql');
    manager.checkStale();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(__state.messages).toEqual([]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(__state.messages).toHaveLength(1);
    expect(__state.messages[0]).toContain('models/marts/orders.sql changed');
    manager.checkStale();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(__state.messages).toHaveLength(1);
  });

  it('stays quiet when another tool updates the manifest', async () => {
    expect(manager.staleMode(root)).toBe('notification');
    manager.onManifestWritten(root); // written by e.g. the dbt extension with Fusion
    expect(manager.staleMode(root)).toBe('statusBar');
    touch('models/marts/orders.sql');
    manager.checkStale();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(__state.messages).toEqual([]);
  });

  it('does not count a manifest written by our own parse as external', () => {
    manager.runParse(root);
    manager.onManifestWritten(root);
    expect(manager.staleMode(root)).toBe('notification');
  });

  it('respects the setting', () => {
    __state.config.set('dbt-docs-helper.staleManifest', 'off');
    expect(manager.staleMode(root)).toBe('off');
  });

  it('autoParse runs the parse command in the background', async () => {
    vi.useRealTimers();
    __state.config.set('dbt-docs-helper.staleManifest', 'autoParse');
    // A stand-in for `dbt parse`: rewrites the manifest timestamp.
    __state.config.set(
      'dbt-docs-helper.parseCommand',
      `node -e "const t=new Date(Date.now()+120000);require('fs').utimesSync('target/manifest.json',t,t)"`,
    );
    touch('models/marts/orders.sql');
    manager.checkStale();
    expect(manager.isParsing(root)).toBe(true);
    for (let i = 0; i < 100 && manager.isParsing(root); i++) await new Promise((r) => setTimeout(r, 50));
    expect(manager.isParsing(root)).toBe(false);
    manager.checkStale();
    expect(manager.projects()[0].stale.stale).toBe(false);
    expect(manager.projects()[0].parseError).toBeUndefined();
    expect(__state.messages).toEqual([]);
  });
});
