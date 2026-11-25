# Changelog

## 0.2.0 - 2026-11-25

- Use the context and output limits CCR advertises per route (`context_window`, `max_input_tokens`, `max_context_window`, `max_output_tokens`), so routes missing from Pi's catalog keep the CCR budget instead of the 128K/16K fallback.
- Map CCR `supported_reasoning_levels` onto Pi thinking levels, including models Pi does not know. Levels Pi maps to `null` stay unavailable, unknown vocabularies keep Pi's levels, and `off` stays available unless the catalog forbids it.
- Treat `reasoning_required` from CCR as a reasoning model even when no levels are listed.
- CPA live enrichment still outranks CCR and Pi catalog metadata for `CPA/...` routes.

## 0.1.0 - 2026-11-03

- Initial release.
- Discover CCR models at startup and during Pi model refreshes.
- Resolve known model metadata from Pi's built-in catalog.
- Optionally enrich `CPA/...` routes with route-specific context and output limits from CLIProxyAPI.
- Persist model metadata snapshots for offline and transient-failure fallback without storing API keys.
