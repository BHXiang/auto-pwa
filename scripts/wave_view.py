#!/usr/bin/env python3
"""wave_view: draw selected partial-wave combinations from a finished fit.

The AI cannot look at PNG plots; this script turns ctpwa's writeResult(waves)
into structured JSON the model can reason about. Two modes:

  default  (small files, histograms only — the recommended path):
      python wave_view.py --config config.yml --fit-json results/fit.json \
          --waves phi1020,f0_1500 --out results/weight_waves.root [--json wave.json]
      Rebuilds the best-fit params from fit.json, calls
      writeResult(params, out.root, 0, waves) and reads back the histograms:
      hdata/hfit/hbkg of the SELECTED combination (normalized to the same
      data integral as the full fit, so they are directly comparable with
      the full-model weight_best.root) plus the per-wave spectra.

  --event-weights (large, explicit opt-in; use sparingly — the saved_weight
      TTree is per-event and grows with statistics):
      python wave_view.py ... --event-weights --interf-waves phi1020,f0_1500
      is_saved_weight=1 writes weight_<name> and interf_<i>_<j> branches;
      the script histogramizes the selected pairs into wave_decomp.json
      (mass variables recomputed from the daughter four-momenta) and DELETES
      the big TTree file afterwards.

Wave names map to partial indices through the h_<name> histogram directories
of the reference weight_best.root (resonance_names_ == partial order).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import numpy as np
import uproot


# ---------------------------------------------------------------------------
# pure helpers (unit-testable without GPU)
# ---------------------------------------------------------------------------

def rebuild_params_from_fit_json(fit_json: dict) -> np.ndarray:
    """Reconstruct the writeResult params layout from fit.json's best.params.

    aifit layout: [Re(c_0..n-1), Im(c_0..n-1), theta_0..m-1] (float64),
    with the reference amplitude real part fixed to 1.0 and imag to 0.0.
    """
    best = (fit_json.get("fit") or {}).get("best") or {}
    params_raw = best.get("params") or []
    reals: list[float] = []
    imags: list[float] = []
    thetas: list[float] = []
    for p in params_raw:
        kind = p.get("kind")
        if kind == "coupling":
            reals.append(float(p.get("real", 0.0)))
            imags.append(float(p.get("imag", 0.0)))
        elif kind == "resonance":
            thetas.append(float(p.get("value", 0.0)))
    if not reals:
        raise ValueError("fit.json best.params 没有 coupling 参数——无法重建 writeResult params")
    return np.concatenate([np.array(reals), np.array(imags), np.array(thetas)])


def partial_names_from_root(root_path: Path) -> list[str]:
    """Partial (wave) names in writeResult order, from the h_<name> histograms
    inside the distribution directories of a weight_best.root
    (path form: mass0_Kp_Km/h_chain1-R_KK-phi1020)."""
    names: list[str] = []
    seen: set[str] = set()
    with uproot.open(str(root_path)) as f:
        for key in f.keys(recursive=True):
            name = key.split(";")[0]
            if "/h_" not in name:
                continue
            base = name.split("/")[-1]
            if base in seen:
                continue
            seen.add(base)
            # "h_chain1-R_KK-phi1020" -> "chain1-R_KK-phi1020"
            names.append(base[len("h_"):])
    return sorted(names)


def resolve_wave_indices(names: list[str], want: list[str]) -> tuple[list[int], list[str]]:
    """Map requested wave names (substring-insensitive) to partial indices."""
    indices: list[int] = []
    missing: list[str] = []
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    for w in want:
        matches = [i for i, n in enumerate(names) if norm(n) == norm(w)]
        if not matches:
            missing.append(w)
        else:
            indices.append(matches[0])
    return indices, missing




# ---------------------------------------------------------------------------
# GPU part (needs a CUDA device; skipped in tests without one)
# ---------------------------------------------------------------------------

def make_cuda_params(arr: np.ndarray):
    import torch
    return torch.tensor(arr, dtype=torch.float64, device="cuda")


def run_write_result(ana, params_cuda, out_root: str, is_saved_weight: int, indices: list[int]):
    ana.writeResult(params_cuda, out_root, is_saved_weight, indices)


def read_histograms(root_path: Path, names: list[str]) -> dict:
    """Per-bin data of the requested TH1s inside a distribution directory."""
    out: dict[str, dict] = {}
    with uproot.open(str(root_path)) as f:
        for key in f.keys(recursive=True):
            name = key.split(";")[0]
            obj = f[name]
            if not isinstance(obj, uproot.behaviors.TH1.TH1):
                continue
            # match basename (hdata / hfit / hbkg / h_<name>)
            base = name.split("/")[-1]
            if base in names:
                edges = obj.axis().edges()
                vals = np.asarray(obj.values())
                out[base] = {
                    "bins": int(len(vals)),
                    "range": [float(edges[0]), float(edges[-1])],
                    "integral": float(vals.sum()),
                    "values": [float(v) for v in vals],
                    "errors": [float(e) for e in obj.errors()],
                }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", required=True, help="config.yml 绝对路径")
    ap.add_argument("--fit-json", required=True, help="results/fit.json 绝对路径")
    ap.add_argument("--ref-root", default="", help="参考 weight_best.root（取 h_ 波名；默认 fit-json 同目录）")
    ap.add_argument("--waves", default="", help="逗号分隔的波名（h_ 名去掉前缀，如 chain1-R_KK-phi1020）")
    ap.add_argument("--out", default="", help="组合波谱输出 root（默认 fit-json 同目录 weight_waves.root）")
    ap.add_argument("--json", default="", help="逐 bin JSON 输出路径（默认 stdout）")
    ap.add_argument("--event-weights", action="store_true", help="显式开启 is_saved_weight=1（大文件，慎用）")
    ap.add_argument("--interf-waves", default="", help="event-weights 时直方图化的干涉对波名（逗号分隔）")
    args = ap.parse_args()

    fit_json_path = Path(args.fit_json)
    ref_root = Path(args.ref_root) if args.ref_root else fit_json_path.parent / "weight_best.root"
    out_root = Path(args.out) if args.out else fit_json_path.parent / "weight_waves.root"

    if not ref_root.exists():
        print(json.dumps({"ok": False, "error": f"参考 weight_best.root 不存在: {ref_root}"}))
        return 1

    # 1. rebuild params from fit.json
    try:
        fit_json = json.loads(fit_json_path.read_text())
        params_np = rebuild_params_from_fit_json(fit_json)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"重建 params 失败: {type(e).__name__}: {e}"}))
        return 1

    # 2. resolve wave indices from the reference root's h_ names
    try:
        names = partial_names_from_root(ref_root)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"读取 h_ 波名失败: {type(e).__name__}: {e}"}))
        return 1
    want = [w.strip() for w in args.waves.split(",") if w.strip()]
    indices, missing = resolve_wave_indices(names, want)
    if missing:
        print(json.dumps({"ok": False, "error": f"未知波名: {missing}（可用: {names[:12]}…）"}))
        return 1

    # 3. GPU writeResult
    try:
        import ctpwa
        import torch  # noqa: F401 — device probe
        if not torch.cuda.is_available():
            print(json.dumps({"ok": False, "error": "no CUDA device available（writeResult 需要 GPU）"}))
            return 1
        ana = ctpwa.analysis(args.config)
        params_cuda = make_cuda_params(params_np)
        run_write_result(ana, params_cuda, str(out_root), 1 if args.event_weights else 0, indices)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"writeResult 失败: {type(e).__name__}: {e}"}))
        return 1

    # 4. read back histograms (default path)
    result: dict = {
        "ok": True,
        "outRoot": str(out_root),
        "waves": [names[i] for i in indices],
        "histograms": {},
    }
    try:
        hist_names = ["hdata", "hfit", "hbkg"]
        hist_names += [f"h_{names[i]}" for i in indices]
        result["histograms"] = read_histograms(out_root, hist_names)
    except Exception as e:
        result["error"] = f"读回直方图失败: {type(e).__name__}: {e}"

    # 5. (opt-in) event-weights: histogramize selected interf pairs, then delete
    if args.event_weights:
        try:
            config_text = Path(args.config).read_text()
            decomp = build_wave_decomp(out_root, config_text, names, indices,
                                       [w.strip() for w in args.interf_waves.split(",") if w.strip()])
            result["waveDecomp"] = decomp
        except Exception as e:
            result["error"] = f"wave_decomp 失败: {type(e).__name__}: {e}"
        finally:
            try:
                os.remove(out_root)  # 大文件用完即删
            except OSError:
                pass

    text = json.dumps(result, ensure_ascii=False)
    if args.json:
        Path(args.json).write_text(text)
    else:
        print(text)
    return 0


def histogramize_event_interference(root_path: Path, names: list[str], indices: list[int],
                                    interf_waves: str) -> dict:
    """Read saved_weight TTree; histogramize selected interf_<i>_<j> pairs.

    The mass variable for one pair is the invariant mass of the daughters —
    reconstructed from the TTree's four-momentum branches (all daughters of
    the first selected wave's intermediate). For the common single-chain case
    this is the pair mass the wave belongs to.
    """
    import numpy as np

    with uproot.open(str(root_path)) as f:
        tree = f["saved_weight"]
        arrays = tree.arrays()
    n_events = len(arrays["totalweight"])
    # Four-momenta: find particle names from branches like <p>_px.
    mom_particles: list[str] = []
    for b in arrays.fields:
        m = re.match(r"^(.*)_px$", b)
        if m and m.group(1):
            mom_particles.append(m.group(1))
    mom_particles = sorted(set(mom_particles))
    out: dict = {"events": n_events, "momenta": mom_particles, "pairs": {}}
    if len(mom_particles) >= 2:
        p1 = np.stack([np.asarray(arrays[f"{mom_particles[0]}_{c}"]) for c in ("px", "py", "pz", "E")], axis=1)
        p2 = np.stack([np.asarray(arrays[f"{mom_particles[1]}_{c}"]) for c in ("px", "py", "pz", "E")], axis=1)
        m12 = np.sqrt(np.maximum((p1[:, 3] + p2[:, 3]) ** 2
                                 - np.sum((p1[:, :3] + p2[:, :3]) ** 2, axis=1), 0.0))
        out["mass"] = [float(x) for x in m12]
    else:
        out["mass"] = None
    # interference branch names: interf_<i>_<j>
    for i in range(len(indices)):
        for j in range(i + 1, len(indices)):
            bn = f"interf_{indices[i]}_{indices[j]}"
            if bn in arrays.fields:
                vals = np.asarray(arrays[bn])
                out["pairs"][f"{names[indices[i]]} <-> {names[indices[j]]}"] = {
                    "sum": float(vals.sum()),
                    "mean": float(vals.mean()),
                    "meanAbs": float(np.abs(vals).mean()),
                    "fractionOverMean": float(np.sum(vals > 0) / max(len(vals), 1)),
                }
    return out


if __name__ == "__main__":
    raise SystemExit(main())


# ---------------------------------------------------------------------------
# event-weights: per-bin intensity / interference along the pair mass
# ---------------------------------------------------------------------------

def wave_intermediate_from_name(wave_name: str) -> str | None:
    """'chain1-R_KK-phi1020' -> 'R_KK' (the intermediate part)."""
    parts = wave_name.split("-")
    return parts[1] if len(parts) >= 3 else None


def chain_steps_from_config(config_text: str) -> dict[str, list[str]]:
    """Parse DecayChains intermediate steps: {intermediate: [d1, d2]}.

    Supports both `R_KK: [Kp, Km]` and `- R_KK: [Kp, Km]` (decay-list style).
    Only lines whose list members are ALL Particles-section names count as
    decay steps — this excludes chain heads like `Jpsi: [eta, R_KK]` where
    R_KK is an intermediate, not a particle."""
    particles: set[str] = set()
    steps: dict[str, list[str]] = {}
    for line in config_text.splitlines():
        s = line.strip()
        if s.startswith("Particles"):
            continue
        pm = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:$", s)
        if pm and not s.startswith("-") and not s.startswith("Decay"):
            particles.add(pm.group(1))
        m = re.match(r"^(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\[(.*)\]\s*$", s)
        if m:
            items = [x.strip() for x in m.group(2).split(",") if x.strip()]
            if len(items) >= 2 and all(re.match(r"^[A-Za-z0-9_+~-]+$", x) for x in items):
                # Config meta keys are not intermediates (e.g. order/input lists).
                if m.group(1).lower() in ("order", "input", "phsp", "data", "bkg", "bkg_weights", "legend", "display"):
                    continue
                if all(x in particles for x in items):
                    steps[m.group(1)] = items
    return steps


def inv_mass(p1: np.ndarray, p2: np.ndarray) -> np.ndarray:
    """p: (N, 4) [px, py, pz, E]; returns m12 per event."""
    return np.sqrt(np.maximum(
        (p1[:, 3] + p2[:, 3]) ** 2 - np.sum((p1[:, :3] + p2[:, :3]) ** 2, axis=1), 0.0))


def histogramize_along(values: np.ndarray, weights: np.ndarray, edges: np.ndarray) -> list[float]:
    """Sum `weights` into the bins defined by `edges` according to `values`."""
    idx = np.clip(np.searchsorted(edges, values, side="right") - 1, 0, len(edges) - 2)
    out = np.zeros(len(edges) - 1)
    np.add.at(out, idx, weights)
    return [float(x) for x in out]


def build_wave_decomp(root_path: Path, config_text: str, names: list[str],
                      indices: list[int], interf_waves: list[str]) -> dict:
    """Histogramize selected weight_<name> and interf_<i>_<j> along the pair
    mass of each wave's intermediate. Bin structure comes from the reference
    weight_best.root's own h_ histograms, so the output aligns 1:1 with the
    plotted spectra. Deletes nothing here; the caller removes the big file."""
    steps = chain_steps_from_config(config_text)
    with uproot.open(str(root_path)) as f:
        tree = f["saved_weight"]
        arrays = tree.arrays()
    n_events = int(len(arrays["totalweight"]))
    mom_particles = sorted({re.match(r"^(.*)_px$", b).group(1)
                            for b in arrays.fields if re.match(r"^(.*)_px$", b)})
    mom4 = {p: np.stack([np.asarray(arrays[f"{p}_{c}"]) for c in ("px", "py", "pz", "E")], axis=1)
            for p in mom_particles}
    ref_hist_bins: dict[str, np.ndarray] = {}
    with uproot.open(str(root_path)) as f:
        for key in f.keys(recursive=True):
            name = key.split(";")[0]
            base = name.split("/")[-1]
            if base.startswith("h_") and isinstance(f[name], uproot.behaviors.TH1.TH1):
                ref_hist_bins[base] = np.asarray(f[name].axis().edges())

    def mass_edges_for(wave: str) -> np.ndarray | None:
        base = f"h_{wave}"
        if base in ref_hist_bins:
            return ref_hist_bins[base]
        int_name = wave_intermediate_from_name(wave)
        if int_name is None:
            return None
        return None

    def mass_values_for(wave: str) -> np.ndarray | None:
        int_name = wave_intermediate_from_name(wave)
        if int_name is None:
            return None
        daughters = steps.get(int_name, [])
        if len(daughters) < 2:
            return None
        d1, d2 = daughters[0], daughters[1]
        if d1 not in mom4 or d2 not in mom4:
            return None
        return inv_mass(mom4[d1], mom4[d2])

    # First selected wave defines the reference mass axis.
    ref_wave = names[indices[0]]
    edges = mass_edges_for(ref_wave)
    mass = mass_values_for(ref_wave)
    if edges is None or mass is None:
        # Fallback: derive a common axis from the first pair of momenta.
        if len(mom_particles) >= 2:
            mass = inv_mass(mom4[mom_particles[0]], mom4[mom_particles[1]])
            edges = np.linspace(float(np.percentile(mass, 1)), float(np.percentile(mass, 99)), 51)
        else:
            return {"error": "无法确定质量轴（无四动量分支）"}

    out: dict = {
        "nEvents": n_events,
        "massAxis": {"name": f"m({steps.get(wave_intermediate_from_name(ref_wave), ['?', '?'])[0] if wave_intermediate_from_name(ref_wave) in steps else 'd1'},"
                              f"{steps.get(wave_intermediate_from_name(ref_wave), ['?', '?'])[1] if wave_intermediate_from_name(ref_wave) in steps else 'd2'})",
                     "edges": [float(x) for x in edges],
                     "centers": [float((edges[i] + edges[i + 1]) / 2) for i in range(len(edges) - 1)]},
        "waves": {},
        "pairs": {},
    }
    for idx in indices:
        wave = names[idx]
        wvals = np.asarray(arrays[f"weight_{wave}"])
        out["waves"][wave] = histogramize_along(mass, wvals, edges)
    for i in range(len(indices)):
        for j in range(i + 1, len(indices)):
            bn = f"interf_{indices[i]}_{indices[j]}"
            if bn not in arrays.fields:
                continue
            vals = np.asarray(arrays[bn])
            out["pairs"][f"{names[indices[i]]} <-> {names[indices[j]]}"] = histogramize_along(mass, vals, edges)
    return out
