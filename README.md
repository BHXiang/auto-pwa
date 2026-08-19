# auto-pwa

AI-driven **partial wave analysis (PWA)** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): physics-gated config editing, ctpwa fit execution, numeric fit evaluation, and goal-driven iterative convergence.

The package is split in two layers:

- **`src/` — pure physics core** (no DSH dependency): PDG-2026 lookup, J^P reachability, resonance-addition validation, structured config.yml editing, float-policy suggestions, fit summary parsing, iteration diary (JSONL + HTML), local fit runner.
- **`plugin/` — thin DSH integration**: twelve `auto_pwa_*` tools wrapping the core, mountable into any DSH profile via `--patch`.

## Quick start

```sh
# 1. install dependencies (yaml; dev tools)
npm install

# 2. (optional) link a DeepSeek Harness checkout for real-API development
DSH_ROOT=/path/to/deepseek-harness npm run dev:setup

# 3. run tests / typecheck / build
npm test
npm run typecheck
npm run build
```

Mount the plugin into DSH (paths must be absolute):

```sh
pnpm dsh web --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml
# headless:
pnpm dsh --profile headless --patch /absolute/path/to/auto-pwa/patch/auto-pwa.cordis.yml "完成此文件夹分波"
```

## Tools

| Tool | Purpose |
|---|---|
| `auto_pwa_lookup` | Query the PDG-2026 resonance table (name/J^P/mass range/decay modes, with uncertainties) |
| `auto_pwa_decay_check` | Allowed intermediate J^P for A → R + B (angular momentum + parity), candidates below threshold |
| `auto_pwa_validate_add` | Read-only gate for adding/attaching a resonance (PDG backing, JPC, threshold, duplicates, free structure) |
| `auto_pwa_edit_config` | Strongly-constrained config.yml edit: validate → structured apply → render → atomic write (+.bak) |
| `auto_pwa_iterate` | One iteration: validate → new iter dir (Data paths absolutized) → write config → submit fit |
| `auto_pwa_round` | **Main path**: evaluate previous round (NLL/ΔNLL/worst pulls/convergence hint) + iterate in ONE call |
| `auto_pwa_run_fit` / `auto_pwa_fit_status` | Submit/poll a ctpwa fit (background job, GPU fail-fast) |
| `auto_pwa_evaluate` | weight_best.root → numeric diagnostics (chi2/ndf, pull regions, wave fractions) + PNGs |
| `auto_pwa_iter_start` | Create `iterations/iter-N/` (config copy + script symlinks) |
| `auto_pwa_note` / `auto_pwa_history` | Append/read the iteration diary (SUMMARY.jsonl + rendered HTML) |

## Iteration loop

```
auto_pwa_round (evaluate + decide + submit)
   └─> fit runs in background (8 min on RTX-class GPU)
   └─> next auto_pwa_round evaluates results, model decides next proposal
   └─> convergence when max|pull| < 5 and |ΔNLL| < 10
```

Drive it with a same-session goal for automatic rounds (see `PLAN-STEP1.md` §9 for the GUI verification recipe).

## Machine-specific paths

Environment variables (see `src/config.ts`):

| Env | Default (developer host) |
|---|---|
| `PWA_CTPWA_PYTHON` | ctpwa conda env python |
| `PWA_LD_LIBRARY_PATH` | ROOT/CUDA/torch libs for importing ctpwa |
| `PWA_FIT_SCRIPT` / `PWA_PLOT_SCRIPT` | solver fit.py/plot.py sources |
| `PWA_EVAL_OUT_DIR` | auto_pwa_evaluate output directory |

## Development

- Pure core is environment-free and unit-tested (57 tests): `npm test`.
- The plugin imports `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis`; tests resolve **vendored stubs** (`vendor/dsh/`) so no DSH checkout is needed. The stubs cover exactly the surface the plugin uses; keep them in sync when the DSH API changes.
- `scripts/fetch_pdg.py` regenerates `data/pdg.json` from the official PDG-2026 package (requires `pip install pdg` in the ctpwa env).
- Fit execution needs a CUDA GPU (ctpwa has no CPU backend); the runner probes and fails fast with a clear diagnostic.

## Docs

- `PLAN-STEP1.md` — first-step architecture & decisions (iteration layout, goal loop, transport)
- `PLAN-STEP2.md` — capability map & roadmap (25 directions across all DSH domains)
- `dev-plan.html` — original development plan (milestones)

## License

MIT — see [LICENSE](LICENSE).
