# dbt-docs-helper

> Kolumnbeskrivningar som går i arv – skriv en gång, dokumentera överallt.

`dbt-docs-helper` hjälper dig skriva och underhålla dokumentation i dbt-projekt. Det består av ett
VS Code-tillägg och ett CLI för CI, som delar samma kärna (TypeScript, ingen Python behövs).
Fungerar med dbt Core och dbt Fusion: verktyget läser bara `target/manifest.json` och YAML-filerna.

## Mål

1. **Central hantering av återkommande kolumner**: hitta kolumner som förekommer i många modeller
   (t.ex. `customer_id`, `created_at`) och flytta deras beskrivningar till ett centralt ställe
   (`{% docs %}`-block), som sedan refereras med `{{ doc('...') }}`.
2. **Täckningsgrad**: rapportera hur många modeller och kolumner som saknar beskrivning,
   per mapp, lager (staging/intermediate/marts), ägare eller tagg.
3. **Arv via lineage**: använda `manifest.json` och kolumnnivå-lineage för att visa vilka
   beskrivningar som kan ärvas från uppströms modeller, så att de inte behöver skrivas igen.

## Status

Version 0.1.0 – första fungerande version av VS Code-tillägget och CLI:t. Inte publicerat ännu.
Se [docs/design.md](docs/design.md) för beslut och öppna frågor.

## Struktur

```
packages/
  core/     Manifest, YAML-index med positioner, SQL-läsning för lineage, arv, täckning, YAML-ändringar
  cli/      dbt-docs-helper i terminal/CI
  vscode/   Tillägget: inlay hints, hover, snabbåtgärder, Problems, vyer för täckning/arbetslista
fixtures/
  jaffle/   Litet dbt-projekt med riktig manifest.json och catalog.json (dbt 1.12) för tester
```

## VS Code-tillägget

Se [packages/vscode/README.md](packages/vscode/README.md) för funktionerna. Kortfattat:

- **Inlay hint** på kolumner utan beskrivning: `↳ stg_customers: "Unikt id för…"`. Klick = skriv in.
- **Hover** med arvskedjan (`crm.customers → stg_customers → customers`) och typ av arv.
- **Snabbåtgärder**: ärv, flytta till docs-block och länka båda, länka till befintligt block,
  lägg till saknade kolumner (från `catalog.json`), ärv allt säkert i filen, AI-förslag (opt-in).
- **Problems-panelen** med konfigurerbar nivå per regel.
- **Sidopanel**: täckning per lager/mapp/tagg/ägare/typ, arbetslista, kandidater till docs-block.
- **Varning för inaktuellt manifest** med knapp som kör `dbt parse` (konfigurerbart, t.ex. `dbtf parse`).

### Prova lokalt

```bash
npm install
```

```bash
npm run package
```

Installera sedan `packages/vscode/dbt-docs-helper.vsix` via *Extensions → … → Install from VSIX*.
Eller öppna repot i VS Code och tryck F5 ("Run extension on the fixture project").

## CLI

```bash
node packages/cli/dist/cli.js coverage --project-dir fixtures/jaffle --by layer
```

| Kommando | Vad det gör |
|---|---|
| `coverage` | Täckning per `--by folder\|layer\|tag\|kind\|owner\|resource`, `--fail-under 80` |
| `check` | För CI: täckning + inaktuellt manifest (`--fail-on-stale`) + block som pekar på borttagna modeller (`--fail-on-orphans`) |
| `missing` | Arbetslista: det som måste skrivas för hand först, sedan det som kan ärvas |
| `candidates` | Kolumner i ≥ 3 modeller (`--min-models`) som bör bli docs-block, med föreslaget namn |
| `conflicts` | Samma kolumnnamn, olika beskrivningar |
| `inherit` | Skriver ärvda beskrivningar till YAML (torrkörning om inte `--write`). Bara säker passthrough om inte `--include-renamed` / `--include-name-matches` |
| `add-columns` | Lägger till kolumner som finns i `catalog.json` men saknas i YAML |

Alla kommandon har `--format text|json|markdown` (markdown passar `$GITHUB_STEP_SUMMARY`).

## Utveckling

```bash
npm test
```

```bash
npm run typecheck
```

- Enhetstester (vitest) för core, CLI och tillägget (mot en mock av `vscode`-API:t).
- Integrationstester i riktig VS Code: `xvfb-run -a npm run test:integration -w packages/vscode` (körs i CI).
- CI kör också en rundtur: CLI:t skriver ärvda beskrivningar, och sedan måste `dbt parse` lyckas.
- Fixture-manifestet återskapas med `dbt parse` i `fixtures/jaffle` (dbt-duckdb, `profiles.yml` finns där).

## Publicering

Pusha en tagg `v0.1.0` → `.github/workflows/release.yml` publicerar till VS Code Marketplace och
Open VSX om hemligheterna `VSCE_PAT` och `OVSX_PAT` finns. Publisher-id i
`packages/vscode/package.json` är `martindlarsson` och måste finnas i Marketplace.

## Licens

MIT, se [LICENSE](LICENSE).
