# Contributing

Thanks for helping! Bug reports, provider additions and fixes are all welcome.

## Setup

```sh
git clone https://github.com/THE-KIPDEV/webhook-toolkit.git
cd webhook-toolkit
npm install
npm run build   # tsc → dist/
npm test        # compiles the tests, then runs them with node:test
```

Node 18.17+ is supported; CI runs Node 18, 20 and 22. The tests never touch the network:
they run against an in-process mock of the API (`test/helpers/mock-server.ts`).

## Guidelines

- Keep runtime dependencies at three (`@modelcontextprotocol/sdk`, `zod`, `ws`). The CLI's
  argument parsing and colors are hand-rolled on purpose.
- `strict` TypeScript, ESM, no `any` in public types.
- Every behaviour change comes with a test. For signatures, add a known-answer vector
  computed independently (another language or the provider's documentation).
- CLI output is part of the UX: keep it short, aligned and readable without colors.

## Adding a provider

- **Detection**: add an entry to `DETECTION_RULES` in `src/detect.ts` and a fixture to
  `test/detect.test.ts` (the test fails if a provider has no fixture).
- **Signing / verification**: add the scheme to `src/signing/providers.ts`, `sign.ts` and
  `verify.ts`, a round-trip test and a fixed vector in `test/signing.test.ts`.

## Pull requests

Open an issue first for anything large. Describe what changed and how you tested it;
`npm run build && npm test` must pass.
