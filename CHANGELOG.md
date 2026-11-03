# Changelog

## 0.1.0 - 2026-11-03

- Initial release.
- Discover CCR models at startup and during Pi model refreshes.
- Resolve known model metadata from Pi's built-in catalog.
- Optionally enrich `CPA/...` routes with route-specific context and output limits from CLIProxyAPI.
- Persist model metadata snapshots for offline and transient-failure fallback without storing API keys.
