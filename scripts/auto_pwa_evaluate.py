#!/usr/bin/env python3
"""
auto_pwa_evaluate: turn a fit's weight_best.root into an AI-readable evaluation
package — the same information a physicist reads off the plots, quantified.

    python scripts/auto_pwa_evaluate.py <weight_best.root> <out_dir>

Outputs:
  out_dir/evaluate.json   numeric diagnostics (the AI's primary channel)
  out_dir/pull_<name>.png pull distributions (data-fit)/sigma per 1D plot
  out_dir/fit_<name>.png  data vs fit vs background overlay

Diagnostics per 1D distribution (mass/cosbeta):
  - pull per bin: (N_data - N_fit) / sqrt(N_data)  (Poisson data error)
  - chi2 = sum pull^2, ndf = nbins-1, chi2/ndf
  - max |pull| and bins exceeding 3sigma/5sigma (the "where it is wrong" answer)
  - per-wave fractions: integral of each h_* vs hfit (which waves matter)
Requires the ctpwa env:  <ctpwa env>/bin/python scripts/auto_pwa_evaluate.py ...
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import uproot


def pull_bins(data: np.ndarray, fit: np.ndarray) -> np.ndarray:
    """(data - fit)/sqrt(data); bins with data==0 contribute 0."""
    denom = np.sqrt(np.maximum(data, 0))
    with np.errstate(divide="ignore", invalid="ignore"):
        pull = np.where(denom > 0, (data - fit) / np.where(denom > 0, denom, 1), 0.0)
    return np.asarray(pull, dtype=float)


def hist_to_arrays(h) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centers, contents, errors) from a TH1-like uproot object."""
    edges = h.axis().edges()
    centers = (edges[:-1] + edges[1:]) / 2
    contents = np.asarray(h.values(), dtype=float)
    errors = np.asarray(h.errors(), dtype=float)
    return centers, contents, errors


def analyze_1d(prefix: str, d: uproot.ReadOnlyDirectory, out: dict) -> dict | None:
    """Pull statistics for one mass/cosbeta distribution."""
    if "hdata" not in d or "hfit" not in d:
        return None
    hdata = d["hdata"]
    if not isinstance(hdata, uproot.behaviors.TH1.TH1):
        return None  # 2D dalitz plots are skipped for pull stats
    centers, data, _ = hist_to_arrays(hdata)
    _, fit, _ = hist_to_arrays(d["hfit"])
    pull = pull_bins(data, fit)
    chi2 = float(np.sum(pull**2))
    ndf = int(len(data) - 1)
    over3 = np.where(np.abs(pull) > 3)[0]
    over5 = np.where(np.abs(pull) > 5)[0]
    regions = []
    for idxs in (over3,):
        if len(idxs) == 0:
            continue
        start = prev = int(idxs[0])
        for i in idxs[1:]:
            if int(i) == prev + 1:
                prev = int(i)
            else:
                regions.append([round(float(centers[start]), 3), round(float(centers[prev]), 3)])
                start = prev = int(i)
        regions.append([round(float(centers[start]), 3), round(float(centers[prev]), 3)])
    stat = {
        "chi2": round(chi2, 1),
        "ndf": ndf,
        "chi2_ndf": round(chi2 / ndf, 3) if ndf > 0 else None,
        "max_abs_pull": round(float(np.max(np.abs(pull))), 2),
        "bins_over_3sigma": len(over3),
        "bins_over_5sigma": len(over5),
        "worst_bin": (
            {"center": round(float(centers[int(np.argmax(np.abs(pull)))]), 3),
             "pull": round(float(pull[int(np.argmax(np.abs(pull)))]), 2)}
            if len(pull) > 0 else None
        ),
        "pull_regions_over_3sigma": regions,
        "bin_width": round(float(centers[1] - centers[0]), 4) if len(centers) > 1 else None,
        "range": [round(float(centers[0]), 3), round(float(centers[-1]), 3)] if len(centers) else None,
    }
    out[prefix] = stat
    return stat


def wave_fractions(d: uproot.ReadOnlyDirectory) -> dict:
    """Integral of each wave histogram relative to hfit."""
    fit_total = float(np.sum(d["hfit"].values())) if "hfit" in d else 0.0
    fracs: dict[str, float] = {}
    for key in d.keys():
        name = key.split(";")[0]
        if not name.startswith("h_") or name in ("hdata", "hfit", "hbkg"):
            continue
        total = float(np.sum(d[key].values()))
        if fit_total > 0:
            fracs[name[2:]] = round(total / fit_total, 4)
    return dict(sorted(fracs.items(), key=lambda kv: -abs(kv[1])))


def plot_pull(prefix: str, d: uproot.ReadOnlyDirectory, out_dir: Path) -> None:
    centers, data, _ = hist_to_arrays(d["hdata"])
    _, fit, _ = hist_to_arrays(d["hfit"])
    pull = pull_bins(data, fit)
    fig, ax = plt.subplots(figsize=(7, 3))
    ax.bar(centers, pull, width=centers[1] - centers[0], color="#1a6e5c", alpha=0.75)
    ax.axhline(0, color="k", lw=0.8)
    for s, c in ((3, "#a05a12"), (5, "#a03028")):
        ax.axhline(s, color=c, ls="--", lw=0.8)
        ax.axhline(-s, color=c, ls="--", lw=0.8)
    ax.set_title(f"pull: {prefix}")
    ax.set_xlabel("x")
    ax.set_ylabel("(data-fit)/sqrt(data)")
    ax.set_ylim(-8, 8)
    fig.tight_layout()
    fig.savefig(out_dir / f"pull_{prefix}.png", dpi=110)
    plt.close(fig)


def plot_fit(prefix: str, d: uproot.ReadOnlyDirectory, out_dir: Path) -> None:
    centers, data, derr = hist_to_arrays(d["hdata"])
    _, fit, _ = hist_to_arrays(d["hfit"])
    has_bkg = "hbkg" in d
    bkg = np.asarray(d["hbkg"].values(), dtype=float) if has_bkg else None
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.errorbar(centers, data, yerr=derr, fmt="o", ms=3, lw=1, color="#1c1c1a", label="data")
    ax.plot(centers, fit, "-", color="#1a6e5c", lw=1.5, label="fit")
    if bkg is not None:
        ax.plot(centers, bkg, "--", color="#a05a12", lw=1.2, label="bkg")
    ax.set_title(f"data vs fit: {prefix}")
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(out_dir / f"fit_{prefix}.png", dpi=110)
    plt.close(fig)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    root_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    f = uproot.open(root_path)
    result: dict = {
        "source": str(root_path),
        "distributions": {},
        "waves": {},
        "notes": [
            "chi2_ndf: 全局拟合质量（≈1 理想；>2 明显偏差）",
            "bins_over_5sigma: 严重偏差 bin 数（>0 需要关注对应区域）",
            "pull_regions_over_3sigma: 偏差所在质量/角度区间",
            "waves: 各分波占总拟合的份额（h_* 积分 / hfit 积分），按 |份额| 降序",
        ],
    }

    for key in f.keys():
        name = key.split(";")[0]
        obj = f[key]
        if not isinstance(obj, uproot.ReadOnlyDirectory):
            continue
        has_1d = "hdata" in obj and isinstance(obj["hdata"]._file if hasattr(obj["hdata"], "_file") else obj["hdata"], uproot.behaviors.TH1.TH1)
        kind = "1d" if "hdata" in obj and "TH1" in str(type(obj["hdata"])) else ("2d" if "hdata" in obj else "other")
        stat = analyze_1d(name, obj, result["distributions"])
        if stat is not None:
            plot_pull(name, obj, out_dir)
            plot_fit(name, obj, out_dir)
        if "hdata" in obj:
            result["waves"][name] = wave_fractions(obj)

    # Summarize the worst distributions.
    dists = result["distributions"]
    ranked = sorted(dists.items(), key=lambda kv: -(kv[1]["max_abs_pull"] if kv[1]["max_abs_pull"] is not None else 0))
    result["worst_distributions"] = [
        {"name": n, "max_abs_pull": s["max_abs_pull"], "chi2_ndf": s["chi2_ndf"], "bins_over_5sigma": s["bins_over_5sigma"]}
        for n, s in ranked[:6]
    ]

    (out_dir / "evaluate.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    print(f"[auto_pwa_evaluate] wrote {out_dir / 'evaluate.json'} + PNGs "
          f"({len(result['distributions'])} 1d dists, {len(result['waves'])} wave sets)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
