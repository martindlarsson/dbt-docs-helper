# Designanteckningar

## Beslut hittills

| Område | Beslut |
|---|---|
| Arbetsflöde | Verktyget ändrar YAML-filer (kommentarer och formatering ska bevaras) |
| Gränssnitt | VS Code-tillägg i första hand |
| Miljö | dbt v1 "latest" (dbt Cloud). Stöd för Fusion är ett krav |
| Storlek | Ska fungera bra med ~500 modeller, men också för små projekt |
| Centrala texter | Förslag på kolumner som bör ligga centralt, sparade som `{% docs %}`-block i en fil som användaren väljer |
| AI | Ja, som förslag (opt-in) |
| Licens | Öppen källkod |

## Viktigt om arv i dbt

dbt Core för **inte** automatiskt vidare kolumnbeskrivningar till modeller nedströms i YAML,
`manifest.json`, `dbt docs` eller `persist_docs`. En kolumn utan beskrivning är tom, även om den
heter likadant uppströms. dbt Catalog/Explorer i dbt Cloud kan *visa* ärvda beskrivningar för
kolumner som bara skickas vidare eller döps om (detta behöver verifieras för den nivå av dbt Cloud
som används). Texten skrivs dock aldrig in i projektet.

heirloom ska alltså göra arvet synligt **i editorn**, och kunna göra det beständigt i YAML.

### Strategi för beständigt arv
1. Uppströms kolumn har `{{ doc('x') }}` → skriv samma referens nedströms. Ingen dubblerad text.
2. Uppströms kolumn har vanlig text → föreslå "Flytta till docs-block och länka båda".
   Arv blir då i praktiken återanvändning av docs-block.
3. Användaren kan välja att inte skriva något och bara låta heirloom visa arvet virtuellt
   (räknas då som "ärvbar" i täckningen, inte "saknas").

## Funktioner i VS Code

- **Inlay hint / spöktext** på kolumner utan beskrivning i YAML: `↳ från stg_customers: "Unikt id för…"`.
- **Hover**: hela arvskedjan (källa → staging → mart) och typ av arv (passthrough, omdöpt, transformerad).
- **Snabbåtgärder (code actions)**:
  - Ärv från uppströms
  - Flytta till docs-block (välj fil, se nedan)
  - Länka till befintligt docs-block
  - Föreslå beskrivning med AI
  - Lägg till saknade kolumner i YAML (skelett)
- **Diagnostik (Problems-panelen)**, nivå konfigurerbar:
  - Kolumn saknar beskrivning och kan inte ärvas
  - Samma kolumnnamn har olika beskrivningar i olika modeller
  - Kolumn förekommer i ≥ N modeller → kandidat för docs-block
- **Sidopanel (tree view)**: täckning per mapp/lager/tagg, och en arbetslista sorterad på
  "måste skrivas för hand" först.

## Docs-block-fil

- Inställning `heirloom.docsBlocks.defaultFile`, t.ex. `models/_docs/columns.md`.
- Vid extrahering: snabbval med befintliga `.md`-filer i `docs-paths`/`model-paths`, eller "Ny fil…".
- Namnkonvention, konfigurerbar: `col__{column_name}` som standard (kan göras per lager, t.ex.
  `stg__customer_id`?).
- Ny referens skrivs som `description: "{{ doc('col__customer_id') }}"`.

## Teknisk arkitektur

```
packages/
  core/        # TypeScript: läsa manifest, YAML, lineage, regler. Inga VS Code-beroenden
  vscode/      # Tillägget: hints, hover, code actions, tree view
  cli/         # Samma core i terminal/CI: `heirloom coverage --fail-under 80`
```

- **TypeScript hela vägen**: ingen Python, dbt-core eller dbt-osmosis behövs. Det gör att
  verktyget fungerar likadant med Fusion som med dbt Core.
- **Indata**: `target/manifest.json` (skrivs av både dbt Core och Fusion) samt YAML-filerna
  direkt från disk. Valfritt `catalog.json` för att hitta kolumner som saknas i YAML.
- **YAML-redigering**: biblioteket `yaml` (eemeli) via Document API för att bevara kommentarer,
  ordning och citattecken. Ändringar görs som `WorkspaceEdit` så att det går att ångra.
- **Fusion-kompatibilitet**: skriva YAML enligt de nyare reglerna (t.ex. `config:`-block,
  `arguments:` för tester) och testa mot dbt-fusion-manifest i CI.
- **Lineage**, i steg:
  1. Namnmatchning via `depends_on` i manifest (enkelt, täcker de flesta passthrough).
  2. SQL-tolkning av kompilerad SQL för att hitta omdöpningar och transformationer.
  3. Undersöka om Fusions egna kolumnlineage går att läsa (LSP eller artefakter).
- **AI**: VS Code Language Model API (`vscode.lm`), som använder den modell användaren redan har
  i editorn, alternativt egen API-nyckel. Underlag: SQL, uppströms beskrivningar, kolumnnamn.

## Befintliga verktyg

| Verktyg | Lucka som heirloom fyller |
|---|---|
| Officiella dbt VS Code-tillägget (Fusion) | Fokus på kompilering/lineage, inte dokumentationsarbete. heirloom ska fungera bredvid det |
| dbt-osmosis | Python/dbt-core, skriver om filer hårt, visar inte varför något ärvdes |
| dbt-coverage, dbt_project_evaluator | Mäter, men hjälper inte att åtgärda |

## Öppna frågor

- Utvecklar teamet lokalt i VS Code (dbt Cloud CLI / Fusion) eller i dbt Clouds webb-IDE?
  Ett VS Code-tillägg fungerar bara i det första fallet.
- Vem bygger `manifest.json` lokalt? Krävs `dbt parse` vid varje ändring, eller ska heirloom
  kunna läsa YAML/SQL utan manifest för det enkla fallet?
- Ska omdöpta kolumner (`id as customer_id`) ärva automatiskt, eller bara föreslås?
- Tröskel för "kandidat för docs-block": antal modeller, eller också krav på att texten är likadan?
- Ska källor (`sources`) och seeds räknas i täckningen?
- Distribution: VS Code Marketplace + Open VSX (för Cursor m.fl.)?
- Licens: MIT eller Apache-2.0?
