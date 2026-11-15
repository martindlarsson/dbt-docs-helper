import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  // Work on a copy of the fixture so the tests can edit files.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-docs-helper-it-'));
  fs.cpSync(path.resolve(extensionDevelopmentPath, '../../fixtures/jaffle'), workspace, { recursive: true });
  const now = new Date();
  fs.utimesSync(path.join(workspace, 'target/manifest.json'), now, now);
  await runTests({
    version: process.env.VSCODE_TEST_VERSION ?? 'stable',
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
