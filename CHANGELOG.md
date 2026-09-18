# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-09-18

### Fixed
- The CLI no longer crashes with `EPIPE` when its output is piped into a command that exits early (`| head`).

### Added
- Publication to the official MCP Registry (`io.github.THE-KIPDEV/webhook-toolkit`) from GitHub Actions.

## [0.1.0] - 2026-09-18

First public release.

### Added

- CLI `webhook-toolkit` (alias `whtk`): `listen` (live stream + `--forward` to localhost),
  `relay` (paid tunnel), `sign`, `verify`, `replay`, `requests`, `endpoints`, `login`,
  `logout`, `whoami` and `mcp`.
- Library: `WebhookToolkit` REST v1 client (endpoints, requests, chained long-poll
  `waitForRequest`, SSE `stream` with reconnection and catch-up), typed `WebhookToolkitError`.
- `sign()` / `verify()` for Stripe, GitHub, Shopify, Slack, Twilio, Mailgun,
  Svix / Standard Webhooks (Clerk, Resend), Paddle Billing and Discord (Ed25519), with a
  diagnosis of failed signatures.
- `detectProvider()`: data-driven sender and event detection for 36 providers.
- MCP server (`webhook-toolkit mcp`, `createMcpServer` from `webhook-toolkit/mcp`) with 11
  tools, including local replay and signed sends to localhost.
