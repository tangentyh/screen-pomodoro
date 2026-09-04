# 001 — Toolchain Decisions

Status: accepted. Records the build/lint/packaging choices made after the
`tsup` → `tsdown` migration, so future "should we switch to X?" questions
resolve against written rationale instead of relitigation.

## Build: `tsdown` (migrated from `tsup`)

- `tsup` is no longer actively maintained (upstream README recommends
  `tsdown`). Migrated to `tsdown ^0.23.0`, the Rolldown + Oxc successor.
- Config (`tsdown.config.ts`): single entry `src/cli.ts` → `dist/`, ESM,
  `node22` target, sourcemap, clean. Dropped tsup's `splitting: false`
  (code-splitting is always on in tsdown; a no-op for one entry).
- Removed the `ignoreDeprecations: 6.0` workaround from `tsconfig.json` —
  it existed only because tsup's DTS builder injected a deprecated `baseUrl`.
  `tsc --noEmit` passes without it. (No DTS output at all: this package ships
  a bin only, `exports` exposes just `./package.json`.)

## Output extension: `.js`, not `.mjs`

- tsdown defaults ESM output to `.mjs`; we pin
  `outExtensions: () => ({ js: '.js' })` to keep emitting `dist/cli.js`.
- Rationale: `package.json` sets `"type": "module"`, so `.js` already is ESM
  and `.mjs` adds no information. `.js` keeps the `bin` path
  (`./dist/cli.js`), docs, and prior release layout stable.
- Revisit if we ever ship dual-format (CJS + ESM) output, where `.js`
  becomes ambiguous and explicit `.mjs`/`.cjs` disambiguates.

## Considered and deferred

- **Vite / Rspack — no.** App bundlers (dev server, HMR, browser output).
  We ship one Node CLI file; nothing to serve or hot-reload.
- **Biome / Oxlint — deferred.** Faster, but our ESLint setup runs
  type-checked rules (`recommendedTypeChecked` + `stylisticTypeChecked`)
  that catch real bugs a speed-optimized engine doesn't. Lint time is not a
  pain point at this size. Revisit if the codebase grows or ESLint feels slow.
- **pnpm — deferred.** Wins are monorepo workspaces and disk efficiency.
  Single package on `package-lock.json`; switching is lockfile + CI churn
  for no felt gain. Revisit if this becomes a monorepo.
- **Bun (runtime) — no.** Our story is "runs via `npx` on Node ≥ 22."
  A runtime swap risks that compat for speed we don't need.
- **Turborepo — no.** Orchestrates cached tasks across many packages.
  One package, a handful of scripts — nothing to orchestrate.
- **Vitest — kept.** Already the default choice for this shape of project;
  no reason to move.

## Resulting stack

npm + tsdown + Vitest + ESLint (type-checked) + Prettier, strict ESM
TypeScript on Node ≥ 22. Rust-powered pieces are adopted where they remove
maintenance risk (tsdown), not where they'd add migration churn for no
measured benefit.
