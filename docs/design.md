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
| Licens | MIT (gratis, öppen källkod) |
| Användare | Utvecklare lokalt i VS Code. Analytiker i dbt Cloud behöver inte tillägget; de får nytta av resultatet (YAML + docs-block) och av CLI-kontroller i CI |
| Indata | `manifest.json` krävs (`dbt parse` / Fusion) |
| Omdöpta kolumner | Arv föreslås bara, sker aldrig automatiskt |
| Täckning | Inkluderar `sources` och seeds |
| Distribution | VS Code Marketplace och Open VSX |
| Kandidat för docs-block | Kolumnen förekommer i ≥ 3 modeller (konfigurerbart). Starkare förslag om texten är likadan |
| Inaktuellt manifest | Varning med knapp som kör `dbt parse` (kommando konfigurerbart, t.ex. `dbtf parse` för Fusion) |

## Viktigt om arv i dbt

dbt Core för **inte** automatiskt vidare kolumnbeskrivningar till modeller nedströms i YAML,
`manifest.json`, `dbt docs` eller `persist_docs`. En kolumn utan beskrivning är tom, även om den
heter likadant uppströms. dbt Catalog/Explorer i dbt Cloud kan *visa* ärvda beskrivningar för
kolumner som bara skickas vidare eller döps om (detta behöver verifieras för den nivå av dbt Cloud
som används). Texten skrivs dock aldrig in i projektet.

dbt-docs-helper ska alltså göra arvet synligt **i editorn**, och kunna göra det beständigt i YAML.

### Strategi för beständigt arv
1. Uppströms kolumn har `{{ doc('x') }}` → skriv samma referens nedströms. Ingen dubblerad text.
2. Uppströms kolumn har vanlig text → föreslå "Flytta till docs-block och länka båda".
   Arv blir då i praktiken återanvändning av docs-block.
3. Användaren kan välja att inte skriva något och bara låta dbt-docs-helper visa arvet virtuellt
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

- Inställning `dbt-docs-helper.docsBlocks.defaultFile`, t.ex. `models/_docs/columns.md`.
- Vid extrahering: snabbval med befintliga `.md`-filer i `docs-paths`/`model-paths`, eller "Ny fil…".

### Namnkonvention
`col_{modell}__{kolumn}`, t.ex. `col_stg_customers__customer_id`.

- `col_` visar att det är en kolumnbeskrivning (skiljer från t.ex. modellbeskrivningar).
- Modellnamnet är den modell där kolumnen **har sitt ursprung**, inte varje modell som
  använder den. Nedströms modeller som ärver länkar till samma block.
- Två kolumner med samma namn men olika betydelse (t.ex. `status` i `orders` och `payments`)
  får därmed olika block.
- För källor: `col_{source}_{tabell}__{kolumn}`, t.ex. `col_crm_customers__customer_id`.
- `__` (dubbelt understreck) skiljer modell från kolumn, eftersom båda kan innehålla `_`.
- Mönstret ska vara konfigurerbart: `dbt-docs-helper.docsBlocks.namePattern = "col_{model}__{column}"`.
- Om modellen döps om ligger blocknamnet kvar. Lägg till en varning: "Blockets prefix matchar
  ingen befintlig modell".

Ny referens skrivs som `description: "{{ doc('col_stg_customers__customer_id') }}"`.

## Teknisk arkitektur

```
packages/
  core/        # TypeScript: läsa manifest, YAML, lineage, regler. Inga VS Code-beroenden
  vscode/      # Tillägget: hints, hover, code actions, tree view
  cli/         # Samma core i terminal/CI: `dbt-docs-helper coverage --fail-under 80`
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

| Verktyg | Lucka som dbt-docs-helper fyller |
|---|---|
| Officiella dbt VS Code-tillägget (Fusion) | Fokus på kompilering/lineage, inte dokumentationsarbete. dbt-docs-helper ska fungera bredvid det |
| dbt Power User (AltimateAI) | Brett tillägg med AI-genererade docs och kolumnlineage. dbt-docs-helper fokuserar på arv, docs-block och täckning |
| dbt-osmosis | Python/dbt-core, skriver om filer hårt, visar inte varför något ärvdes |
| dbt-coverage, dbt_project_evaluator | Mäter, men hjälper inte att åtgärda |

## Öppna frågor

- Vad händer när det finns flera manifest (t.ex. `target/` och dbt Cloud CLI:s egen katalog)?
- Slutligt namn på projektet.
