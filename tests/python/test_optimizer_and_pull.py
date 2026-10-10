#!/usr/bin/env python3
"""Python regression tests for the two numeric programs aifit/evaluate rely on.

Run with the ctpwa env python (needs numpy + torch; no GPU / no ctpwa needed):

    <ctpwa env>/bin/python tests/python/test_optimizer_and_pull.py

or with pytest:

    <ctpwa env>/bin/python -m pytest tests/python/test_optimizer_and_pull.py

Covers the fixes that are easy to silently regress:
  1. auto_pwa_evaluate.pull_bins / chi2_bins — the residual MUST be
     data-(fit+bkg) (Pearson), not data-fit / sqrt(data).
  2. pwa_optimizer reparam round-trip (the soft-wall bijection is exact).
  3. The vendored optimizer + polish actually converge on a closed-form
     quadratic NLL (CPU smoke test of the GPU code path).
  4. aifit.build_best_json JSON shape (boundary flags, NaN -> null via _json_safe).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import torch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


ev = _load("auto_pwa_evaluate", "auto_pwa_evaluate.py")
import pwa_optimizer as po  # noqa: E402

# aifit imports ctpwa lazily (inside functions), so importing it is safe.
import aifit  # noqa: E402


# ---------------------------------------------------------------------------
# 1. pull / chi2 residual definition
# ---------------------------------------------------------------------------
def test_pull_without_background_is_data_minus_fit():
    data = np.array([10.0, 20.0, 0.0])
    fit = np.array([8.0, 18.0, 1.0])
    expected = np.array([(10 - 8) / np.sqrt(8), (20 - 18) / np.sqrt(18), (0 - 1) / np.sqrt(1)])
    assert np.allclose(ev.pull_bins(data, fit), expected)


def test_pull_with_background_is_data_minus_fit_plus_bkg():
    data = np.array([10.0, 20.0, 0.0, 5.0])
    fit = np.array([8.0, 18.0, 1.0, 5.0])
    bkg = np.array([1.0, 1.0, 1.0, 0.0])
    total = fit + bkg
    expected = np.where(total > 0, (data - total) / np.sqrt(np.where(total > 0, total, 1.0)), 0.0)
    assert np.allclose(ev.pull_bins(data, fit, bkg), expected)
    # explicitly NOT the old data-fit residual
    assert not np.allclose(ev.pull_bins(data, fit, bkg), ev.pull_bins(data, fit))
    # and NOT the old sqrt(data) denominator
    with np.errstate(divide="ignore", invalid="ignore"):
        old_style = (data - fit) / np.sqrt(data)
    assert not np.allclose(ev.pull_bins(data, fit), old_style, equal_nan=True)


def test_chi2_bins_matches_pearson_sum():
    data = np.array([10.0, 20.0, 0.0, 5.0])
    fit = np.array([8.0, 18.0, 1.0, 5.0])
    bkg = np.array([1.0, 1.0, 1.0, 0.0])
    total = fit + bkg
    assert abs(ev.chi2_bins(data, fit, bkg) - float(np.sum((data - total) ** 2 / total))) < 1e-12
    assert abs(ev.chi2_bins(data, fit) - float(np.sum((data - fit) ** 2 / fit))) < 1e-12


def test_rank_worst_skips_2d_moments_records():
    # A 2D-moments record has no max_abs_pull; it must not crash the ranking.
    dists = {
        "mass0_Kp_Km": {"max_abs_pull": 4.8, "chi2_ndf": 2.1, "bins_over_5sigma": 0},
        "dalitz0": {"kind": "2d-moments", "massBins": [1.0], "moments": {}},
        "cosbeta0": {"max_abs_pull": 5.4, "chi2_ndf": 1.2, "bins_over_5sigma": 1},
    }
    worst = ev.rank_worst(dists)
    assert [w["name"] for w in worst] == ["cosbeta0", "mass0_Kp_Km"]
    assert all(isinstance(w["max_abs_pull"], float) for w in worst)


# ---------------------------------------------------------------------------
# 2. reparam soft-wall bijection
# ---------------------------------------------------------------------------
def test_reparam_roundtrip():
    nc, nres = 3, 2
    lower = torch.tensor([1.0, 0.1], dtype=torch.float64)
    upper = torch.tensor([2.0, 0.5], dtype=torch.float64)
    phys = torch.tensor([1.0, 0.3, -0.2, 0.0, 0.25, 0.4, 1.5, 0.3], dtype=torch.float64)
    u = po._reparam_pack(phys, nc, nres, lower, upper, 1000.0)
    back = po._reparam_unpack(u, nc, nres, lower, upper, 1000.0)
    assert float((back - phys).abs().max()) < 1e-9


def test_reparam_unpack_stays_inside_bounds():
    lower = torch.tensor([1.0], dtype=torch.float64)
    upper = torch.tensor([2.0], dtype=torch.float64)
    u = torch.tensor([1.0, 0.0, 0.0, 100.0], dtype=torch.float64)  # huge resonance u
    p = po._reparam_unpack(u, 2, 1, lower, upper, 1000.0)
    assert 1.0 < float(p[4]) < 2.0


# ---------------------------------------------------------------------------
# 3. vendored optimizer + polish (CPU quadratic)
# ---------------------------------------------------------------------------
_TARGET = torch.tensor([1.0, 0.4, 0.0, -0.3, 1.5], dtype=torch.float64)


class _QuadraticAna:
    """NLL = |p - target|^2; Hessian = 2I. Enough to exercise the full path."""

    def getNLL(self, p):
        d = p - _TARGET
        return (d * d).sum()

    def getHessian(self, p):
        return torch.eye(5, dtype=torch.float64) * 2.0

    def getFitFractions(self, c, h=None):
        return torch.tensor([[1.0, 0.0]], dtype=torch.float64)

    def getAmplitudeNames(self):
        return ["w0"]

    def getNVector(self):
        return 2


def _cpu_optimizer():
    """UnifiedPWAOptimizer is GPU-only by construction; build a CPU twin for CI."""
    fri = torch.tensor([[1.2], [1.0], [2.0]], dtype=torch.float64)
    o = object.__new__(po.UnifiedPWAOptimizer)
    o.analysis = _QuadraticAna()
    o.params_names = ["c0", "c1", "m0"]
    o.device = "cpu"
    o.best_nll = float("inf")
    o.best_params = None
    o.all_results = []
    o.n_coupling_free = 2
    o.n_res_free = 1
    o.n_params = 5
    o.has_free_res = True
    o._free_res_info = fri
    o.v_max = 10000.0
    o.project_grad = True
    o.amp_max = 1000.0
    o.amp_lambda = 1e-4
    o.optimizer_kind = "reparam"
    o.optimizer_verbose = False
    o.optimizer_prof = False
    o.optimizer_m = 50
    o.optimizer_twoloop = "batched"
    o.optimizer_honest = True
    o.optimizer_legacy_sign = False
    o.optimizer_polish_steps = 50
    o._polish_stats = {}
    o._hess_cache = None
    o._lower = fri[1]
    o._upper = fri[2]
    return o


def test_vendored_optimizer_converges_and_polishes():
    opt = _cpu_optimizer()
    r = opt.optimize_single_run(opt.generate_initial_params(seed=42), run_id=0, max_iter=500)
    assert r["final_nll"] < 1e-4, r["final_nll"]
    assert torch.allclose(r["final_params"], _TARGET, atol=1e-2)
    p2, nll2, pd2 = opt.polish_damped_newton(r["final_params"], max_steps=50)
    assert nll2 <= r["final_nll"] + 1e-9
    assert pd2 is True
    errs = opt.compute_param_errors(p2)
    assert all(e is not None for e in errs)
    assert float(errs[2][0]) > 0  # resonance mass has a statistical error


# ---------------------------------------------------------------------------
# 4. aifit JSON assembly
# ---------------------------------------------------------------------------
class _FakeOpt:
    n_coupling_free = 2
    n_res_free = 2
    has_free_res = True
    device = "cpu"
    n_params = 6
    params_names = ["c0", "c1", "m_a", "m_b"]
    _lower = torch.tensor([1.0, 0.1], dtype=torch.float64)
    _upper = torch.tensor([2.0, 0.5], dtype=torch.float64)

    class _A:
        @staticmethod
        def getAmplitudeNames():
            return ["w0", "w1"]

        @staticmethod
        def getFitFractions(c, h=None):
            return torch.tensor([[0.6, 0.02], [0.4, 0.02]], dtype=torch.float64)

    analysis = _A()

    def extract_coupling_complex(self, p):
        return torch.complex(p[:2].float(), p[2:4].float())

    def extract_theta_phys(self, p):
        return p[4:]

    def _get_hessian_cached(self, p):
        return torch.eye(6, dtype=torch.float64) * 4


def test_build_best_json_flags_boundary_and_strips_nan():
    p = torch.tensor([1.0, 0.4, 0.0, -0.2, 1.5, 0.5], dtype=torch.float64)
    result = {"run_id": 0, "final_nll": -12.5, "is_positive_definite": True,
              "min_eigenvalue": 4.0, "condition_number": 1.0, "optimizer_status": "reparam-tol-stop"}
    errs = (torch.tensor([float("nan"), 0.1]), torch.tensor([float("nan"), 0.2]),
            torch.tensor([float("nan"), 0.05]))
    warns: list[str] = []
    red = aifit._reduced_hessian(_FakeOpt(), p)
    corr = aifit._correlation_from_hessian(_FakeOpt(), red, True)
    best = aifit.build_best_json(_FakeOpt(), p, result, errs, corr, warns)
    assert best["optimizerStatus"] == "reparam-tol-stop"
    assert best["fitFractions"][0]["fraction"] == 0.6
    assert corr is not None and corr["names"] == ["Re(c1)", "Im(c1)", "m_a", "m_b"]
    m_b = next(x for x in best["params"] if x["name"] == "m_b")
    assert m_b["atBoundary"] is True
    assert any("贴住 free_range" in w for w in warns)
    # strict JSON: _json_safe must drop every NaN/Inf
    assert "NaN" not in json.dumps(aifit._json_safe(best))


def _main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_main())
