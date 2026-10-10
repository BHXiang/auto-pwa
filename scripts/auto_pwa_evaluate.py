#!/usr/bin/env python3
"""
auto_pwa_evaluate: turn a fit's weight_best.root into an AI-readable evaluation
package — the same information a physicist reads off the plots, quantified.

    python scripts/auto_pwa_evaluate.py <weight_best.root> <out_dir>

Outputs:
  out_dir/evaluate.json   numeric diagnostics (the AI's primary channel)
  out_dir/pull_<name>.png pull distributions per 1D plot (residual data-(fit+bkg))
  out_dir/fit_<name>.png  data vs (fit+bkg) vs background overlay

Diagnostics per 1D distribution (mass/cosbeta):
  - model per bin = hfit + hbkg  (hbkg absent/zero -> model = hfit)
  - pull per bin: (N_data - model) / sqrt(model)   [Pearson; matches ctpwa
    example/plot.py, i.e. the residual is data-(fit+bkg), NOT data-fit]
  - chi2 = sum (N_data - model)^2 / model over bins with model > 0,
    ndf = nbins-1, chi2/ndf
  - Poisson deviance (likelihood-ratio / G-test), the low-count complement to
    Pearson chi2: dev = 2 * sum [model - N + N * ln(N / model)] over bins with
    model > 0 (N = 0 -> 2*model), also per ndf. Because it is a log-likelihood
    ratio it behaves better than chi2 when many bins have a handful of events,
    and `poisson_deviance_top_bins` localizes where the mismatch sits.
  - max |pull| and bins exceeding 3sigma/5sigma (the "where it is wrong" answer)
  - per-wave fractions: integral of each h_* vs hfit (which waves matter)
Requires the ctpwa env:  <ctpwa env>/bin/python scripts/auto_pwa_evaluate.py ...

NOTE on the background: ctpwa writes hfit = signal-only model and hbkg = the
background template separately (Analysis.cu), so the physics residual against
the data is data - (hfit + hbkg). When the config has no background, hbkg is
absent and this reduces to data - hfit.
"""
from __future__ import annotations

import json
import math
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


def pull_bins(data: np.ndarray, fit: np.ndarray,
              bkg: np.ndarray | None = None) -> np.ndarray:
    """(data - model)/sqrt(model), model = fit (+ bkg when given).

    The fitted model for bin i is hfit + hbkg (Pearson residual against the
    Poisson mean); bins with model <= 0 contribute 0. Without background this
    is the historical data-fit case.
    """
    data = np.asarray(data, dtype=float)
    model = np.asarray(fit, dtype=float)
    if bkg is not None:
        model = model + np.asarray(bkg, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        pull = np.where(model > 0, (data - model) / np.sqrt(np.where(model > 0, model, 1.0)), 0.0)
    return np.asarray(pull, dtype=float)


def chi2_bins(data: np.ndarray, fit: np.ndarray,
              bkg: np.ndarray | None = None) -> float:
    """Pearson chi2 = sum (data - model)^2 / model over bins with model > 0."""
    data = np.asarray(data, dtype=float)
    model = np.asarray(fit, dtype=float)
    if bkg is not None:
        model = model + np.asarray(bkg, dtype=float)
    mask = model > 0
    if not np.any(mask):
        return float("nan")
    return float(np.sum((data[mask] - model[mask]) ** 2 / model[mask]))


def poisson_deviance_bins(data: np.ndarray, fit: np.ndarray,
                          bkg: np.ndarray | None = None) -> np.ndarray:
    """Per-bin Poisson deviance (likelihood-ratio / G-test) 2*log(L_ratio).

    Model per bin = hfit + hbkg (same convention as `pull_bins` / `chi2_bins`;
    hbkg absent => model = fit). For model > 0:

        data > 0 : dev_i = 2 * (model - data + data * ln(data / model))
        data == 0: dev_i = 2 * model            (the N*ln(N/model) -> 0 limit)
        model <= 0: dev_i = 0.0                 (not evaluable; caller counts)

    Negative data counts never occur for a real histogram; should one appear it
    falls back to the data == 0 branch. Unlike Pearson chi2 the deviance is a
    sum of log-likelihood ratios, so it stays well behaved in the low-count
    bins where chi2/ndf is inflated by small model values. Bins follow the same
    convention as the rest of the module (`hist_to_arrays` -> TH1.values(),
    i.e. no under/overflow bins).
    """
    data = np.asarray(data, dtype=float)
    model = np.asarray(fit, dtype=float)
    if bkg is not None:
        model = model + np.asarray(bkg, dtype=float)
    dev = np.zeros(model.shape, dtype=float)
    mask = model > 0
    if not np.any(mask):
        return dev
    m = model[mask]
    n = data[mask]
    out = np.empty_like(m)
    positive = n > 0
    out[~positive] = 2.0 * m[~positive]
    with np.errstate(divide="ignore", invalid="ignore"):
        out[positive] = 2.0 * (m[positive] - n[positive]
                               + n[positive] * np.log(n[positive] / m[positive]))
    dev[mask] = out
    return dev


def rank_worst(dists: dict, top: int = 6) -> list[dict]:
    """Top-`top` 1D distributions by max|pull|.

    2D-moments records carry no `max_abs_pull` (they are not binned pulls) and
    are filtered out — indexing them blindly KeyError-ed the whole evaluation
    on any config with a 2D Plot entry.
    """
    ranked = sorted(
        ((n, s) for n, s in dists.items() if isinstance(s.get("max_abs_pull"), (int, float))),
        key=lambda kv: -kv[1]["max_abs_pull"],
    )
    return [
        {"name": n, "max_abs_pull": s["max_abs_pull"], "chi2_ndf": s.get("chi2_ndf"),
         "bins_over_5sigma": s.get("bins_over_5sigma", 0), "meta": s.get("meta")}
        for n, s in ranked[:top]
    ]


def poisson_deviance_total(dists: dict) -> dict | None:
    """Sum the per-bin Poisson deviance over all 1D distributions.

    Complements `rank_worst`: the per-distribution numbers say *where* the
    shape is off, the total says *how much* overall (deviance/ndf over all
    bins). 2D-moments records carry no `poisson_deviance` and are skipped;
    returns None when no distribution contributed.
    """
    dev = 0.0
    ndf = 0
    n = 0
    for s in dists.values():
        d = s.get("poisson_deviance")
        if not isinstance(d, (int, float)):
            continue
        dev += float(d)
        ndf += int(s.get("ndf") or 0)
        n += 1
    if n == 0 or ndf <= 0:
        return None
    return {
        "poisson_deviance": round(dev, 1),
        "ndf": ndf,
        "poisson_deviance_ndf": round(dev / ndf, 3),
        "n_distributions": n,
    }


def hist_to_arrays(h) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(centers, contents, errors) from a TH1-like uproot object."""
    edges = h.axis().edges()
    centers = (edges[:-1] + edges[1:]) / 2
    contents = np.asarray(h.values(), dtype=float)
    errors = np.asarray(h.errors(), dtype=float)
    return centers, contents, errors


def legendre_moments(centers: np.ndarray, values: np.ndarray,
                    max_l: int = 6) -> dict:
    """Normalized Legendre moments M_L/M_0 of an angular distribution.

    x = cos(theta) in [-1, 1]. For a spin-0 daughter pair (e.g. KK) the
    angular distribution requires J >= L/2 for M_L to be nonzero, so a
    data-vs-fit mismatch in M_L signals a missing/extra wave of that J.
    Returns {L: M_L/M_0} for even L in 2..max_l."""
    x = np.asarray(centers, dtype=float)
    w = np.asarray(values, dtype=float)
    m0 = float(np.sum(w))
    if m0 <= 0 or len(x) < 3:
        return {}
    out: dict = {}
    for L in range(2, max_l + 1, 2):
        P = np.polynomial.legendre.legval(x, np.eye(L + 1)[L])
        out[L] = round(float(np.sum(w * P) / m0), 4)
    return out


def analyze_2d_moments(prefix: str, d: uproot.ReadOnlyDirectory,
                       meta: dict | None = None) -> dict | None:
    """Mass-binned Legendre moments from a TH2 (mass x cosbeta) histogram.

    The 2D Plot configs (e.g. expr: ["M([Kp,Km])", "CosAngle([Kp],[Kp,Km])"])
    write hdata/hfit as TH2; every mass bin's cosbeta projection yields the
    moment sequence M_L(m) — the "which L is missing at which mass" signal.
    """
    hdata = d["hdata"]
    if not isinstance(hdata, uproot.behaviors.TH2.TH2) or "hfit" not in d:
        return None
    hfit = d["hfit"]
    if not isinstance(hfit, uproot.behaviors.TH2.TH2):
        return None
    data2 = np.asarray(hdata.values(), dtype=float)
    fit2 = np.asarray(hfit.values(), dtype=float)
    x_edges = np.asarray(hdata.axis(0).edges())
    y_edges = np.asarray(hdata.axis(1).edges())
    x_centers = (x_edges[:-1] + x_edges[1:]) / 2
    y_centers = (y_edges[:-1] + y_edges[1:]) / 2
    Ls = (2, 4, 6)
    moments: dict = {L: {"data": [], "fit": []} for L in Ls}
    for ix in range(data2.shape[0]):
        drow, frow = data2[ix], fit2[ix]
        dm = legendre_moments(y_centers, drow, max_l=6)
        fm = legendre_moments(y_centers, frow, max_l=6)
        for L in Ls:
            moments[L]["data"].append(dm.get(L))
            moments[L]["fit"].append(fm.get(L))
    return {
        "kind": "2d-moments",
        "massBins": [round(float(x), 4) for x in x_centers],
        "moments": moments,
        "meta": meta,
    }


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
    bkg = np.asarray(d["hbkg"].values(), dtype=float) if "hbkg" in d else None
    # Physics model = signal fit + background template (data-(fit+bkg)).
    model = fit + bkg if bkg is not None else fit
    pull = pull_bins(data, fit, bkg)
    chi2 = chi2_bins(data, fit, bkg)
    # Poisson deviance (likelihood-ratio) alongside Pearson chi2: same model
    # and same bins, but the better "how unlike is this shape" measure in the
    # low-count regime. ndf is the same nbins-1 (zero-model bins included).
    dev = poisson_deviance_bins(data, fit, bkg)
    has_model = bool(np.any(model > 0))
    dev_total = float(np.sum(dev))
    dev_zero_model = int(np.count_nonzero(model <= 0))
    dev_top = None
    if dev.size:
        order = np.argsort(-dev)[:3]
        dev_top = [
            {"center": round(float(centers[int(i)]), 3),
             "deviance": round(float(dev[int(i)]), 2),
             "data": round(float(data[int(i)]), 3),
             "model": round(float(model[int(i)]), 3)}
            for i in order
        ]
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
    # Angular distributions (cosbeta/angle): normalized Legendre moments.
    is_angular = (meta or {}).get("kind") in ("cosbeta", "angle") or "cosbeta" in prefix.lower() or "angle" in prefix.lower()
    moments: dict = {}
    if is_angular:
        moments = legendre_moments(centers, data)
        fit_moments = legendre_moments(centers, model)
        for L in list(moments):
            moments[L] = {
                "data": moments[L],
                "fit": fit_moments.get(L),
                "delta": round(moments[L] - fit_moments.get(L, moments[L]), 4),
            }
    stat = {
        "chi2": (round(chi2, 1) if math.isfinite(chi2) else None),
        "ndf": ndf,
        "chi2_ndf": (round(chi2 / ndf, 3) if (ndf > 0 and math.isfinite(chi2)) else None),
        "poisson_deviance": (round(dev_total, 1) if has_model else None),
        "poisson_deviance_ndf": (round(dev_total / ndf, 3) if (ndf > 0 and has_model) else None),
        "poisson_deviance_top_bins": dev_top,
        "poisson_deviance_zero_model_bins": dev_zero_model,
        "has_background": bkg is not None,
        "residual": "data-(fit+bkg)" if bkg is not None else "data-fit",
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
        **({"moments": moments} if moments else {}),
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
    bkg = np.asarray(d["hbkg"].values(), dtype=float) if "hbkg" in d else None
    pull = pull_bins(data, fit, bkg)
    plt = _plt()
    fig, ax = plt.subplots(figsize=(7, 3))
    ax.bar(centers, pull, width=centers[1] - centers[0], color="#1a6e5c", alpha=0.75)
    ax.axhline(0, color="k", lw=0.8)
    for s, c in ((3, "#a05a12"), (5, "#a03028")):
        ax.axhline(s, color=c, ls="--", lw=0.8)
        ax.axhline(-s, color=c, ls="--", lw=0.8)
    ax.set_title(f"pull: {prefix}")
    ax.set_xlabel("x")
    ax.set_ylabel("(data-(fit+bkg))/sqrt(fit+bkg)" if bkg is not None else "(data-fit)/sqrt(fit)")
    ax.set_ylim(-8, 8)
    fig.tight_layout()
    fig.savefig(out_dir / f"pull_{prefix}.png", dpi=110)
    plt.close(fig)


def plot_fit(prefix: str, d: uproot.ReadOnlyDirectory, out_dir: Path) -> None:
    centers, data, derr = hist_to_arrays(d["hdata"])
    _, fit, _ = hist_to_arrays(d["hfit"])
    has_bkg = "hbkg" in d
    bkg = np.asarray(d["hbkg"].values(), dtype=float) if has_bkg else None
    model = fit + bkg if bkg is not None else fit
    plt = _plt()
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.errorbar(centers, data, yerr=derr, fmt="o", ms=3, lw=1, color="#1c1c1a", label="data")
    ax.plot(centers, model, "-", color="#1a6e5c", lw=1.5,
            label="fit+bkg" if has_bkg else "fit")
    if bkg is not None:
        ax.plot(centers, bkg, "--", color="#a05a12", lw=1.2, label="bkg")
        ax.plot(centers, fit, ":", color="#1a6e5c", lw=1.2, label="fit (signal)")
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
            "residual: 每个 bin 的物理模型 = hfit + hbkg（无 hbkg 时 = hfit）；"
            "pull = (data-(fit+bkg))/sqrt(fit+bkg)（Pearson，与 ctpwa example/plot.py 一致）",
            "chi2_ndf: 全局拟合质量（≈1 理想；>2 明显偏差）",
            "poisson_deviance_ndf: 泊松偏差（似然比 / G-test）版的全局质量，低计数 bin 比 "
            "chi2 更可靠（≈1 理想；它比 chi2 更集中地惩罚形状差异）",
            "poisson_deviance_top_bins: 贡献最大的最多 3 个 bin（center/deviance/data/model）；"
            "看偏差是集中在一个区域还是各处摊开",
            "poisson_deviance_zero_model_bins: model<=0 无法评估而贡献记 0 的 bin 数（仍计入 ndf）",
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
        if stat is None:
            m2 = analyze_2d_moments(name, obj, plot_meta.get(name))
            if m2 is not None:
                result["distributions"][name] = m2
                stat = m2
        if stat is not None and "moments" not in stat:
            plot_pull(name, obj, out_dir)
            plot_fit(name, obj, out_dir)
        if "hdata" in obj:
            result["waves"][name] = wave_fractions(obj)

    # Summarize the worst 1D distributions (2D-moments records have no pull).
    result["worst_distributions"] = rank_worst(result["distributions"])
    # 所有 1D 分布的泊松偏差合计（rank_worst 说"哪里偏"，合计说"总体偏多少"）。
    result["poisson_deviance_total"] = poisson_deviance_total(result["distributions"])

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
