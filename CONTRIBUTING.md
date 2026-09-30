# Contributing

Branchlab keeps simulation rules separate from model-generated actions. Changes should preserve this boundary and the distinction between simulated metrics and empirical predictions.

Install Node 22.13+, run `npm ci`, copy `.env.example` to `.env.local`, and start `npm run dev`. The demo requires no keys. Before opening a pull request, run `npm run check` and `npm run test:e2e` (install Chromium with `npx playwright install chromium` once).

For behavioral changes, add tests at the relevant boundary: frozen actor observations, validated proposals, deterministic reduction, scoped persistence or user-visible browser behavior. Do not record real API keys, personal source documents or database files in fixtures. Tests must not silently fall back from live providers to the demo.

Keep changes focused and explain the observable behavior and validation in your pull request. Model-provider additions need documented environment variables, safe error handling, schema behavior and an offline adapter test. Record any limits honestly; a new prompt is not evidence of improved prediction accuracy.

Original contributions are licensed under the repository's MIT license. Dependencies, papers and borrowed assets retain their own terms; include required attribution when introducing any third-party material.
