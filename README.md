# dbt-docs-helper

> Kolumnbeskrivningar som går i arv – skriv en gång, dokumentera överallt.

`dbt-docs-helper` är ett (planerat) verktyg som hjälper dig skriva och underhålla dokumentation i dbt-projekt.

## Mål

1. **Central hantering av återkommande kolumner**: hitta kolumner som förekommer i många modeller
   (t.ex. `customer_id`, `created_at`) och flytta deras beskrivningar till ett centralt ställe
   (`{% docs %}`-block), som sedan refereras med `{{ doc('...') }}`.
2. **Täckningsgrad**: rapportera hur många modeller och kolumner som saknar beskrivning,
   per mapp, lager (staging/intermediate/marts), ägare eller tagg.
3. **Arv via lineage**: använda `manifest.json` och kolumnnivå-lineage för att visa vilka
   beskrivningar som kan ärvas från uppströms modeller, så att de inte behöver skrivas igen.

## Status

Idéstadiet. Se [docs/design.md](docs/design.md) för brainstorm och öppna frågor.

## Licens

MIT, se [LICENSE](LICENSE).
