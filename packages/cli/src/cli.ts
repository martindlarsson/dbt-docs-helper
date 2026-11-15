#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { GroupBy } from '@dbt-docs-helper/core';
import {
  addColumnsCommand,
  candidatesCommand,
  checkCommand,
  CommonOptions,
  conflictsCommand,
  coverageCommand,
  dataTypesCommand,
  Format,
  inheritCommand,
  loadAnalysis,
  missingCommand,
  Result,
} from './commands';

const VERSION = '0.1.0';

const HELP = `dbt-docs-helper ${VERSION}

Usage: dbt-docs-helper <command> [options]

Commands:
  coverage     Documentation coverage per folder, layer, tag, kind or owner
  check        Coverage threshold + stale manifest + orphaned doc blocks (for CI)
  missing      Work list: columns without a description, hand-written first
  candidates   Columns used in many models that should share a doc block
  conflicts    Columns with the same name but different descriptions
  inherit      Write descriptions inherited from upstream models into YAML
  add-columns  Add warehouse columns (from catalog.json) that are missing in YAML
  data-types   Known column types (warehouse, casts, seeds, upstream); --write sets data_type

Common options:
  --project-dir <dir>       dbt project directory (default: .)
  --manifest <path>         manifest.json (default: <target-path>/manifest.json)
  --format <text|json|markdown>

coverage / check:
  --by <folder|layer|tag|kind|owner|resource>   (default: folder)
  --fail-under <percent>    Exit with code 1 when column coverage is lower
  --include-inheritable     Count inheritable columns as documented
check:
  --fail-on-stale           Fail when manifest.json is out of date (SQL, seeds, dbt_project.yml or new sources)
  --fail-on-orphans         Fail when a doc block refers to a model that does not exist
  --fail-on-type-mismatch   Fail when a data_type in YAML differs from the warehouse (catalog.json)
  --name-pattern <pattern>  Doc block naming pattern (default: col_{model}__{column})
missing:
  --only-missing            Hide columns that can be inherited
  --limit <n>
candidates:
  --min-models <n>          (default: 3)
  --shared-name-pattern <p> Name for shared doc blocks (default: col_{column})
inherit:
  --write                   Update the YAML files (default is a dry run)
  --select <name,...>       Only these models
  --include-renamed         Also inherit renamed/transformed columns
  --include-name-matches    Also inherit columns matched only by name (not traced in SQL)
add-columns:
  --write
data-types:
  --write                   Set data_type where it is missing and the type is known
  --fix-mismatches          Also change data_type that differs from the warehouse
  --type-case <lower|upper|asIs>  (default: lower)
  --select <name,...>       Only these models
`;

function main(argv: string[]): Result {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'project-dir': { type: 'string', default: '.' },
      manifest: { type: 'string' },
      format: { type: 'string', default: 'text' },
      by: { type: 'string', default: 'folder' },
      'fail-under': { type: 'string' },
      'include-inheritable': { type: 'boolean', default: false },
      'fail-on-stale': { type: 'boolean', default: false },
      'fail-on-orphans': { type: 'boolean', default: false },
      'fail-on-type-mismatch': { type: 'boolean', default: false },
      'fix-mismatches': { type: 'boolean', default: false },
      'type-case': { type: 'string', default: 'lower' },
      'name-pattern': { type: 'string' },
      'shared-name-pattern': { type: 'string' },
      'only-missing': { type: 'boolean', default: false },
      limit: { type: 'string' },
      'min-models': { type: 'string', default: '3' },
      write: { type: 'boolean', default: false },
      select: { type: 'string' },
      'include-renamed': { type: 'boolean', default: false },
      'include-name-matches': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.version) return { output: VERSION, exitCode: 0 };
  const command = positionals[0];
  if (values.help || !command) return { output: HELP, exitCode: command || values.help ? 0 : 2 };

  const format = values.format as Format;
  if (!['text', 'json', 'markdown'].includes(format)) throw new UsageError(`Unknown --format "${format}"`);
  const by = values.by as GroupBy;
  if (!['folder', 'layer', 'tag', 'kind', 'owner', 'resource'].includes(by)) throw new UsageError(`Unknown --by "${by}"`);
  const num = (v: string | undefined, name: string) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`${name} must be a number`);
    return n;
  };

  const common: CommonOptions = { projectDir: values['project-dir']!, manifest: values.manifest, format };
  const coverageOpts = {
    ...common,
    by,
    failUnder: num(values['fail-under'], '--fail-under'),
    includeInheritable: values['include-inheritable']!,
  };
  const known = ['coverage', 'check', 'missing', 'candidates', 'conflicts', 'inherit', 'add-columns', 'data-types'];
  if (!known.includes(command)) throw new UsageError(`Unknown command "${command}"`);
  const analysis = loadAnalysis(common);

  switch (command) {
    case 'coverage':
      return coverageCommand(analysis, coverageOpts);
    case 'check':
      return checkCommand(analysis, {
        ...coverageOpts,
        namePattern: values['name-pattern'],
        failOnStale: values['fail-on-stale']!,
        failOnOrphans: values['fail-on-orphans']!,
        failOnTypeMismatch: values['fail-on-type-mismatch']!,
      });
    case 'missing':
      return missingCommand(analysis, { ...common, onlyMissing: values['only-missing']!, limit: num(values.limit, '--limit') });
    case 'candidates':
      return candidatesCommand(analysis, { ...common, minModels: num(values['min-models'], '--min-models') ?? 3, sharedNamePattern: values['shared-name-pattern'] });
    case 'conflicts':
      return conflictsCommand(analysis, common);
    case 'inherit':
      return inheritCommand(analysis, {
        ...common,
        write: values.write!,
        includeRenamed: values['include-renamed']!,
        includeNameMatches: values['include-name-matches']!,
        select: values.select?.split(',').map((s) => s.trim()).filter(Boolean),
      });
    case 'add-columns':
      return addColumnsCommand(analysis, { ...common, write: values.write! });
    case 'data-types': {
      const typeCase = values['type-case'] as 'lower' | 'upper' | 'asIs';
      if (!['lower', 'upper', 'asIs'].includes(typeCase)) throw new UsageError(`Unknown --type-case "${typeCase}"`);
      return dataTypesCommand(analysis, {
        ...common,
        write: values.write!,
        fixMismatches: values['fix-mismatches']!,
        typeCase,
        select: values.select?.split(',').map((s) => s.trim()).filter(Boolean),
      });
    }
  }
  throw new UsageError(`Unknown command "${command}"`);
}

class UsageError extends Error {}

try {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
  process.exitCode = result.exitCode;
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`dbt-docs-helper: ${message}\n`);
  if (err instanceof UsageError) process.stderr.write('Run `dbt-docs-helper --help` for usage.\n');
  process.exitCode = 2;
}
