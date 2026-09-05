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
  -V, --version        Print the version number.
  --focus <duration>   Focus duration (minutes or with s/m/h suffix). (default: "25")
  --short <duration>   Short break duration (minutes or with s/m/h suffix). (default: "5")
  --long <duration>    Long break duration (minutes or with s/m/h suffix). (default: "15")
  --cycles <n>         Focuses per long break (integer >= 1). (default: "4")
  --no-loop            Stop after the first long break instead of looping forever.
  -q, --quiet          Log transitions only, no live countdown.
  --confirm            Awaits y/n on each phase transition (requires interactive stdin).
  --focus-name <name>  Custom label for focus phases. (default: "Focus")
  --short-name <name>  Custom label for short breaks. (default: "Short break")
  --long-name <name>   Custom label for long breaks. (default: "Long break")
  -h, --help           display help for command
```

Custom names appear in every phase line, pause/resume notice, confirm prompt,
and summary (`--focus-name "Deep work"` → `Deep work 1/4`,
`Completed 3 Deep work`). Names must be non-empty after trimming, at most 40
characters, with no control characters.

With `--confirm`, each deadline rings once and asks:

```
Deep work complete. Start Coffee? [y/n] y
```

`y` advances one phase, `n` restarts the current phase with a full deadline.
Anything else re-prompts. `--confirm` needs an interactive terminal
(`--confirm requires an interactive terminal` otherwise). `--no-loop` still
exits after the long break without a trailing prompt.

## Development

Requires Node.js >= 22.

```sh
npm install              # also installs git hooks (husky)
npm run dev              # run the CLI from source
npm run dev -- --help    # …with arguments
```

| Script                                          | What it does                                                |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `npm run build`                                 | Bundle to `dist/` with tsdown (ESM)                         |
| `npm run dev`                                   | Run the CLI from source with tsx                            |
| `npm run typecheck`                             | `tsc --noEmit`                                              |
| `npm run lint`                                  | ESLint (flat config, type-checked rules)                    |
| `npm run format` / `format:check`               | Prettier                                                    |
| `npm run test` / `test:watch` / `test:coverage` | Vitest                                                      |
| `npm run verify`                                | typecheck + lint + format:check + test + build (runs in CI) |

Pre-commit, [lint-staged](https://github.com/lint-staged/lint-staged) lints and formats staged files via [husky](https://typicode.github.io/husky/).

## License

[MIT](./LICENSE)
