#!/usr/bin/env python3
"""aifit.py — AI-first ctpwa fit driver（JSON 诊断聚合器）.

ctpwa 契约的"包装层"实现（PLAN-STEP2 §1.3，引擎零改动）：
  1. config 校验 API（不跑 GPU）：DecayInfo(config) -> --validate-only JSON
  2. fit 完成 JSON 诊断：NLL / 参数±误差 / 撞边界 / 正定性 / 分波贡献
  3. 结构化错误码：{code, message} + 非零退出码
  5. 短拟合模式：--runs 1 --max-iter 500（多候选并行的时间基础）
  （v2：用 getSLAmpsTensor 算成对干涉项，未实现）

优化器：直接复用 scripts/pwa_optimizer.py（自 ctpwa example/fit.py vendored，MIT），
默认走 example/fit.py 的 **reparam** 重参数化软墙路径，并做二阶 polish + 活跃集
感知的参数误差。因此本驱动与 example/fit.py 数值同源，修复了旧内联优化器的
"torch LBFGS + 就地 clamp + 梯度清零"边界伪收敛、耦合无界增长、被边界钉住的参数
仍报伪误差等问题。`--optimizer projected|lbfgs` 可切到对照路径。

正定性/误差与 example/fit.py 同口径（ctpwa fa40d41）：判据是**可行子空间**上的
λmin > tau·λmax（KKT 二阶条件）——先剔除固定参考 Re_0/Im_0（Hessian 里这两行/列
恒为 0），再剔除"贴边且梯度朝外"的活跃参数（那个方向根本不可行）。旧的全自由块
`all(eig>0)` 在参数被 free_range 钉住时会把合法的约束极小误报成"不定"，进而让
参数误差与相关矩阵整块消失。fit.json 里 `positiveDefinite` = 可行子空间判据，
`positiveDefiniteFull` = 旧口径（仅供对照）；参数误差按 grouped
`[Re.., Im.., θ]` 布局映射（旧的交错取法会把 Im(c₁) 的误差安到 Re(c₂) 上）。

用法（cwd = 迭代目录，analysis() 从 cwd 读 config.yml，同 fit.py）：
  <ctpwa env>/bin/python aifit.py [--config config.yml] [--validate-only] \\
      [--runs N] [--max-iter M] [--seed S] [--json results/fit.json] \\
      [--optimizer reparam|projected|lbfgs] [--no-polish]

输出（默认 results/）：
  fit.json                本文件（机器/AI 主通道，schema 见 README）
  weight_best.root        权重文件（auto_pwa_evaluate 用）
  nll_history.txt         每 run 的 NLL 历史（人看）
  optimization_summary.txt 兼容摘要（旧工具回退通道）

环境变量默认值（被 CLI 覆盖）：PWA_AIFIT_RUNS（默认 10）、PWA_AIFIT_MAX_ITER
（默认 10000），以及 example/fit.py 同名的 FIT_* （FIT_OPTIMIZER / FIT_VMAX /
FIT_AMP_MAX / FIT_AMP_LAMBDA / FIT_POLISH / FIT_LR / FIT_TOL_GRAD /
FIT_TOL_CHANGE / FIT_HISTORY_SIZE）。

退出码：0 ok | 1 config-error | 2 usage-error | 3 no-gpu | 4 fit-failed。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import traceback

# torch 必须先于 ctpwa import（libc10 加载顺序，见 PLAN-STEP1）。
import torch
import numpy as np

# fit.py 在本驱动里是符号链接（iter_start 把 fit.py -> 插件 scripts/aifit.py），
# 所以必须用 realpath 才能定位同目录的 pwa_optimizer.py（符号链接所在目录里没有）。
# 兜底：PWA_OPTIMIZER_DIR 或把 pwa_optimizer.py 一并放在 fit.py 旁边（复制而非
# 软链 fit.py 的部署）。
_here = os.path.dirname(os.path.realpath(__file__))
for _cand in (_here, os.environ.get("PWA_OPTIMIZER_DIR", ""),
              os.path.dirname(os.path.abspath(__file__))):
    if _cand and os.path.isfile(os.path.join(_cand, "pwa_optimizer.py")):
        sys.path.insert(0, _cand)
        break
try:
    from pwa_optimizer import UnifiedPWAOptimizer  # noqa: E402
except ImportError as _e:  # pragma: no cover - deployment error path
    sys.stderr.write(
        f"[aifit] 无法导入 pwa_optimizer（与 aifit.py 同目录的优化器内核）：{_e}\n"
        f"        aifit.py 实际路径 = {_here}\n"
        f"        请把 pwa_optimizer.py 放在上述目录，或用 PWA_OPTIMIZER_DIR 指定其目录。\n")
    raise

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_USAGE = 2
EXIT_NO_GPU = 3
EXIT_FIT_FAILED = 4

SCHEMA_VERSION = "0.4.0"

# 撞边界判定：|value - bound| < 1e-3 * (upper - lower) 记为贴边。
BOUNDARY_FRACTION = 1e-3


class AifitError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = EXIT_FIT_FAILED):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="AI-first ctpwa fit driver (JSON diagnostics)")
    p.add_argument("--config", default="config.yml", help="config.yml 路径（DecayInfo 校验 + 工作目录基准）")
    p.add_argument("--validate-only", action="store_true", help="只做无 GPU 的 config 校验并输出 JSON")
    p.add_argument("--interference", metavar="WEIGHT_ROOT", help="只读模式：从 weight_best.root 提取干涉矩阵（不跑拟合，无需 GPU）")
    p.add_argument("--runs", type=int, default=int(os.environ.get("PWA_AIFIT_RUNS", "10")), help="随机初值运行次数（短拟合用 1）")
    p.add_argument("--max-iter", type=int, default=int(os.environ.get("PWA_AIFIT_MAX_ITER", "10000")), help="单次 LBFGS 最大迭代")
    p.add_argument("--seed", type=int, default=42, help="随机种子基（第 i 次运行用 seed+i）")
    p.add_argument("--json", default="results/fit.json", help="JSON 输出路径")
    p.add_argument("--warm", metavar="FIT_JSON", default=None,
                   help="热启动：按参数名对齐，用这份 fit.json 的 best.params 作为**第一次**运行的初值"
                        "（其余 run 仍按 seed 随机；新增/未匹配的参数保留 seed 初值，越界值夹回 bounds）")
    # ---- 优化器（与 ctpwa example/fit.py 同名参数/env，默认 reparam） ----
    p.add_argument("--optimizer", default=os.environ.get("FIT_OPTIMIZER", "reparam"),
                   choices=["reparam", "projected", "lbfgs"],
                   help="reparam=重参数化软墙（默认，推荐）| projected=有界 L-BFGS（KKT/活跃集）| "
                        "lbfgs=旧路径 torch LBFGS+clamp（仅 A/B 对照）；env FIT_OPTIMIZER")
    p.add_argument("--no-polish", dest="polish", action="store_false", default=None,
                   help="关闭最佳解的二阶 damped-Newton 抛光（env FIT_POLISH=0）")
    p.add_argument("--polish", dest="polish", action="store_true",
                   help="启用抛光（默认开启）")
    p.add_argument("--vmax", type=float, default=None, help="耦合幅度上界（env FIT_VMAX，默认 10000）")
    p.add_argument("--amp-max", type=float, default=None, help="reparam 耦合幅度软墙上限（env FIT_AMP_MAX，默认 1000）")
    p.add_argument("--amp-lambda", type=float, default=None, help="reparam 幅度罚项 λ·Σ|A|²（env FIT_AMP_LAMBDA，默认 1e-4，0 关闭）")
    p.add_argument("--lr", type=float, default=None, help="LBFGS 初始步长（env FIT_LR，默认 0.3）")
    p.add_argument("--tol-grad", type=float, default=None, help="梯度收敛阈值（env FIT_TOL_GRAD，默认 1e-5）")
    p.add_argument("--tol-change", type=float, default=None, help="参数变化收敛阈值（env FIT_TOL_CHANGE，默认 1e-5）")
    p.add_argument("--history-size", type=int, default=None, help="LBFGS history 大小（env FIT_HISTORY_SIZE，默认 200）")
    p.add_argument("--bound-margin", type=float, default=None,
                   help="贴边告警阈值（相对 free_range 宽度；env FIT_BOUND_MARGIN，默认 0.02=2%%）"
                        "—— 与 ctpwa example/fit.py 的 --bound-margin 同义")
    return p.parse_args(argv)


def _env_float(name: str, default: float) -> float:
    v = os.environ.get(name)
    return float(v) if v is not None else default


def _env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v is not None else default


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes")


def optimizer_options(args: argparse.Namespace) -> dict:
    """把 CLI/env/默认值并成 UnifiedPWAOptimizer 的构造参数（同 example/fit.py）。"""
    polish = args.polish if args.polish is not None else _env_bool("FIT_POLISH", True)
    return {
        "kind": str(args.optimizer).lower(),
        "polish": polish,
        "v_max": args.vmax if args.vmax is not None else _env_float("FIT_VMAX", 10000.0),
        "amp_max": args.amp_max if args.amp_max is not None else _env_float("FIT_AMP_MAX", 1000.0),
        "amp_lambda": args.amp_lambda if args.amp_lambda is not None else _env_float("FIT_AMP_LAMBDA", 1e-4),
        "lr": args.lr if args.lr is not None else _env_float("FIT_LR", 0.3),
        "tol_grad": args.tol_grad if args.tol_grad is not None else _env_float("FIT_TOL_GRAD", 1e-5),
        "tol_change": args.tol_change if args.tol_change is not None else _env_float("FIT_TOL_CHANGE", 1e-5),
        "history_size": args.history_size if args.history_size is not None else _env_int("FIT_HISTORY_SIZE", 200),
        "bound_margin": args.bound_margin if args.bound_margin is not None else _env_float("FIT_BOUND_MARGIN", 0.02),
    }


def _json_safe(value):
    """NaN/Inf -> None so fit.json is always strict, parseable JSON.

    A degenerate Hessian makes ctpwa report min_eigenvalue / condition_number
    as NaN; json.dump would then emit the bare token NaN, which every strict
    JSON reader (JSON.parse, jq, ...) rejects for the WHOLE file.
    """
    if isinstance(value, float):
        return None if (math.isnan(value) or math.isinf(value)) else value
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(_json_safe(data), f, indent=2, ensure_ascii=False, allow_nan=False)
        f.write("\n")


def finish(data: dict, json_path: str, exit_code: int) -> int:
    write_json(json_path, data)
    return exit_code


# ---------------------------------------------------------------------------
# 3. 干涉矩阵（v2：从 weight_best.root 读取，不用 getSLAmpsTensor——
#    每事件全波表太大，容易爆显存/内存。引擎 writeResult 已把干涉矩阵
#    （TMatrixD "interference"，npartials×npartials 对称）和波名
#    （TTree "legends"）写进 ROOT 文件）。
#
# 约定（ctpwa ComputeResults.cu computeModWithInterference）：
#   M_ii = |A_i|²/|A|²（每事件归一，跨事件求和），
#   M_ij = 2·Re(A_i·A_j*)/|A|²（i≠j，含符号——相消干涉为负），
#   总强度 I = Σ_ij M_ij，分波份额 = M_ii/I，干涉份额 = M_ij/I。
# ---------------------------------------------------------------------------

# 垃圾判定阈值：合法条目 |M_ij| ≤ N_events（每事件 ≤ 1，全事件同相上限）；
# 未初始化堆内存的典型值是 e+190 ~ e+250。1e6 远高于任何物理值。
GARBAGE_ABS = 1e6


def analyze_interference(elements, npartials: int, names: list[str]) -> dict:
    """纯 numpy：从 TMatrixD 元素数组构建干涉摘要（含垃圾检测）。

    elements: 展平的 fElements（n*n，行主序）。返回 dict，available=false
    表示矩阵不可信（未初始化条目），绝不把垃圾当物理。
    """
    arr = np.asarray(elements, dtype=float)
    if arr.size != npartials * npartials:
        return {"available": False, "reason": f"矩阵元素数 {arr.size} != {npartials}²，文件异常"}
    m = arr.reshape(npartials, npartials)
    if not np.all(np.isfinite(m)):
        return {"available": False, "reason": "矩阵含非有限值（NaN/Inf）"}
    bad = np.abs(m) > GARBAGE_ABS
    n_bad = int(bad.sum())
    if n_bad > 0:
        bad_idx = [(int(i), int(j)) for i, j in zip(*np.where(bad)) if i <= j]
        return {
            "available": False,
            "reason": (f"干涉矩阵含 {n_bad} 个未初始化条目（|M| > {GARBAGE_ABS:.0e}，共 "
                       f"{len(bad_idx)} 个上三角槽位）——weight_best.root 的 interference "
                       f"矩阵不可信；检查 ctpwa writeResult 的 h_interference_matrix 是否 "
                       f"未初始化即参与 += 累加"),
            "garbagePairs": bad_idx[:20],
        }
    total = float(m.sum())
    if not np.isfinite(total) or total <= 0:
        return {"available": False, "reason": f"矩阵总和 {total} 非正——无法归一化"}
    diag = m.diagonal()
    fractions = [
        {"amplitude": names[i] if i < len(names) else f"amp_{i}",
         "fraction": float(diag[i]) / total}
        for i in range(npartials)
    ]
    pairs = []
    for i in range(npartials):
        for j in range(i + 1, npartials):
            v = float(m[i, j]) / total
            pairs.append({
                "pair": [names[i] if i < len(names) else f"amp_{i}",
                         names[j] if j < len(names) else f"amp_{j}"],
                "value": v,
            })
    pairs.sort(key=lambda p: -abs(p["value"]))
    return {
        "available": True,
        "totalIntensity": total,
        "matrix": [[float(x) for x in row] for row in m],
        "fractions": fractions,
        "topInterference": pairs[:12],
    }


def read_interference_from_root(root_path: str) -> dict:
    """从 weight_best.root 读取干涉矩阵 + 波名（uproot，无 GPU）。"""
    try:
        import uproot
    except Exception as e:
        return {"available": False, "reason": f"uproot 不可用: {type(e).__name__}: {e}"}
    try:
        f = uproot.open(root_path)
        mobj = f["interference"]
        elements = mobj.member("fElements")
        n = int(mobj.member("fNrows")) if "fNrows" in getattr(mobj, "members", {}) else int(round(len(elements) ** 0.5))
        legend_tree = f["legends"]
        raw = legend_tree["legend"].array()[0]
        names = [s.decode() if isinstance(s, bytes) else str(s) for s in raw]
        return analyze_interference(elements, n, names)
    except Exception as e:
        return {"available": False, "reason": f"读取失败: {type(e).__name__}: {e}"}


def run_interference_only(args: argparse.Namespace) -> int:
    out = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok",
        "mode": "interference",
        "weightRoot": args.interference,
        "interference": read_interference_from_root(args.interference),
    }
    if not out["interference"]["available"]:
        out["status"] = "interference-unavailable"
        out["error"] = {"code": "interference-garbage", "message": out["interference"]["reason"]}
        return finish(out, args.json, EXIT_OK)
    return finish(out, args.json, EXIT_OK)


# ---------------------------------------------------------------------------
# 1. config 校验（无 GPU）
# ---------------------------------------------------------------------------

def config_view(config_path: str) -> dict:
    import ctpwa
    di = ctpwa.DecayInfo(config_path)
    n_amp = int(di.nAmplitudes())
    ctpwa_valid = bool(di.isValid())
    # DecayInfo::isValid() only checks initialized_ (the Particles section
    # parsed). A config whose production step is flat instead of a mode list
    # (`Jpsi: [d1, d2]` instead of `Jpsi: [[d1, d2]]`) parses "valid" but builds
    # ZERO amplitudes, so a fit would silently describe nothing. Zero
    # amplitudes is not a usable config.
    return {
        "valid": ctpwa_valid and n_amp > 0,
        "ctpwaValid": ctpwa_valid,
        "path": config_path,
        "nAmplitudes": n_amp,
        "nFreeParams": int(di.nFreeParams()),
        "amplitudeNames": list(di.amplitudeNames()),
        "resonanceNames": list(di.resonanceNames()),
        "paramNames": list(di.paramNames()),
        "hasCouplingMatrix": bool(di.hasCouplingMatrix()),
    }


def run_validate_only(args: argparse.Namespace) -> int:
    try:
        view = config_view(args.config)
    except Exception as e:
        return finish({
            "schemaVersion": SCHEMA_VERSION,
            "status": "config-error",
            "config": {"path": args.config, "valid": False},
            "error": {"code": "config-parse-failed", "message": f"{type(e).__name__}: {e}"},
        }, args.json, EXIT_CONFIG)
    if view["valid"]:
        error = None
    elif view["nAmplitudes"] == 0:
        error = {
            "code": "no-amplitudes",
            "message": (
                f"ctpwa parsed {args.config} but built 0 amplitudes. The production step must be "
                "a mode list (`Jpsi: [[d1, d2]]`), and every intermediate [J,P] group needs at "
                "least one resonance."
            ),
        }
    else:
        error = {"code": "config-invalid", "message": f"DecayInfo.isValid() = false for {args.config}"}
    return finish({
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok" if view["valid"] else "config-error",
        "config": view,
        "error": error,
    }, args.json, EXIT_OK if view["valid"] else EXIT_CONFIG)


# ---------------------------------------------------------------------------
# 2. 拟合（复用 ctpwa example/fit.py 的优化器内核：scripts/pwa_optimizer.py）
#
# 旧内联实现（归一化空间 LBFGS + 就地 clamp + 梯度清零）已删除：它会在边界处
# 静默伪收敛、耦合无界增长到 1e14、被 free_range 钉住的参数仍报伪误差。
# 现在直接构造 example/fit.py 的 UnifiedPWAOptimizer（默认 reparam 软墙 +
# damped-Newton polish + 活跃集感知误差）。
# ---------------------------------------------------------------------------

def make_optimizer(ana, free_res_info, params_names, opts: dict, device: str | None = None) -> UnifiedPWAOptimizer:
    """构造与 ctpwa example/fit.py 数值同源的优化器（默认 reparam 软墙路径）。"""
    return UnifiedPWAOptimizer(
        ana, free_res_info, params_names,
        v_max=opts["v_max"],
        optimizer_kind=opts["kind"],
        amp_max=opts["amp_max"],
        amp_lambda=opts["amp_lambda"],
        device=device,
    )



# ---------------------------------------------------------------------------
# JSON 组装
# ---------------------------------------------------------------------------

def _num(t: torch.Tensor | None, i: int | None = None) -> float | None:
    if t is None:
        return None
    try:
        v = t[i] if i is not None else t
        return float(v.cpu().item() if hasattr(v, "cpu") else v)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Hessian 诊断（与 ctpwa example/fit.py 同源：ctpwa.diagnostics.analyze_hessian）
#
# example/fit.py 的 fa40d41 把"是否正定"从"全自由块 all(eig>0)"换成**可行子空间**
# （KKT 二阶条件）：先剔除固定参考 Re_0/Im_0（它们在 getHessian 里是恒零行/列），
# 再剔除"贴边且梯度朝外"的活跃参数（那个方向的负曲率根本不可行），只对剩下的
# 方向判 λmin > tau·λmax。旧判据会把被 free_range 钉住的合法约束极小误报成
# "不定"，于是参数误差与相关矩阵整块消失。
# ---------------------------------------------------------------------------

def _nll_and_grad(opt: UnifiedPWAOptimizer, params: torch.Tensor) -> tuple[float, torch.Tensor]:
    """同一个参数点上的 (NLL, dNLL/dparams)。"""
    q = params.detach().clone().requires_grad_(True)
    nll = opt.analysis.getNLL(q)
    return float(nll.item()), torch.autograd.grad(nll, q)[0].detach()


def hessian_report(opt: UnifiedPWAOptimizer, params: torch.Tensor,
                   hessian_full: torch.Tensor | None = None,
                   tau: float = 1e-8, bound_margin: float = 1e-8,
                   kkt_tol: float = 1e-2) -> tuple:
    """可行子空间 Hessian 报告 -> (report, grad, nll)。

    report 是 ctpwa.diagnostics.HessianSubspaceReport：判据看 ``reduced_pd``，
    ``free_pd`` 保留旧口径供对照。ctpwa 太旧（没有 diagnostics 模块）时这里抛
    ImportError，由调用方降级 —— 不因为诊断缺失就丢掉整轮拟合结果。
    """
    from ctpwa.diagnostics import analyze_hessian
    if hessian_full is None:
        hessian_full = opt._get_hessian_cached(params)
    nll, grad = _nll_and_grad(opt, params)
    lo, hi = opt.bounds(params)
    fixed = torch.zeros(opt.n_params, dtype=torch.bool, device=opt.device)
    fixed[0] = True                     # 固定参考 Re_0 = 1
    fixed[opt.n_coupling_free] = True   # 固定参考 Im_0 = 0
    report = analyze_hessian(hessian_full, params, grad, lo, hi,
                             fixed_mask=fixed, tau=tau,
                             bound_margin=bound_margin, kkt_tol=kkt_tol)
    return report, grad, nll


def hessian_fields(opt: UnifiedPWAOptimizer, report) -> dict:
    """HessianSubspaceReport -> fit.json 字段（同 example/fit.py 的 _hessian_fields）。"""
    evr, evf = report.ev_reduced, report.ev_free
    rm = report.reduced_min_eigenvalue
    rx = report.reduced_max_eigenvalue
    return {
        # 判据：可行（非活跃）子空间的正定性 = KKT 二阶条件
        "positiveDefinite": bool(report.reduced_pd),
        # 旧口径：全自由块（含贴边参数朝外的负曲率），仅用于对照
        "positiveDefiniteFull": bool(report.free_pd),
        "minEigenvalue": rm,
        "maxEigenvalue": rx,
        "conditionNumber": (rx / rm) if (rm == rm and rm > 0) else float("inf"),
        "fullMinEigenvalue": report.free_min_eigenvalue,
        "fullMaxEigenvalue": report.free_max_eigenvalue,
        "nNegativeReduced": int((evr < 0).sum().item()) if evr.numel() else 0,
        "nNegativeFull": int((evf < 0).sum().item()) if evf.numel() else 0,
        "nActive": int(report.n_active),
        "activeParams": [_param_label(opt, int(i)) for i in report.active_idx.tolist()],
        "kktGradMax": float(report.kkt_max),
        "kktOk": bool(report.kkt_ok),
    }


def _run_report_fields(opt: UnifiedPWAOptimizer, result: dict, warnings: list[str],
                       run_id: int) -> dict:
    """单个 run 终点的可行子空间诊断（失败时回退到内核的全自由块字段）。

    result 需含 ``final_params``；带了 ``hessian_full`` 就复用（省一次 getHessian）。
    诊断结果就地写回 result，并返回同一份 dict 供 runSummaries 使用。
    """
    try:
        report, _grad, _nll = hessian_report(
            opt, result["final_params"], result.get("hessian_full"))
        fields = hessian_fields(opt, report)
    except Exception as e:  # noqa: BLE001 - 旧 ctpwa / CPU 后端缺块时降级
        warnings.append(
            f"run {run_id} 的可行子空间诊断不可用（回退全自由块判据）: "
            f"{type(e).__name__}: {e}")
        fields = {
            "positiveDefinite": bool(result.get("is_positive_definite", False)),
            "positiveDefiniteFull": bool(result.get("is_positive_definite", False)),
            "minEigenvalue": result.get("min_eigenvalue"),
            "maxEigenvalue": result.get("max_eigenvalue"),
            "conditionNumber": result.get("condition_number"),
        }
    result.update(fields)
    return fields


def _correlation_from_hessian(opt: UnifiedPWAOptimizer, hessian_full: torch.Tensor,
                              idx: torch.Tensor | None = None) -> dict | None:
    """相关矩阵：在**可行子空间**（idx）上反演 Hessian。

    idx 是 ctpwa.diagnostics 给出的 ``reduced_idx``（全参数下标；布局是 grouped
    ``[Re_0.., Im_0.., θ..]``）。传 None 时退化为"全部非固定参数"，等价于不存在
    贴边参数的情形。子空间不 PD 时不该调用（求逆无意义），由调用方门控。
    """
    if idx is None:
        idx = torch.tensor(
            [k for k in range(opt.n_params)
             if k != 0 and k != opt.n_coupling_free], dtype=torch.long)
    idx = idx.detach().to(device=hessian_full.device, dtype=torch.long)
    if idx.numel() == 0:
        return None
    try:
        h = hessian_full.index_select(0, idx).index_select(1, idx).double()
        h = 0.5 * (h + h.t())
        cov = torch.linalg.inv(h)
        sd = torch.sqrt(torch.diag(cov).clamp(min=0.0))
        denom = torch.outer(sd, sd).clamp(min=1e-300)
        corr = (cov / denom).clamp(-1.0, 1.0)
    except Exception:
        return None
    names = [_param_label(opt, int(k)) for k in idx.tolist()]
    return {"names": names, "matrix": [[float(x) for x in row] for row in corr.cpu().numpy()]}


def boundary_diagnostics(opt: UnifiedPWAOptimizer, params: torch.Tensor,
                         grad: torch.Tensor, margin: float) -> list[dict]:
    """贴边参数清单（同 example/fit.py 的 report_bound_margins）。

    margin 是**相对 free_range 宽度**的边距阈值（默认 2%，env FIT_BOUND_MARGIN）。
    贴边的 θ 是"假非正定"的头号来源：顶到边界后 reparam 的 sigmoid 梯度→0，
    优化器按容差停机，但物理空间 |∂NLL/∂θ| 仍然很大 → Hessian 是在边界/非驻点上
    评估的。fit.py 对耦合只查实部，这里用复幅度 |c|（reparam 参数化的是幅度，
    等价或更严）。
    """
    p = params.detach()
    out: list[dict] = []
    nc = opt.n_coupling_free
    if opt.has_free_res:
        for j in range(opt.n_res_free):
            k = 2 * nc + j
            v = float(p[k])
            lo, hi = float(opt._lower[j]), float(opt._upper[j])
            mg = max(0.0, min(v - lo, hi - v)) / max(hi - lo, 1e-30)
            # 越界不该出现（polish / bounds 都会把参数投影回盒内）；真出现了也
            # 按 0 报，而不是输出一个负的"边距"，那会让人误读成"离边界还很远"。
            if mg < margin:
                out.append({"param": opt.params_names[nc + j], "kind": "resonance",
                            "value": v, "lower": lo, "upper": hi,
                            "margin": mg, "gradNll": abs(float(grad[k]))})
    if nc > 1:
        re, im = p[1:nc], p[nc + 1:2 * nc]
        amp = float(torch.sqrt(re * re + im * im).max().item())
        v_max = float(opt.v_max)
        if v_max > 0 and amp > (1.0 - margin) * v_max:
            out.append({"param": "coupling |c| (对照 v_max)", "kind": "coupling",
                        "value": amp, "lower": -v_max, "upper": v_max,
                        "margin": 1.0 - amp / v_max, "gradNll": None})
    out.sort(key=lambda d: d["margin"])
    return out


def build_best_json(opt: UnifiedPWAOptimizer, final_params: torch.Tensor, result: dict,
                    errors: tuple | None, correlation: dict | None,
                    warnings: list[str], boundary: list[dict] | None = None) -> dict:
    params: list[dict] = []
    coupling = opt.extract_coupling_complex(final_params)
    coupling_np = coupling.cpu().numpy()
    re_err, im_err, res_err = errors if errors is not None else (None, None, None)
    for fi in range(opt.n_coupling_free):
        params.append({
            "name": opt.params_names[fi],
            "kind": "coupling",
            "real": float(coupling_np[fi].real),
            "imag": float(coupling_np[fi].imag),
            "realError": _num(re_err, fi),
            "imagError": _num(im_err, fi),
        })
    if opt.has_free_res:
        theta = opt.extract_theta_phys(final_params).cpu().numpy()
        lower_np = opt._lower.cpu().numpy()
        upper_np = opt._upper.cpu().numpy()
        for j in range(opt.n_res_free):
            idx = opt.n_coupling_free + j
            value = float(theta[j])
            lo, hi = float(lower_np[j]), float(upper_np[j])
            margin = BOUNDARY_FRACTION * (hi - lo)
            at_boundary = value <= lo + margin or value >= hi - margin
            err = _num(res_err, j)
            if at_boundary:
                warnings.append(f"{opt.params_names[idx]} = {value:.6g} 贴住 free_range "
                                f"[{lo:.6g}, {hi:.6g}]（撞边界：数据可能不支持该自由度）")
                if err is None:
                    warnings.append(f"{opt.params_names[idx]} 被 free_range 钉住 → 无统计误差"
                                    f"（放宽 free_range 或按单侧限制报告）")
            params.append({
                "name": opt.params_names[idx],
                "kind": "resonance",
                "value": value,
                "error": err,
                "lower": lo,
                "upper": hi,
                "atBoundary": at_boundary,
            })

    def _pick(name: str, legacy: str | None = None, default=None):
        """新字段名优先，回退旧字段名（兼容外部 fit.json / 旧版内核）。"""
        if name in result:
            return result[name]
        return result.get(legacy, default) if legacy is not None else default

    best: dict = {
        "runId": result["run_id"],
        "nll": float(result["final_nll"]),
        # 正定性：positiveDefinite = 可行子空间（KKT 二阶条件，fit.py fa40d41 起的
        # 口径）；positiveDefiniteFull = 全自由块（旧口径，仅供对照）。
        "positiveDefinite": bool(_pick("positiveDefinite", "is_positive_definite", False)),
        "positiveDefiniteFull": _pick("positiveDefiniteFull", "is_positive_definite_full"),
        "minEigenvalue": _pick("minEigenvalue", "min_eigenvalue"),
        "maxEigenvalue": _pick("maxEigenvalue", "max_eigenvalue"),
        "conditionNumber": _pick("conditionNumber", "condition_number"),
        "fullMinEigenvalue": _pick("fullMinEigenvalue", "full_min_eigenvalue"),
        "fullMaxEigenvalue": _pick("fullMaxEigenvalue", "full_max_eigenvalue"),
        "nActive": _pick("nActive", "n_active"),
        "activeParams": _pick("activeParams", "active_params"),
        "nNegativeReduced": _pick("nNegativeReduced", "n_negative_reduced"),
        "nNegativeFull": _pick("nNegativeFull", "n_negative_full"),
        "kktGradMax": _pick("kktGradMax", "kkt_grad_max"),
        "kktOk": _pick("kktOk", "kkt_ok"),
        "optimizerStatus": result.get("optimizer_status"),
        "params": params,
        "fitFractions": None,
        "branchFractions": None,
    }
    if boundary is not None:
        # 总是给数组（哪怕为空）——消费方不必区分"没算"与"算了但没贴边"
        best["boundaryDiagnostics"] = boundary
    if boundary:
        warnings.append(
            f"{len(boundary)} 个参数贴近边界（边距 < --bound-margin 阈值，见 boundaryDiagnostics）："
            + ", ".join(d["param"] for d in boundary[:6])
            + (" ..." if len(boundary) > 6 else ""))
    if errors is None or all(e is None for e in errors):
        warnings.append(
            "参数误差不可用：可行子空间 Hessian 不正定（看 best.nActive / minEigenvalue 与 "
            "fit.log 的 [polish]/[errors] 行）—— 贴边自由度没有统计误差，只能按单侧限制报告，"
            "或放宽 free_range 重跑；相关矩阵同样不给")
    if correlation is not None:
        best["correlation"] = correlation

    # 分波贡献（phsp_truth 门控；用与拟合同源的统一 Hessian 做误差传播）
    # CPU 后端注意：ctpwa 的 getFitFractions/getEfficiency 入口仍然 TORCH_CHECK
    # CUDA 张量（Analysis.cu），CPU 构建一调用就抛，所以这里直接跳过并说明。
    if getattr(opt, "device", "cuda") == "cpu":
        warnings.append(
            "cpu-backend: ctpwa 的 getFitFractions 目前只接受 CUDA 张量（CPU 构建也会 TORCH_CHECK 失败）"
            "—— 分波份额不可用；需要份额请用 target:\"gpu\"/\"slurm\"。"
        )
    else:
        try:
            ff = opt.analysis.getFitFractions(coupling, opt._get_hessian_cached(final_params))
            names = list(opt.analysis.getAmplitudeNames())
            if ff is not None and ff.numel() > 0:
                best["fitFractions"] = [
                    {"amplitude": names[i] if i < len(names) else f"amp_{i}",
                     "fraction": float(ff[i, 0]), "error": float(ff[i, 1])}
                    for i in range(ff.shape[0])
                ]
            else:
                warnings.append("getFitFractions 返回空（config 缺 phsp_truth？）——分波份额不可用")
        except Exception as e:
            warnings.append(f"getFitFractions 不可用（需要 config 的 phsp_truth？）: {type(e).__name__}: {e}")

    # 分支比：旧 ctpwa 构建没有该 API —— 有才试，没有不刷警告
    if hasattr(opt.analysis, "getBranchFractions"):
        try:
            bf = opt.analysis.getBranchFractions(coupling)
            names = list(opt.analysis.getAmplitudeNames())
            if bf is not None and bf.numel() > 0:
                best["branchFractions"] = [
                    {"amplitude": names[i] if i < len(names) else f"amp_{i}",
                     "fraction": float(bf[i, 0]), "error": float(bf[i, 1])}
                    for i in range(bf.shape[0])
                ]
        except Exception as e:
            warnings.append(f"getBranchFractions 不可用: {type(e).__name__}: {e}")
    return best


def _param_label(opt: UnifiedPWAOptimizer, k: int) -> str:
    """统一参数向量第 k 个分量的可读名（与 correlation.names 的写法一致）。"""
    nc = opt.n_coupling_free
    if k < nc:
        return f"Re({opt.params_names[k]})"
    if k < 2 * nc:
        return f"Im({opt.params_names[k - nc]})"
    return opt.params_names[k - nc]


def warm_start_params(opt: UnifiedPWAOptimizer, warm_path: str, initial: torch.Tensor,
                      warnings: list[str]) -> tuple[torch.Tensor, dict]:
    """按**参数名**对齐，把上一次 fit.json 的最优参数灌成本次初值。

    向量布局与 generate_initial_params 一致：[Re(c) | Im(c) | theta]；耦合 0 是固定
    参考振幅（bounds 把它钉成 1+0i），不参与热启动。按名字对齐带来两个关键性质：

    - **新增一个共振态再热启动**是自然可用的：新参数名在旧 fit.json 里找不到，保留
      seed 初值，其余参数沿用上次结果（这正是迭代工作流想要的）；
    - free_range 之后若被改窄，越界值会夹回当前 bounds 并如实报告，不静默使用。

    读不出 / 一个名字都对不上时**直接报错退出**（不静默退回随机初值 —— 那会白跑一次
    拟合，且用户以为自己在续跑）。
    """
    try:
        with open(warm_path, encoding="utf-8") as fh:
            prev = json.load(fh)
    except Exception as e:
        raise SystemExit(f"[aifit] --warm 读取失败 {warm_path}: {type(e).__name__}: {e}")
    best = prev.get("best") if isinstance(prev, dict) else None
    if not isinstance(best, dict) and isinstance(prev, dict):
        fit = prev.get("fit")
        if isinstance(fit, dict):
            best = fit.get("best")
    entries = best.get("params") if isinstance(best, dict) else None
    if not isinstance(entries, list) or not entries:
        raise SystemExit(f"[aifit] --warm {warm_path}: 没有 best.params（这不是一份拟合结果？）")
    by_name: dict[str, dict] = {
        p["name"]: p for p in entries if isinstance(p, dict) and isinstance(p.get("name"), str)
    }

    nc = opt.n_coupling_free
    out = initial.clone()
    reused: list[str] = []
    missing: list[str] = []
    for i in range(1, nc):  # i == 0 是固定参考振幅
        name = opt.params_names[i]
        p = by_name.get(name)
        if (p is None or p.get("kind") != "coupling"
                or not isinstance(p.get("real"), (int, float))
                or not isinstance(p.get("imag"), (int, float))):
            missing.append(name)
            continue
        out[i] = float(p["real"])
        out[nc + i] = float(p["imag"])
        reused.append(name)
    if opt.has_free_res:
        for j in range(opt.n_res_free):
            name = opt.params_names[nc + j]
            p = by_name.get(name)
            if p is None or p.get("kind") != "resonance" or not isinstance(p.get("value"), (int, float)):
                missing.append(name)
                continue
            out[2 * nc + j] = float(p["value"])
            reused.append(name)
    if not reused:
        raise SystemExit(
            f"[aifit] --warm {warm_path}: 参数名与当前 config 无一对上"
            f"（可能是另一份 config 的 fit.json 或名字已全改）—— 拒绝静默退回随机初值")

    clamped: list[str] = []
    lo, hi = opt.bounds(out)
    for k in range(out.shape[0]):
        v, lo_k, hi_k = float(out[k]), float(lo[k]), float(hi[k])
        if v < lo_k:
            out[k] = lo_k
            clamped.append(f"{_param_label(opt, k)}: {v:.6g} < {lo_k:.6g}")
        elif v > hi_k:
            out[k] = hi_k
            clamped.append(f"{_param_label(opt, k)}: {v:.6g} > {hi_k:.6g}")
    for c in clamped:
        warnings.append(f"热启动夹回 bounds: {c}")
    print(
        f"[aifit] 热启动 {warm_path}: 复用 {len(reused)} 个参数、未匹配 {len(missing)} 个"
        f"{'（保留 seed 初值）' if missing else ''}"
        f"{f'、夹回 bounds {len(clamped)} 个' if clamped else ''}",
        flush=True,
    )
    return out, {
        "source": warm_path,
        "reused": reused,
        "missing": missing,
        "clamped": clamped,
    }


def _run_fit(args: argparse.Namespace) -> int:
    """完整拟合：example/fit.py 同源优化器（多起点 + polish + Hessian 诊断） -> fit.json。"""
    try:
        import ctpwa  # noqa: F401 — 先 torch 后 ctpwa
    except Exception as e:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "no-gpu",
                       "error": {"code": "ctpwa-import-failed", "message": f"{type(e).__name__}: {e}"}},
                      args.json, EXIT_NO_GPU)
    # ctpwa 0.3.19+ 有 CPU 后端（同一进程只能用一个后端，门面在 import 时定）。
    # 设备优先级与插件一致：CTPWA_DEVICE（ctpwa 自己读）→ ctpwa.backend()。
    # 显式 CTPWA_DEVICE=cuda 但不可用时，ctpwa 门面自己会抛错，这里不重复判断。
    backend = getattr(ctpwa, "backend", lambda: "cuda")()
    device = "cuda" if backend == "cuda" else "cpu"

    config_abs = os.path.abspath(args.config)
    workdir = os.path.dirname(config_abs) or "."
    if os.path.abspath(os.getcwd()) != workdir:
        os.chdir(workdir)  # 相对数据路径以 config 目录为基准（同 fit.py）

    # 先做无 GPU 校验，失败快速退出（结构化 config-error）。
    try:
        view = config_view(args.config)
    except Exception as e:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "config-error",
                       "config": {"path": args.config, "valid": False},
                       "error": {"code": "config-parse-failed", "message": f"{type(e).__name__}: {e}"}},
                      args.json, EXIT_CONFIG)
    if not view["valid"]:
        if view.get("nAmplitudes") == 0:
            error = {
                "code": "no-amplitudes",
                "message": (
                    f"ctpwa parsed {args.config} but built 0 amplitudes. The production step must be "
                    "a mode list (`Jpsi: [[d1, d2]]`), and every intermediate [J,P] group needs at "
                    "least one resonance."
                ),
            }
        else:
            error = {"code": "config-invalid", "message": f"DecayInfo.isValid() = false for {args.config}"}
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "config-error",
                       "config": view, "error": error},
                      args.json, EXIT_CONFIG)

    opts = optimizer_options(args)
    t_start = time.time()
    # ⚠ 显式把 config 路径交给 analysis()：旧代码调 analysis() 依赖 cwd/config.yml，
    #   `--config other.yml` 会静默读错文件（ctpwa doc/optimizer-attribution §13）。
    try:
        ana = ctpwa.analysis(config_abs)
    except Exception as e:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "config-error",
                       "config": view,
                       "error": {"code": "config-load-failed", "message": f"{type(e).__name__}: {e}"}},
                      args.json, EXIT_CONFIG)

    free_res_info = ana.getFreeResParams()
    params_names = list(ana.getParamNames())
    opt = make_optimizer(ana, free_res_info, params_names, opts, device=device)
    warnings: list[str] = []
    if device == "cpu":
        warnings.append(
            "cpu-backend: 本次拟合跑在 CPU 后端（ctpwa 0.3.19+）。CPU 比 GPU 慢 20~60 倍，"
            "只适合低统计量/冒烟测试；正式结果请用 GPU 或集群。精度为 double（与 GPU 数值差 ~1e-11）。"
        )
    runs_json: list[dict] = []
    results: list[dict] = []
    os.makedirs("results", exist_ok=True)  # nll_history/fit.json/weight_best.root 的落点

    # 热启动只喂给第一次运行：其余 run 仍按 seed 随机，best-of-runs 语义不变。
    warm_initial: torch.Tensor | None = None
    warm_report: dict | None = None
    if args.warm:
        warm_initial, warm_report = warm_start_params(
            opt, args.warm, opt.generate_initial_params(seed=args.seed), warnings)

    for i in range(args.runs):
        seed = args.seed if i == 0 else args.seed + i
        initial = warm_initial if (i == 0 and warm_initial is not None) \
            else opt.generate_initial_params(seed=seed)
        try:
            result = opt.optimize_single_run(
                initial, run_id=i, max_iter=args.max_iter,
                lr=opts["lr"], tolerance_grad=opts["tol_grad"],
                tolerance_change=opts["tol_change"], history_size=opts["history_size"],
            )
            results.append(result)
            # 每 run 的正定/误差口径与 fit.py 一致：可行子空间（剔除贴边活跃参数），
            # 而不是全自由块 all(eig>0) —— 后者会把被 free_range 钉住的合法约束极小
            # 误报成"不定"。诊断失败时回退到内核的全自由块判据（不丢整轮结果）。
            fields = _run_report_fields(opt, result, warnings, i)
            # 运行期进度：stdout 走管道是块缓冲，且 ctpwa job 是 final-output job
            # （结算前注册表里没有字节），所以必须逐 run 显式 flush 一行，否则
            # fit_status 在拟合跑完前只能看到 ctpwa 的启动块。
            print(
                f"[aifit] run {i + 1}/{args.runs} NLL={result['final_nll']:.6f} "
                f"PD={fields.get('positiveDefinite')} (full={fields.get('positiveDefiniteFull')}, "
                f"active={fields.get('nActive')}) iters={result['iterations']} "
                f"t={result['time']:.1f}s",
                flush=True,
            )
            runs_json.append({
                "runId": i,
                "nll": float(result["final_nll"]),
                "iterations": result["iterations"],
                "timeSec": round(result["time"], 2),
                "positiveDefinite": fields.get("positiveDefinite"),
                "positiveDefiniteFull": fields.get("positiveDefiniteFull"),
                "nActive": fields.get("nActive"),
                "minEigenvalue": fields.get("minEigenvalue"),
                "optimizerStatus": result.get("optimizer_status"),
            })
            # 人读 NLL 历史（兼容旧工具链）
            with open("results/nll_history.txt", "a" if i > 0 else "w") as f:
                if i == 0:
                    f.write(f"# NLL History - aifit.py runs={args.runs} max_iter={args.max_iter} "
                            f"optimizer={opts['kind']}\n")
                f.write(f"# RUN: run_{i}\n")
                for j, v in enumerate(result["nll_history"]):
                    f.write(f"{j:8d}  {v:15.8f}\n")
        except Exception as e:
            runs_json.append({"runId": i, "error": f"{type(e).__name__}: {e}"})
            warnings.append(f"run {i} 失败: {type(e).__name__}: {e}")
            traceback.print_exc()

    if not results:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "fit-failed",
                       "config": view, "error": {"code": "all-runs-failed",
                       "message": f"{args.runs} 次运行全部失败；见 fit.log 与各 run 的 error 字段"}},
                      args.json, EXIT_FIT_FAILED)

    best = min(results, key=lambda r: r["final_nll"])

    # ---- 二阶 polish（damped Newton + 活跃集）：把最优起点再收敛一步 ----
    if opts["polish"]:
        try:
            nll_before = float(best["final_nll"])
            pd_before = bool(best.get("positiveDefinite", False))
            p2, nll2, pd2 = opt.polish_damped_newton(
                best["final_params"], max_steps=int(opt.optimizer_polish_steps))
            # 采纳条件与 example/fit.py 一致：NLL 不显著变差，**或**正定判定变好。
            # 只在 nll2 <= final_nll 时采纳是旧行为：它丢掉的正是"贴边活跃被处理对、
            # 可行子空间由不定变正定、但 NLL 涨了 1e-6 量级"的那个点 → 误差仍是空的。
            if nll2 <= nll_before + 1e-6 or (pd2 and not pd_before):
                best["final_params"] = p2.clone()
                best["final_nll"] = float(nll2)
                # 同步优化器内部状态：否则分波份额/摘要仍用 polish *之前* 的点
                opt.best_params = p2.clone()
                opt.best_nll = float(nll2)
                opt.best_result = best
                # 子空间字段不在这里重算：best["hessian_full"] 是 polish *之前* 的
                # Hessian，拿它配抛光后的参数会得到"甲点曲率、乙点参数"的错误诊断。
                # 下面的终点诊断会用 polish 播种的缓存（同一点）统一刷新。
                upgraded = nll2 > nll_before
                warnings.append(
                    f"polish: NLL {nll_before:.6f} → {float(nll2):.6f} "
                    f"(Δ={float(nll2) - nll_before:+.4f}), 正定(可行子空间)={pd2}"
                    + ("（NLL 略升但正定判定改进 → 采纳，以便报误差）" if upgraded else ""))
            else:
                warnings.append(f"polish: 未采纳（NLL {nll_before:.6f} → {float(nll2):.6f}, "
                                f"正定={pd2}）")
        except Exception as e:
            warnings.append(f"抛光失败（保留未抛光解）: {type(e).__name__}: {e}")

    # ---- 终点诊断：NLL/正定/误差/相关/边距全部对齐同一个参数点 ----
    # 口径与 example/fit.py 一致：可行子空间（KKT 二阶条件）才是判据，全自由块
    # 判据只作为 positiveDefiniteFull 保留对照。CPU 后端有个别 Hessian 块尚未移植
    # （ctpwa::not_implemented），所以这里降级为"误差/相关不可用"，而不是让整轮
    # 拟合在最后一步丢掉。
    final_params = best["final_params"]
    report = None
    grad_final = None
    boundary: list[dict] | None = None
    errors = None
    correlation = None
    try:
        report, grad_final, nll_final = hessian_report(opt, final_params)
        # 报告/正定/误差必须来自同一个点：kernel 已按 final_params 重算 NLL，
        # 这里再对齐一次（polish 之后的点尤其要）。
        best["final_nll"] = nll_final
        best.update(hessian_fields(opt, report))
    except Exception as e:
        warnings.append(
            f"hessian-unavailable: 可行子空间诊断不可用（{type(e).__name__}: {e}）——"
            f"回退到全自由块判据；参数误差/相关矩阵可能缺失。"
            f"需要 ctpwa.diagnostics.analyze_hessian（fa40d41 起）；"
            f"CPU 后端部分 Hessian 块未移植时也会出现，换 GPU 后端可恢复")

    pd = bool(best.get("positiveDefinite", False))
    pd_full = best.get("positiveDefiniteFull")
    if pd and pd_full is False:
        warnings.append(
            f"全自由块 Hessian 不正定（λmin_full={best.get('fullMinEigenvalue')}）但可行子空间正定"
            f"（{best.get('nActive')} 个参数贴边：{', '.join(best.get('activeParams') or [])}）——"
            f"朝外方向的负曲率是边界效应，按 KKT 二阶条件不构成问题；误差按非活跃子空间给出")
    elif not pd:
        warnings.append(
            "非活跃子空间 Hessian 不正定 → 参数误差/相关矩阵不可用（见 fit.log 的 "
            "[polish]/[errors] 行）；可放宽 free_range、换起点或加先验后重跑")
    try:
        if pd:
            # 误差与相关矩阵只在可行子空间正定时有意义（这两步都命中 Hessian 缓存）
            errors = opt.compute_param_errors(final_params)
            correlation = _correlation_from_hessian(
                opt, opt._get_hessian_cached(final_params),
                report.reduced_idx if report is not None else None)
    except Exception as e:
        warnings.append(f"参数误差/相关矩阵不可用: {type(e).__name__}: {e}")
    if report is not None and grad_final is not None:
        boundary = boundary_diagnostics(opt, final_params, grad_final, opts["bound_margin"])
    best_json = build_best_json(opt, final_params, best, errors, correlation, warnings, boundary)

    out = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok",
        "config": view,
        "fit": {
            "nCouplingFree": opt.n_coupling_free,
            "nResFree": opt.n_res_free,
            "runs": args.runs,
            "maxIter": args.max_iter,
            "seedBase": args.seed,
            "optimizer": opts["kind"],
            "polish": opts["polish"],
            "timeSec": round(time.time() - t_start, 2),
            "runSummaries": runs_json,
            "best": best_json,
            "warnings": warnings,
        },
        "error": None,
    }
    if warm_report is not None:
        out["fit"]["warm"] = warm_report

    # 保存权重文件（auto_pwa_evaluate 用）；失败只降级 warning。
    try:
        if opt.has_free_res:
            opt.analysis.reCalcAmp(opt.extract_theta_phys(final_params))
        opt.analysis.writeResult(final_params, "results/weight_best.root", 0)
    except Exception as e:
        out["fit"]["warnings"].append(f"writeResult 失败（weight_best.root 未生成）: {type(e).__name__}: {e}")

    # 干涉矩阵：直接从刚写出的 weight_best.root 读取（引擎已算好，读回即可；
    # 不做 getSLAmpsTensor 全波表——太大易崩）。矩阵不可信时降级 warning。
    interference = read_interference_from_root("results/weight_best.root")
    out["fit"]["interference"] = interference
    if not interference["available"]:
        out["fit"]["warnings"].append(f"干涉矩阵不可用: {interference['reason']}")

    # 兼容旧工具链的人读摘要（fit-summary.ts 的 fallback 解析路径）
    try:
        with open("results/optimization_summary.txt", "w") as f:
            f.write("PWA优化结果 (aifit.py / ctpwa example/fit.py 同源优化器)\n")
            f.write("=" * 100 + "\n")
            f.write(f"优化器: {opts['kind']}  polish={opts['polish']}\n")
            f.write(f"总运行次数: {len(results)}\n")
            f.write(f"耦合参数数量: {opt.n_coupling_free}\n")
            f.write(f"自由共振态参数: {opt.n_res_free}\n")
            f.write(f"最佳NLL: {best['final_nll']:.6f}\n")
            # 注意格式：fit-summary.ts 的文本回退用 /正定\s+True/ 判正定，
            # 所以这里必须把 "正定 <bool>" 写成一行（旧版只有表头，回退解析恒得 false）。
            f.write(f"正定 {best_json['positiveDefinite']}  (可行子空间判据; "
                    f"全自由块={best_json['positiveDefiniteFull']}, "
                    f"active={best_json['nActive']}, "
                    f"λmin={best_json['minEigenvalue']})\n")
            f.write("参数文件: fit.json（机器/AI 主通道）\n")
            f.write("NLL历史: nll_history.txt\n\n")
            f.write("运行结果 (按NLL排序):\n")
            f.write(f"{'排名':<4} {'运行ID':<6} {'NLL':<14} {'迭代':<8} {'正定':<6} {'优化器状态':<20}\n")
            for rank, r in enumerate(sorted(runs_json, key=lambda x: x.get("nll", float("inf")))):
                if "error" in r:
                    f.write(f"{rank + 1:<4} {r['runId']:<6} FAILED: {r['error']}\n")
                    continue
                f.write(f"{rank + 1:<4} {r['runId']:<6} {r['nll']:<14.6f} "
                        f"{r.get('iterations', 0):<8} {str(r.get('positiveDefinite')):<6} "
                        f"{str(r.get('optimizerStatus') or '-'):<20}\n")
    except Exception as e:
        out["fit"]["warnings"].append(f"写 optimization_summary.txt 失败: {e}")
    return finish(out, args.json, EXIT_OK)



def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.runs < 1:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "usage-error",
                       "error": {"code": "invalid-runs", "message": "--runs 必须 >= 1"}},
                      args.json, EXIT_USAGE)
    if args.max_iter < 1:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "usage-error",
                       "error": {"code": "invalid-max-iter", "message": "--max-iter 必须 >= 1"}},
                      args.json, EXIT_USAGE)
    if args.interference is not None:
        return run_interference_only(args)
    if args.validate_only:
        return run_validate_only(args)
    return _run_fit(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
