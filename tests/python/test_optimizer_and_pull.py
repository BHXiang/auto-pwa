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
# 3b. parameter errors must use the grouped [Re.., Im.., θ] layout
# ---------------------------------------------------------------------------
class _DiagAna:
    """NLL = ½·pᵀHp for a diagonal H (so grad = H·p and the Hessian is exact)."""

    def __init__(self, diag):
        self.H = torch.diag(torch.tensor(diag, dtype=torch.float64))

    def getNLL(self, p):
        return 0.5 * (p * (self.H @ p)).sum()

    def getHessian(self, p):
        return self.H.clone()

    def getFitFractions(self, c, h=None):
        return torch.tensor([[1.0, 0.0]], dtype=torch.float64)

    def getAmplitudeNames(self):
        return ["w0"]


def _diag_optimizer(nc, nres, diag):
    """CPU optimizer over a quadratic with the given diagonal Hessian."""
    n_params = 2 * nc + nres
    assert len(diag) == n_params
    fri = torch.tensor([[1.5] * nres, [1.0] * nres, [2.0] * nres], dtype=torch.float64)
    o = object.__new__(po.UnifiedPWAOptimizer)
    o.analysis = _DiagAna(diag)
    o.params_names = [f"c{i}" for i in range(nc)] + [f"m{i}" for i in range(nres)]
    o.device = "cpu"
    o.best_nll = float("inf")
    o.best_params = None
    o.all_results = []
    o.n_coupling_free = nc
    o.n_res_free = nres
    o.n_params = n_params
    o.has_free_res = nres > 0
    o._free_res_info = fri
    o.v_max = 10000.0
    o.project_grad = True
    o.amp_max = 1000.0
    o.amp_lambda = 1e-4
    o.optimizer_kind = "reparam"
    o._polish_stats = {}
    o._hess_cache = None
    if nres > 0:
        o._lower = fri[1]
        o._upper = fri[2]
    return o


def test_param_errors_use_grouped_layout_not_interleaved():
    """getHessian/params are [Re_0.., Im_0.., θ] — NOT [Re_0, Im_0, Re_1, Im_1, ...].

    A diagonal Hessian with a distinct scale per coordinate makes the two
    conventions differ from nc=3 on. (With nc=2 there is only one free coupling,
    so n_c_var=1 and both give the same answer — which is why the older smoke
    test never caught the misalignment.)
    """
    # nc=3, nres=1 -> n_params=7, fixed indices 0 (Re_0) and 3 (Im_0).
    opt = _diag_optimizer(3, 1, [1.0, 1.0, 2.0, 1.0, 3.0, 4.0, 5.0])
    p = torch.zeros(7, dtype=torch.float64)     # grad = H·p = 0 -> no active set
    cre, cim, res = opt.compute_param_errors(p)
    # free order after dropping 0 and 3 is Re1, Re2, Im1, Im2, θ -> H = 1,2,3,4,5
    sd = 1.0 / np.sqrt([1.0, 2.0, 3.0, 4.0, 5.0])
    assert abs(float(cre[1]) - sd[0]) < 1e-6, (float(cre[1]), sd[0])
    assert abs(float(cre[2]) - sd[1]) < 1e-6, (float(cre[2]), sd[1])   # grouped
    assert abs(float(cim[1]) - sd[2]) < 1e-6, (float(cim[1]), sd[2])   # grouped
    assert abs(float(cim[2]) - sd[3]) < 1e-6, (float(cim[2]), sd[3])
    assert abs(float(res[0]) - sd[4]) < 1e-6, (float(res[0]), sd[4])
    # the interleaved convention would report Im(c1) at sd[1] — make sure we did not
    assert abs(float(cim[1]) - sd[1]) > 1e-3
    # fixed reference stays 0 (not an error estimate)
    assert float(cre[0]) == 0.0 and float(cim[0]) == 0.0


# ---------------------------------------------------------------------------
# 4. aifit JSON assembly
# ---------------------------------------------------------------------------
class _FakeOpt:
    n_coupling_free = 2
    n_res_free = 2
    has_free_res = True
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
    v_max = 10000.0

    def extract_coupling_complex(self, p):
        return torch.complex(p[:2].float(), p[2:4].float())

    def extract_theta_phys(self, p):
        return p[4:]

    def _get_hessian_cached(self, p):
        return torch.eye(6, dtype=torch.float64) * 4


class _FakeReport:
    """Stand-in for ctpwa.diagnostics.HessianSubspaceReport."""

    ev_free = torch.tensor([-1.0, 2.0])
    ev_reduced = torch.tensor([0.5, 2.0])
    reduced_min_eigenvalue = 0.5
    reduced_max_eigenvalue = 2.0
    free_min_eigenvalue = -1.0
    free_max_eigenvalue = 2.0
    reduced_pd = True
    free_pd = False
    active_idx = torch.tensor([3])
    kkt_max = 0.02
    kkt_ok = True

    @property
    def n_active(self):
        return int(self.active_idx.numel())


def test_hessian_fields_report_feasible_subspace_criterion():
    """positiveDefinite = reduced (KKT) subspace; positiveDefiniteFull = old test."""
    f = aifit.hessian_fields(_FakeOpt(), _FakeReport())
    assert f["positiveDefinite"] is True
    assert f["positiveDefiniteFull"] is False
    assert f["minEigenvalue"] == 0.5 and f["fullMinEigenvalue"] == -1.0
    assert abs(f["conditionNumber"] - 4.0) < 1e-12
    assert f["nActive"] == 1
    assert f["activeParams"] == ["Im(c1)"]
    assert f["nNegativeReduced"] == 0 and f["nNegativeFull"] == 1
    assert f["kktGradMax"] == 0.02 and f["kktOk"] is True


def test_boundary_diagnostics_flags_near_edge_resonance():
    p = torch.tensor([1.0, 0.4, 0.0, -0.2, 1.5, 0.495], dtype=torch.float64)
    grad = torch.zeros(6, dtype=torch.float64)
    grad[5] = -7.0
    out = aifit.boundary_diagnostics(_FakeOpt(), p, grad, 0.02)
    assert [d["param"] for d in out] == ["m_b"]      # m_a sits mid-range
    assert abs(out[0]["margin"] - (0.5 - 0.495) / 0.4) < 1e-12
    assert out[0]["gradNll"] == 7.0
    # a 2% margin must not flag the mid-range parameter, a wider one must
    assert aifit.boundary_diagnostics(_FakeOpt(), p, grad, 0.9) != out


def test_correlation_uses_the_feasible_subspace_only():
    """With an active parameter the matrix must shrink to the reduced subspace."""
    opt = _FakeOpt()
    h = torch.eye(6, dtype=torch.float64) * 4
    full = aifit._correlation_from_hessian(opt, h)
    assert full["names"] == ["Re(c1)", "Im(c1)", "m_a", "m_b"]
    reduced = aifit._correlation_from_hessian(opt, h, torch.tensor([1, 3, 5]))
    assert reduced["names"] == ["Re(c1)", "Im(c1)", "m_b"]
    assert len(reduced["matrix"]) == 3
    # reordered idx must reorder names consistently
    swapped = aifit._correlation_from_hessian(opt, h, torch.tensor([5, 1]))
    assert swapped["names"] == ["m_b", "Re(c1)"]


def test_build_best_json_flags_boundary_and_strips_nan():
    p = torch.tensor([1.0, 0.4, 0.0, -0.2, 1.5, 0.5], dtype=torch.float64)
    result = {"run_id": 0, "final_nll": -12.5, "is_positive_definite": True,
              "min_eigenvalue": 4.0, "condition_number": 1.0, "optimizer_status": "reparam-tol-stop"}
    errs = (torch.tensor([float("nan"), 0.1]), torch.tensor([float("nan"), 0.2]),
            torch.tensor([float("nan"), 0.05]))
    warns: list[str] = []
    corr = aifit._correlation_from_hessian(_FakeOpt(), _FakeOpt()._get_hessian_cached(p))
    best = aifit.build_best_json(_FakeOpt(), p, result, errs, corr, warns)
    assert best["optimizerStatus"] == "reparam-tol-stop"
    assert best["fitFractions"][0]["fraction"] == 0.6
    assert corr is not None and corr["names"] == ["Re(c1)", "Im(c1)", "m_a", "m_b"]
    m_b = next(x for x in best["params"] if x["name"] == "m_b")
    assert m_b["atBoundary"] is True
    assert any("贴住 free_range" in w for w in warns)
    # legacy field names (old kernel / older fit.json) still populate the new keys
    assert best["positiveDefinite"] is True and best["minEigenvalue"] == 4.0
    assert "boundaryDiagnostics" not in best   # no boundary list passed
    # strict JSON: _json_safe must drop every NaN/Inf
    assert "NaN" not in json.dumps(aifit._json_safe(best))


def test_build_best_json_reports_unavailable_errors_and_boundary_list():
    p = torch.tensor([1.0, 0.4, 0.0, -0.2, 1.5, 0.5], dtype=torch.float64)
    result = {"run_id": 0, "final_nll": -12.5, "positiveDefinite": False,
              "positiveDefiniteFull": False, "optimizer_status": "reparam-tol-stop"}
    warns: list[str] = []
    boundary = [{"param": "m_b", "kind": "resonance", "value": 0.5, "lower": 0.1,
                 "upper": 0.5, "margin": 0.0, "gradNll": 7.0}]
    best = aifit.build_best_json(_FakeOpt(), p, result, (None, None, None), None,
                                 warns, boundary)
    assert best["positiveDefinite"] is False
    assert best["boundaryDiagnostics"][0]["param"] == "m_b"
    assert any("参数误差不可用" in w for w in warns)
    assert any("贴近边界" in w for w in warns)
    assert "NaN" not in json.dumps(aifit._json_safe(best))


def test_build_best_json_skips_fractions_on_cpu_backend():
    """getFitFractions needs CUDA tensors on a CUDA build -> skip, don't crash."""
    class _CpuOpt(_FakeOpt):
        device = "cpu"

    p = torch.tensor([1.0, 0.4, 0.0, -0.2, 1.5, 0.5], dtype=torch.float64)
    result = {"run_id": 0, "final_nll": -12.5, "positiveDefinite": True,
              "optimizer_status": "reparam-tol-stop"}
    errs = (torch.zeros(2), torch.zeros(2), torch.zeros(2))
    warns: list[str] = []
    best = aifit.build_best_json(_CpuOpt(), p, result, errs, None, warns)
    assert best["fitFractions"] is None
    assert any("cpu-backend" in w for w in warns)


def test_pinned_parameter_is_not_reported_as_indefinite():
    """A boundary-pinned direction is infeasible -> reduced_pd True, free_pd False.

    This is the whole point of ctpwa fa40d41 / example/fit.py: under the old
    full-free-block test a parameter sitting on its free_range edge made the fit
    look indefinite, which wiped out every parameter error and the correlation
    matrix. Needs ctpwa.diagnostics; skipped when it is not installed.
    """
    try:
        from ctpwa.diagnostics import analyze_hessian  # noqa: F401
    except Exception:
        print("  (skip: ctpwa.diagnostics 不可用)")
        return

    class _Ana:
        """NLL = ½·pᵀHp + bᵀp — the linear term pins m0 against its lower edge."""

        def __init__(self, diag, b):
            self.H = torch.diag(torch.tensor(diag, dtype=torch.float64))
            self.b = torch.tensor(b, dtype=torch.float64)

        def getNLL(self, p):
            return 0.5 * (p * (self.H @ p)).sum() + (self.b * p).sum()

        def getHessian(self, p):
            return self.H.clone()

    opt = _diag_optimizer(3, 1, [1.0, 1.0, 2.0, 1.0, 3.0, 4.0, -5.0])
    opt.analysis = _Ana([1.0, 1.0, 2.0, 1.0, 3.0, 4.0, -5.0], [0.0] * 6 + [20.0])
    # m0 sits exactly on its lower bound with grad > 0 -> wants to go further out
    p = torch.tensor([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0], dtype=torch.float64)
    rep, grad, _nll = aifit.hessian_report(opt, p)
    fields = aifit.hessian_fields(opt, rep)
    assert fields["positiveDefinite"] is True, fields           # KKT criterion
    assert fields["positiveDefiniteFull"] is False, fields      # legacy criterion
    assert fields["nActive"] == 1 and fields["activeParams"] == ["m0"]
    assert fields["fullMinEigenvalue"] == -5.0
    # the pinned direction is dropped from the feasible subspace, the rest still
    # has errors; the pinned parameter itself is honestly NaN (no statistical error)
    cre, cim, res = opt.compute_param_errors(p)
    assert cre is not None and np.isfinite(float(cre[1]))
    assert np.isnan(float(res[0]))
    corr = aifit._correlation_from_hessian(opt, opt._get_hessian_cached(p), rep.reduced_idx)
    assert "m0" not in corr["names"] and "Im(c2)" in corr["names"]
    # and the boundary report names the culprit with its |dNLL/dtheta|
    bnd = aifit.boundary_diagnostics(opt, p, grad, 0.02)
    assert [d["param"] for d in bnd] == ["m0"] and bnd[0]["gradNll"] == 15.0


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
