# pi-ccr-provider

A Pi provider extension for [Claude Code Router (CCR)](https://github.com/musistudio/claude-code-router), with optional route-specific model metadata from [CLIProxyAPI (CPA)](https://github.com/router-for-me/CLIProxyAPI).

**This is a niche integration for existing CCR users, not a general replacement for Pi's built-in provider login.**

## Who this is for

Use this extension when you **already run CCR** and want Pi to reuse its model catalog and routing without duplicating configuration. It is especially useful if you:

- run CCR with multiple providers, accounts, or models;
- add or change models in CCR and want Pi's `/model` list to discover them automatically;
- use CCR aliases, routing, profiles, or fallback behavior;
- use CPA behind CCR and want context/output limits from the actual CPA route rather than generic model metadata;
- want to avoid hand-maintaining CCR model definitions in Pi's `models.json`.

## Who should use something else

This extension is probably unnecessary if you:

- only use official Anthropic or Codex accounts — Pi's built-in `/login` flow is simpler;
- only use CPA — connecting Pi directly to CPA avoids an extra CCR layer;
- do not already run CCR and do not want another long-running local service;
- prefer a small, static provider configuration over dynamic discovery.

In short: **use Pi login for direct official access, connect directly to CPA for a CPA-only setup, and use this extension only when CCR itself is already part of your workflow.**

## Features

- Discovers models from CCR at startup and whenever Pi refreshes the model catalog.
- Registers CCR routes under the `ccr` provider using OpenAI Responses.
- Resolves reasoning, thinking levels, input modalities, input limits, pricing, and fallback token limits from Pi's built-in model catalog.
- Optionally reads `context_window` and `max_tokens` directly from CPA for `CPA/...` routes.
- Persists model metadata snapshots for offline or transient-failure fallback.
- Never writes API keys into source files or model-catalog snapshots.

## How it works

```text
Model discovery:
  Pi extension → CCR /v1/models
             ↘ CPA /v1/models?client_version=0.0.0 (optional enrichment)

Inference:
  Pi → CCR :3456 → CPA :8317 → upstream model
```

The extension only changes model registration and metadata. Inference still goes through CCR; Pi does not bypass it when talking to CPA.

Metadata precedence for CPA routes:

1. CPA `context_window` and `max_tokens`
2. CPA `max_input_tokens`, then `max_context_window` for context when necessary
3. Pi's built-in catalog
4. Conservative defaults for unknown models: 128K context, 16K output, text input, no reasoning

CPA's `context_window` is preferred over the potentially larger `max_context_window`, because Pi has a single `contextWindow` used for budgeting and compaction. These are advertised limits; the upstream service may still enforce a smaller actual limit.

## Requirements

- Pi with extension/provider support
- Node.js 22 or newer for local development
- A running CCR gateway
- Optional: CPA for route-specific CPA metadata

## Install

### From a Git repository

Replace the placeholder with your repository owner:

```bash
pi install git:github.com/YOUR_GITHUB_USERNAME/pi-ccr-provider
```

### From a local checkout

From the directory containing this repository:

```bash
pi install ./pi-ccr-provider
```

If you previously copied this extension into `~/.pi/agent/extensions/ccr/`, remove that manual copy before installing the package so the same `ccr` provider is not registered twice.

## Configuration

### Required: CCR gateway key

Set the key accepted by your CCR gateway in the environment that starts Pi:

```bash
export CCR_API_KEY='your-ccr-gateway-or-profile-key'
```

This is a **CCR key**, not your Claude/OpenAI upstream credential.

The default CCR endpoint is:

```text
http://127.0.0.1:3456/v1
```

### Recommended for CPA users: CPA client key

```bash
export CPA_API_KEY='your-cpa-client-key'
```

This is the CPA client API key configured in your CCR CPA provider, **not** the CPA management key. Without it, discovery still works, but CPA context/output limits come from Pi's catalog or a previous snapshot instead of live CPA metadata.

The default CPA endpoint is `http://127.0.0.1:8317`. To override it:

```bash
export CPA_BASE_URL='http://127.0.0.1:8317'
```

A URL ending in `/v1` is also accepted.

See [`.env.example`](./.env.example). Do not commit real credentials.

## Use

Restart Pi after changing environment variables, then open `/model` and search for `ccr/`.

You can also select a model directly:

```bash
pi --provider ccr --model 'CPA/claude-sonnet-5-5'
```

Opening `/model` triggers a live refresh. If CCR or CPA is unavailable, the extension keeps the current or last persisted model metadata where possible. API keys are never included in the snapshot.

## Development

```bash
npm ci
npm run check
```

Or run the checks separately:

```bash
npm run typecheck
npm test
```

Unit tests use mocked HTTP responses and do not require CCR or CPA to be running.

To try the local extension without installing it as a package:

```bash
pi -e ./src/index.ts
```

## Security

Pi extensions execute with the same operating-system permissions as Pi. Review the source before installation and only load repositories you trust. The extension reads `CCR_API_KEY`, `CPA_API_KEY`, and optionally `CPA_BASE_URL`; it does not print or persist those credentials.

## License

MIT
