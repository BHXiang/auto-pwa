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
import re
import sys
from pathlib import Path

import numpy as np
import uproot


def _plt():
    # Lazy import: the plotting backend (matplotlib) must not block the pure
    # parsing paths (parse_plot_meta) — e.g. on hosts with an unwritable
    # matplotlib config dir.
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    return plt


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


def analyze_1d(prefix: str, d: uproot.ReadOnlyDirectory, out: dict,
               meta: dict | None = None) -> dict | None:
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
    if meta:
        stat["meta"] = meta
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
    plt = _plt()
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
    plt = _plt()
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

    # 可选第 3 参数：config.yml（Plot 段 → 分布元信息；缺失时回退旧行为）
    plot_meta: dict = {}
    if len(sys.argv) >= 4 and Path(sys.argv[3]).exists():
        try:
            plot_meta = parse_plot_meta(Path(sys.argv[3]).read_text())
        except Exception:
            plot_meta = {}

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
        stat = analyze_1d(name, obj, result["distributions"], plot_meta.get(name))
        if stat is not None:
            plot_pull(name, obj, out_dir)
            plot_fit(name, obj, out_dir)
        if "hdata" in obj:
            result["waves"][name] = wave_fractions(obj)

    # Summarize the worst distributions.
    dists = result["distributions"]
    ranked = sorted(dists.items(), key=lambda kv: -(kv[1]["max_abs_pull"] if kv[1]["max_abs_pull"] is not None else 0))
    result["worst_distributions"] = [
        {"name": n, "max_abs_pull": s["max_abs_pull"], "chi2_ndf": s["chi2_ndf"], "bins_over_5sigma": s["bins_over_5sigma"],
         "meta": s.get("meta")}
        for n, s in ranked[:6]
    ]

    (out_dir / "evaluate.json").write_text(json.dumps(result, indent=1, ensure_ascii=False))
    print(f"[auto_pwa_evaluate] wrote {out_dir / 'evaluate.json'} + PNGs "
          f"({len(result['distributions'])} 1d dists, {len(result['waves'])} wave sets)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# ---------------------------------------------------------------------------
# Plot 段解析（新 expr/expression 格式 + 旧 mass/cosbeta 格式）→ 分布元信息
# ---------------------------------------------------------------------------

def parse_plot_meta(config_text: str) -> dict[str, dict]:
    """Map distribution directory names to {kind, particles, intermediate,
    display} metadata. Understands both config formats:

      new:  Plot: [ {expr: "M([Kp,Km])" | ["M(...)", "CosAngle(...)"],
                     name?: "m_kk", display?: [...]} ]
      old:  Plot: { mass: [{input: [p1, p2], display: [...]}],
                    cosbeta: [{input: [[mother], [d1, d2], [axis]], ...}] }

    Intermediate matching: the plotted particle set is compared against the
    decay-chain steps' daughter sets (set equality).
    """
    import yaml

    class _ListKeyLoader(yaml.SafeLoader):
        """Tolerate non-standard configs where a YAML list/mapping is used as
        a mapping key (ctpwa yaml-cpp accepts them; e.g. Constraints.trans
        `- [chain2, chain3]: [[-1, -1]]` and `- [J: 1, P: -1]: [names]`)."""

    def _mapping(loader, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            try:
                hash(key)
            except TypeError:
                key = tuple(key) if isinstance(key, list) else repr(key)
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    _ListKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _mapping)

    meta: dict[str, dict] = {}
    try:
        doc = yaml.load(config_text, Loader=_ListKeyLoader) or {}
    except Exception:
        return meta

    # chain steps: {intermediate: [d1, d2]}
    steps: dict[str, list[str]] = {}
    particles = set((doc.get("Particles") or {}).keys())
    for chain in (doc.get("DecayChains") or {}).values():
        for step in chain.get("decay") or []:
            if isinstance(step, dict):
                for mother, daughters in step.items():
                    if isinstance(daughters, list) and len(daughters) >= 2:
                        if all(isinstance(x, str) and x in particles for x in daughters):
                            steps[mother] = [str(x) for x in daughters]

    plot = doc.get("Plot")

    def match_intermediate(plist: list[str]) -> str | None:
        want = set(plist)
        for int_name, ds in steps.items():
            if set(ds) == want:
                return int_name
        return None

    def kind_of(expr: str, fallback: str) -> str:
        up = expr.upper()
        if up.startswith("M(") or up.startswith("MASS"):
            return "mass"
        if "COSANGLE" in up or "COS_ANGLE" in up:
            return "cosbeta"
        if up.startswith("ANGLE"):
            return "angle"
        return fallback

    def names_in(expr: str) -> list[str]:
        return re.findall(r"([A-Za-z_][A-Za-z0-9_+~-]*)", expr)

    # ---- new format: Plot is a sequence of expr items (or {expr: [...]}) ----
    if isinstance(plot, list):
        seq = plot
    elif isinstance(plot, dict):
        seq = plot.get("expr") or plot.get("expression")
    else:
        return meta
    if isinstance(seq, list):
        for i, item in enumerate(seq):
            if not isinstance(item, dict):
                continue
            expr_node = item.get("expr", item.get("expression"))
            exprs: list[str] = []
            if isinstance(expr_node, str):
                exprs = [expr_node]
            elif isinstance(expr_node, list):
                exprs = [str(e) for e in expr_node]
            if not exprs:
                continue
            dname = str(item.get("name") or f"obs{i}")
            plist = names_in(exprs[0])
            # drop function name / non-particle tokens like M, CosAngle
            plist = [p for p in plist if p not in ("M", "CosAngle", "Angle", "COSANGLE", "MASS")]
            display = item.get("display")
            meta[dname] = {
                # 2D plots (two expressions, e.g. M × CosAngle) are marked "2d".
                "kind": "2d" if len(exprs) > 1 else kind_of(exprs[0], "custom"),
                "particles": plist,
                "intermediate": match_intermediate(plist),
                "display": [str(x) for x in display] if isinstance(display, list) else [],
                "expr": exprs,
            }
        return meta

    # ---- old format: { mass: [...], cosbeta: [...] } ----
    if not isinstance(plot, dict):
        return meta
    m_count = a_count = 0
    for section, kind in (("mass", "mass"), ("cosbeta", "cosbeta")):
        items = plot.get(section)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            inp = item.get("input")
            plist: list[str] = []
            if isinstance(inp, list):
                if section == "mass":
                    plist = [str(x) for x in inp if isinstance(x, str)]
                    dname = f"mass{m_count}"
                    for p in plist:
                        dname += f"_{p}"
                    m_count += 1
                else:
                    # cosbeta: [[mother], [d1, d2], [axis]]
                    if len(inp) >= 2 and isinstance(inp[1], list):
                        plist = [str(x) for x in inp[1] if isinstance(x, str)]
                    dname = f"cosbeta{a_count}"
                    for pvec in inp:
                        if isinstance(pvec, list):
                            dname += "_" + "".join(str(x) for x in pvec)
                    a_count += 1
            display = item.get("display")
            meta[dname] = {
                "kind": kind,
                "particles": plist,
                "intermediate": match_intermediate(plist),
                "display": [str(x) for x in display] if isinstance(display, list) else [],
            }
    return meta
