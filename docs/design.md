# Designanteckningar (brainstorm)

## Befintliga verktyg att förhålla sig till

| Verktyg | Vad det gör | Lucka som heirloom kan fylla |
|---|---|---|
| `{% docs %}`-block i dbt | Central text som återanvänds med `doc()` | Inget stöd för att *hitta* kandidater eller migrera |
| dbt-osmosis | Propagerar beskrivningar nedströms, skriver YAML | Skriver om filer aggressivt; svårt att se *varför* något ärvdes |
| dbt-coverage | Mäter dokumentations-/testtäckning | Bara siffror, ingen hjälp att åtgärda |
| dbt_project_evaluator | Regler för bl.a. odokumenterade modeller | Modellnivå, inte kolumnnivå |

## Funktionsidéer

### 1. Centrala kolumnbeskrivningar
- `heirloom scan`: gruppera kolumner med samma namn (och ev. samma datatyp) över alla modeller.
- Visa avvikande beskrivningar för samma kolumn ("customer_id" beskrivs på 4 olika sätt).
- `heirloom extract customer_id`: skapa `{% docs col_customer_id %}` och ersätt
  inline-texter med `{{ doc('col_customer_id') }}`.
- Hantera synonymer/alias (`cust_id` → `customer_id`) via konfig.

### 2. Täckning
- `heirloom coverage`: % dokumenterade kolumner/modeller, uppdelat per mapp/lager/tagg.
- Skilja på *saknas*, *ärvbar* (kan fyllas automatiskt) och *måste skrivas manuellt*.
  Det sista är den verkliga arbetsbördan.
- CI-läge: misslyckas om täckningen sjunker, eller om nya modeller saknar beskrivning
  (`--diff origin/main`).

### 3. Arv
- Bygga kolumnlineage (sqlglot, eller dbt:s `depends_on` + namnmatchning som fallback).
- Ärvtyper: rak passthrough (`select customer_id`), omdöpning (`id as customer_id`),
  transformation (`upper(x)`), då ska arv *inte* ske automatiskt.
- Visa en "arvskedja": var kommer texten ursprungligen ifrån?
- Två lägen: *virtuellt arv* (beräknas vid `dbt docs generate`/i rapport) eller
  *materialiserat* (skrivs in i YAML).

### Övrigt
- Generera YAML-skelett för nya modeller med ärvda beskrivningar ifyllda.
- Interaktivt TUI/webb-gränssnitt för att gå igenom saknade beskrivningar en i taget.
- LLM-förslag på beskrivningar utifrån SQL och uppströms-text (opt-in).
- pre-commit-hook.

## Öppna frågor
Se chatten / fyll i här efterhand.
