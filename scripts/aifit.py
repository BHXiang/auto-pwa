#!/usr/bin/env python3
"""aifit.py — AI-first ctpwa fit driver（JSON 诊断聚合器）.

ctpwa 契约的"包装层"实现（PLAN-STEP2 §1.3，引擎零改动）：
  1. config 校验 API（不跑 GPU）：DecayInfo(config) -> --validate-only JSON
  2. fit 完成 JSON 诊断：NLL / 参数±误差 / 撞边界 / 正定性 / 分波贡献
  3. 结构化错误码：{code, message} + 非零退出码
  5. 短拟合模式：--runs 1 --max-iter 500（多候选并行的时间基础）
  （v2：用 getSLAmpsTensor 算成对干涉项，未实现）

用法（cwd = 迭代目录，analysis() 从 cwd 读 config.yml，同 fit.py）：
  <ctpwa env>/bin/python aifit.py [--config config.yml] [--validate-only] \\
      [--runs N] [--max-iter M] [--seed S] [--json results/fit.json]

输出（默认 results/）：
  fit.json                本文件（机器/AI 主通道，schema 见 README）
  weight_best.root        权重文件（auto_pwa_evaluate 用）
  nll_history.txt         每 run 的 NLL 历史（人看）
  optimization_summary.txt 兼容摘要（旧工具回退通道）

环境变量默认值（被 CLI 覆盖）：PWA_AIFIT_RUNS（默认 10）、PWA_AIFIT_MAX_ITER（默认 10000）。

退出码：0 ok | 1 config-error | 2 usage-error | 3 no-gpu | 4 fit-failed。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback

# torch 必须先于 ctpwa import（libc10 加载顺序，见 PLAN-STEP1）。
import torch
import numpy as np

EXIT_OK = 0
EXIT_CONFIG = 1
EXIT_USAGE = 2
EXIT_NO_GPU = 3
EXIT_FIT_FAILED = 4

SCHEMA_VERSION = "0.1.0"

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
    return p.parse_args(argv)


def write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
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
    return {
        "valid": bool(di.isValid()),
        "path": config_path,
        "nAmplitudes": int(di.nAmplitudes()),
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
    return finish({
        "schemaVersion": SCHEMA_VERSION,
        "status": "ok" if view["valid"] else "config-error",
        "config": view,
        "error": None if view["valid"] else {
            "code": "config-invalid", "message": f"DecayInfo.isValid() = false for {args.config}",
        },
    }, args.json, EXIT_OK if view["valid"] else EXIT_CONFIG)


# ---------------------------------------------------------------------------
# 2. 拟合（复刻 fit.py 的优化器：归一化空间 LBFGS + Hessian 误差）
# ---------------------------------------------------------------------------

def generate_initial_params(n_coupling_free: int, free_res_info: torch.Tensor, seed: int, device: str) -> torch.Tensor:
    n_res = free_res_info.shape[1]
    n_total = 2 * n_coupling_free + n_res
    params = torch.zeros(n_total, dtype=torch.float64, device=device)
    torch.manual_seed(seed)
    params[0] = 1.0  # 固定参考振幅实部
    for idx in range(1, n_coupling_free):
        amp = torch.rand(1, device=device).item() * 0.5
        phase = torch.rand(1, device=device).item() * 2 * torch.pi
        params[idx] = amp * np.cos(phase)
    params[n_coupling_free] = 0.0  # 固定参考振幅虚部
    for idx in range(1, n_coupling_free):
        amp = torch.rand(1, device=device).item() * 0.5
        phase = torch.rand(1, device=device).item() * 2 * torch.pi
        params[n_coupling_free + idx] = amp * np.sin(phase)
    if n_res > 0:
        init_vals = free_res_info[0].to(device=device, dtype=torch.float64)
        if seed > 42:
            torch.manual_seed(seed)
            lower = free_res_info[1].to(device=device, dtype=torch.float64)
            upper = free_res_info[2].to(device=device, dtype=torch.float64)
            noise = (torch.rand(n_res, device=device, dtype=torch.float64) - 0.5) * 0.1 * (upper - lower)
            init_vals = torch.clamp(init_vals + noise, lower + 1e-7 * (upper - lower), upper - 1e-7 * (upper - lower))
        params[2 * n_coupling_free:] = init_vals
    return params


class AifitOptimizer:
    """单次/多次 LBFGS 拟合 + Hessian 诊断（与 fit.py 数值等价）。"""

    def __init__(self, ana, free_res_info: torch.Tensor, params_names: list[str]):
        self.ana = ana
        self.params_names = params_names
        self.device = "cuda"
        self.n_coupling_free = ana.getNVector()
        self.n_res_free = int(free_res_info.shape[1])
        self.n_params = 2 * self.n_coupling_free + self.n_res_free
        self.has_free_res = self.n_res_free > 0
        if self.has_free_res:
            self._lower = free_res_info[1].to(dtype=torch.float64, device=self.device)
            self._upper = free_res_info[2].to(dtype=torch.float64, device=self.device)
            self._res_init = free_res_info[0].to(dtype=torch.float64, device=self.device)

    # -- 与 fit.py compute_loss_and_grad 一致 ---------------------------------
    def compute_loss_and_grad(self, params_norm: torch.Tensor):
        with torch.no_grad():
            params_norm.data[0] = 1.0
            params_norm.data[self.n_coupling_free] = 0.0
        if self.has_free_res:
            res_start = 2 * self.n_coupling_free
            with torch.no_grad():
                phys = self._res_init * (1.0 + params_norm.data[res_start:])
                params_norm.data[res_start:] = (torch.clamp(phys, self._lower, self._upper) - self._res_init) / self._res_init
        if self.has_free_res:
            res_start = 2 * self.n_coupling_free
            phys_res = self._res_init * (1.0 + params_norm[res_start:])
            params_phys = torch.cat([params_norm[:self.n_coupling_free], params_norm[self.n_coupling_free:res_start], phys_res])
        else:
            params_phys = params_norm
        nll = self.ana.getNLL(params_phys)
        grad_norm = torch.autograd.grad(nll, params_norm, retain_graph=False)[0]
        with torch.no_grad():
            grad_norm[0] = 0.0
            grad_norm[self.n_coupling_free] = 0.0
        return nll, grad_norm

    def optimize_single_run(self, initial_params: torch.Tensor, run_id: int = 0, max_iter: int = 10000) -> dict:
        params = initial_params.clone().detach()
        if self.has_free_res:
            res_start = 2 * self.n_coupling_free
            params[res_start:] = (params[res_start:] - self._res_init) / self._res_init
        params.requires_grad_(True)
        optimizer = torch.optim.LBFGS([params], lr=1.0, max_iter=max_iter,
                                      tolerance_grad=1e-8, tolerance_change=1e-10,
                                      history_size=100, line_search_fn="strong_wolfe")
        nll_history: list[float] = []

        def closure():
            optimizer.zero_grad()
            nll, grad = self.compute_loss_and_grad(params)
            params.grad = grad
            nll_history.append(nll.item())
            return nll

        t0 = time.time()
        optimizer.step(closure)
        fit_time = time.time() - t0
        with torch.no_grad():
            params.data[0] = 1.0
            params.data[self.n_coupling_free] = 0.0
            if self.has_free_res:
                res_start = 2 * self.n_coupling_free
                phys = self._res_init * (1.0 + params.data[res_start:])
                params.data[res_start:] = (torch.clamp(phys, self._lower, self._upper) - self._res_init) / self._res_init
        final_nll = nll_history[-1] if nll_history else float("inf")
        final_params = params.clone().detach()
        if self.has_free_res:
            res_start = 2 * self.n_coupling_free
            final_params[res_start:] = self._res_init * (1.0 + final_params[res_start:])

        hessian_full = self.ana.getHessian(final_params)
        fixed_mask = torch.ones(self.n_params, dtype=torch.bool, device=self.device)
        fixed_mask[0] = False
        fixed_mask[self.n_coupling_free] = False
        hessian = hessian_full[fixed_mask][:, fixed_mask]

        try:
            eigenvalues = torch.linalg.eigvalsh(hessian)
            is_pos_def = bool(torch.all(eigenvalues > 0).item())
            min_eig = float(eigenvalues[0].item())
            max_eig = float(eigenvalues[-1].item())
            cond_num = max_eig / min_eig if min_eig > 0 else float("inf")
        except Exception:
            is_pos_def, min_eig, max_eig, cond_num = False, float("nan"), float("nan"), float("nan")

        coupling_real_errors = coupling_imag_errors = res_errors = None
        if is_pos_def:
            try:
                covariance = torch.linalg.inv(hessian)
                std_dev = torch.sqrt(torch.diag(covariance))
                n_c_var = self.n_coupling_free - 1
                coupling_real_errors = torch.zeros(self.n_coupling_free, dtype=torch.float32, device=self.device)
                coupling_imag_errors = torch.zeros(self.n_coupling_free, dtype=torch.float32, device=self.device)
                for i in range(n_c_var):
                    coupling_real_errors[i + 1] = std_dev[2 * i].float()
                    coupling_imag_errors[i + 1] = std_dev[2 * i + 1].float()
                if self.has_free_res:
                    res_errors = std_dev[2 * n_c_var:].float()
            except Exception:
                coupling_real_errors = coupling_imag_errors = res_errors = None

        return {
            "run_id": run_id,
            "final_params": final_params,
            "final_nll": final_nll,
            "nll_history": nll_history,
            "time": fit_time,
            "iterations": len(nll_history),
            "is_positive_definite": is_pos_def,
            "min_eigenvalue": min_eig,
            "condition_number": cond_num,
            "coupling_real_errors": coupling_real_errors,
            "coupling_imag_errors": coupling_imag_errors,
            "res_errors": res_errors,
        }

    def extract_coupling_complex(self, params: torch.Tensor) -> torch.Tensor:
        real = params[:self.n_coupling_free].float()
        imag = params[self.n_coupling_free:2 * self.n_coupling_free].float()
        return torch.complex(real, imag)

    def extract_theta_phys(self, params: torch.Tensor) -> torch.Tensor | None:
        return None if not self.has_free_res else params[2 * self.n_coupling_free:]


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


def build_best_json(opt: AifitOptimizer, result: dict, warnings: list[str]) -> dict:
    params: list[dict] = []
    coupling = opt.extract_coupling_complex(result["final_params"])
    coupling_np = coupling.cpu().numpy()
    re_err = result["coupling_real_errors"]
    im_err = result["coupling_imag_errors"]
    for fi in range(opt.n_coupling_free):
        entry: dict = {
            "name": opt.params_names[fi],
            "kind": "coupling",
            "real": float(coupling_np[fi].real),
            "imag": float(coupling_np[fi].imag),
            "realError": _num(re_err, fi),
            "imagError": _num(im_err, fi),
        }
        params.append(entry)
    if opt.has_free_res:
        theta = opt.extract_theta_phys(result["final_params"]).cpu().numpy()
        lower_np = opt._lower.cpu().numpy()
        upper_np = opt._upper.cpu().numpy()
        res_err = result["res_errors"]
        for j in range(opt.n_res_free):
            idx = opt.n_coupling_free + j
            value = float(theta[j])
            lo, hi = float(lower_np[j]), float(upper_np[j])
            margin = BOUNDARY_FRACTION * (hi - lo)
            at_boundary = value <= lo + margin or value >= hi - margin
            if at_boundary:
                warnings.append(f"{opt.params_names[idx]} = {value:.6g} 贴住 free_range "
                                f"[{lo:.6g}, {hi:.6g}]（撞边界：数据可能不支持该自由度）")
            params.append({
                "name": opt.params_names[idx],
                "kind": "resonance",
                "value": value,
                "error": _num(res_err, j),
                "lower": lo,
                "upper": hi,
                "atBoundary": at_boundary,
            })

    best: dict = {
        "runId": result["run_id"],
        "nll": float(result["final_nll"]),
        "positiveDefinite": bool(result["is_positive_definite"]),
        "minEigenvalue": result["min_eigenvalue"],
        "conditionNumber": result["condition_number"],
        "params": params,
        "fitFractions": None,
        "branchFractions": None,
    }

    # 分波贡献 / 分支比（需要 config 提供 phsp_truth；缺则降级为 null + warning）
    try:
        ff = opt.ana.getFitFractions(coupling)
        names = list(opt.ana.getAmplitudeNames())
        best["fitFractions"] = [
            {"amplitude": names[i] if i < len(names) else f"amp_{i}",
             "fraction": float(ff[i, 0]), "error": float(ff[i, 1])}
            for i in range(ff.shape[0])
        ]
    except Exception as e:
        warnings.append(f"getFitFractions 不可用（需要 config 的 phsp_truth？）: {type(e).__name__}: {e}")
    try:
        bf = opt.ana.getBranchFractions(coupling)
        names = list(opt.ana.getAmplitudeNames())
        best["branchFractions"] = [
            {"amplitude": names[i] if i < len(names) else f"amp_{i}",
             "fraction": float(bf[i, 0]), "error": float(bf[i, 1])}
            for i in range(bf.shape[0])
        ]
    except Exception as e:
        warnings.append(f"getBranchFractions 不可用（需要 config 的 phsp_truth？）: {type(e).__name__}: {e}")
    return best


def _run_fit(args: argparse.Namespace) -> int:
    """完整拟合：多次 LBFGS + Hessian 诊断 -> fit.json（含结构化错误码）。"""
    try:
        import ctpwa  # noqa: F401 — 先 torch 后 ctpwa
    except Exception as e:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "no-gpu",
                       "error": {"code": "ctpwa-import-failed", "message": f"{type(e).__name__}: {e}"}},
                      args.json, EXIT_NO_GPU)
    if not torch.cuda.is_available():
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "no-gpu",
                       "error": {"code": "no-cuda-device",
                                 "message": "ctpwa 仅支持 GPU（CPU 后端未实现）；torch.cuda.is_available() = False"}},
                      args.json, EXIT_NO_GPU)

    workdir = os.path.dirname(os.path.abspath(args.config)) or "."
    if os.path.abspath(workdir) != os.path.abspath(os.getcwd()):
        os.chdir(workdir)  # analysis() 从 cwd 读 config.yml（同 fit.py）

    # 先做无 GPU 校验，失败快速退出（结构化 config-error）。
    try:
        view = config_view(args.config)
    except Exception as e:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "config-error",
                       "config": {"path": args.config, "valid": False},
                       "error": {"code": "config-parse-failed", "message": f"{type(e).__name__}: {e}"}},
                      args.json, EXIT_CONFIG)
    if not view["valid"]:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "config-error",
                       "config": view,
                       "error": {"code": "config-invalid", "message": f"DecayInfo.isValid() = false for {args.config}"}},
                      args.json, EXIT_CONFIG)

    t_start = time.time()
    ana = ctpwa.analysis()
    free_res_info = ana.getFreeResParams()
    params_names = list(ana.getParamNames())
    opt = AifitOptimizer(ana, free_res_info, params_names)
    warnings: list[str] = []
    runs_json: list[dict] = []
    best_full: dict | None = None
    os.makedirs("results", exist_ok=True)  # nll_history/fit.json/weight_best.root 的落点

    for i in range(args.runs):
        seed = args.seed if i == 0 else args.seed + i
        initial = generate_initial_params(opt.n_coupling_free, free_res_info, seed=seed, device=opt.device)
        try:
            result = opt.optimize_single_run(initial, run_id=i, max_iter=args.max_iter)
            runs_json.append({
                "runId": i,
                "nll": float(result["final_nll"]),
                "iterations": result["iterations"],
                "timeSec": round(result["time"], 2),
                "positiveDefinite": bool(result["is_positive_definite"]),
                "minEigenvalue": result["min_eigenvalue"],
            })
            if best_full is None or result["final_nll"] < best_full["final_nll"]:
                best_full = result
            # 人读 NLL 历史（兼容旧工具链）
            with open("results/nll_history.txt", "a" if i > 0 else "w") as f:
                if i == 0:
                    f.write(f"# NLL History - aifit.py runs={args.runs} max_iter={args.max_iter}\n")
                f.write(f"# RUN: run_{i}\n")
                for j, v in enumerate(result["nll_history"]):
                    f.write(f"{j:8d}  {v:15.8f}\n")
        except Exception as e:
            runs_json.append({"runId": i, "error": f"{type(e).__name__}: {e}"})
            warnings.append(f"run {i} 失败: {type(e).__name__}: {e}")
            traceback.print_exc()

    ok_runs = [r for r in runs_json if "error" not in r]
    if not ok_runs:
        return finish({"schemaVersion": SCHEMA_VERSION, "status": "fit-failed",
                       "config": view, "error": {"code": "all-runs-failed",
                       "message": f"{args.runs} 次运行全部失败；见 fit.log 与各 run 的 error 字段"}},
                      args.json, EXIT_FIT_FAILED)

    best_summary = min(ok_runs, key=lambda r: r["nll"])
    best_json = build_best_json(opt, best_full, warnings)
    best_json["runId"] = best_full["run_id"]
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
            "timeSec": round(time.time() - t_start, 2),
            "runSummaries": runs_json,
            "best": best_json,
            "warnings": warnings,
        },
        "error": None,
    }

    # 保存权重文件（auto_pwa_evaluate 用）；失败只降级 warning。
    try:
        if opt.has_free_res:
            opt.ana.reCalcAmp(opt.extract_theta_phys(best_full["final_params"]))
        opt.ana.writeResult(best_full["final_params"], "results/weight_best.root", 0)
    except Exception as e:
        out["fit"]["warnings"].append(f"writeResult 失败（weight_best.root 未生成）: {type(e).__name__}: {e}")

    # 干涉矩阵：直接从刚写出的 weight_best.root 读取（引擎已算好，读回即可；
    # 不做 getSLAmpsTensor 全波表——太大易崩）。矩阵不可信时降级 warning。
    interference = read_interference_from_root("results/weight_best.root")
    if interference["available"]:
        out["fit"]["interference"] = interference
    else:
        out["fit"]["interference"] = interference
        out["fit"]["warnings"].append(f"干涉矩阵不可用: {interference['reason']}")

    # 兼容旧工具链的人读摘要（fit-summary.ts 的 fallback 解析路径）
    try:
        with open("results/optimization_summary.txt", "w") as f:
            f.write("PWA优化结果 (aifit.py)\n")
            f.write("=" * 100 + "\n")
            f.write(f"总运行次数: {len(ok_runs)}\n")
            f.write(f"耦合参数数量: {opt.n_coupling_free}\n")
            f.write(f"自由共振态参数: {opt.n_res_free}\n")
            f.write(f"最佳NLL: {best_summary['nll']:.6f}\n")
            f.write("参数文件: fit.json（机器/AI 主通道）\n")
            f.write("NLL历史: nll_history.txt\n\n")
            f.write("运行结果 (按NLL排序):\n")
            f.write(f"{'排名':<4} {'运行ID':<6} {'NLL':<12} {'迭代':<8} {'正定':<6}\n")
            for rank, r in enumerate(sorted(ok_runs, key=lambda x: x["nll"])):
                f.write(f"{rank + 1:<4} {r['runId']:<6} {r['nll']:<12.6f} "
                        f"{r.get('iterations', 0):<8} {str(r.get('positiveDefinite')):<6}\n")
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
