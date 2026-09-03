# screen-pomodoro

[![CI](https://github.com/tangentyh/screen-pomodoro/actions/workflows/ci.yml/badge.svg)](https://github.com/tangentyh/screen-pomodoro/actions/workflows/ci.yml)

A tiny CLI pomodoro timer that pauses when your screen locks.

> 🚧 **Under construction** — the repo currently holds the CLI scaffold (entry point, `--help` / `--version` plumbing, tests, CI). The pomodoro timing and screen-lock awareness land in an upcoming release.

- Runnable via `npx` — no install step required
- Fully typed TypeScript (strict, ESM), tested with Vitest

## Quick start

```sh
# Run without installing
npx screen-pomodoro

# Show usage
npx screen-pomodoro --help
```

## CLI

```
Usage: screen-pomodoro [options]

A pomodoro timer that pauses when your screen locks.

Options:
  -V, --version  Print the version number
  -h, --help     Print help
```

## Development

Requires Node.js >= 22.

```sh
npm install              # also installs git hooks (husky)
npm run dev              # run the CLI from source
npm run dev -- --help    # …with arguments
```

| Script                                          | What it does                                                |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `npm run build`                                 | Bundle to `dist/` with tsup (ESM)                           |
| `npm run dev`                                   | Run the CLI from source with tsx                            |
| `npm run typecheck`                             | `tsc --noEmit`                                              |
| `npm run lint`                                  | ESLint (flat config, type-checked rules)                    |
| `npm run format` / `format:check`               | Prettier                                                    |
| `npm run test` / `test:watch` / `test:coverage` | Vitest                                                      |
| `npm run verify`                                | typecheck + lint + format:check + test + build (runs in CI) |

Pre-commit, [lint-staged](https://github.com/lint-staged/lint-staged) lints and formats staged files via [husky](https://typicode.github.io/husky/).

## License

[MIT](./LICENSE)
