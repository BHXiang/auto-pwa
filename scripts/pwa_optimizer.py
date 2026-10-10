#!/usr/bin/env python3
"""pwa_optimizer — ctpwa 拟合优化器核心（自 example/fit.py vendored，MIT）。

为什么存在: aifit.py 需要与 ctpwa example/fit.py **同一套**优化器，才能拿到后者
修掉的一批优化过程 bug。example/fit.py 是脚本（import 期即构造 ctpwa.analysis），
无法当模块复用，因此这里把与 ctpwa 引擎无关的**纯优化器内核**原样 vendor 进
auto-pwa（ctpwa 亦为 MIT，见 ctpwa/LICENSE）。

相对 aifit.py 旧内联优化器的关键修正（对应 ctpwa 提交 b7865bc / a39?46d5 /
fb1b7b8 的 bug 修复）:
  1. 有界优化不再用 "torch LBFGS + 就地 clamp + 梯度清零"（会在边界静默伪收敛，
     且旧梯度投影符号写反、参数贴边后再也回不来）；默认走 reparam 重参数化软墙
     （耦合极坐标 amp=amp_max·sigmoid(u)，共振态 theta=lo+(hi-lo)·sigmoid(u)），
     另提供 projected（投影梯度 KKT + 活跃集 + 可行 Armijo）与 legacy lbfgs 对照。
  2. 耦合幅度加界（v_max / reparam amp_max 软墙），杜绝无界增长到 1e14 导致振幅溢出。
  3. 二阶 polish（阻尼 LM + 活跃集 + gain-ratio + Armijo），把多起点最优解再收敛一步。
  4. 参数误差只在**非活跃子空间**上判正定并求逆：被 free_range 钉住的参数报 NaN，
     不再给出被边界截断的伪误差。
  5. Hessian 缓存：同一最佳点只算一次。

只保留 e2e 拟合需要的部分；example/fit.py 里的绘图/摘要/断点续跑等
（save_parameters / run_multiple_optimizations / print_* / save_*）不在此处。

如 ctpwa 的 example/fit.py 再有优化器修复，请以它为准同步本文件。
"""
from __future__ import annotations

import os
import time
import logging

import numpy as np
import torch

log = logging.getLogger("pwa-fit")

__all__ = [
    "UnifiedPWAOptimizer",
    "projected_lbfgs",
    "_reparam_pack",
    "_reparam_unpack",
]


# --- 环境变量读取（FIT_*，与 example/fit.py 同默认值） ---
def _env_float(name, default):
    """从环境变量读 float，不存在则返回 default。"""
    v = os.environ.get(name)
    return float(v) if v is not None else default


def _env_int(name, default):
    """从环境变量读 int，不存在则返回 default。"""
    v = os.environ.get(name)
    return int(v) if v is not None else default


def _env_bool(name, default):
    """从环境变量读 bool（"1"/"true"/"yes" → True），不存在则返回 default。"""
    v = os.environ.get(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes")


def _env_str(name, default=""):
    """从环境变量读字符串，不存在则返回 default。"""
    return os.environ.get(name, default)

# ============================================================
# projected L-BFGS（有界优化对照路径，逐字来自 example/fit.py）
# ============================================================
def projected_lbfgs(f_grad, x0, lo, hi, m=20, max_iter=500,
                    gtol=1e-8, ftol=1e-12, max_ls=25, record=None,
                    verbose=False, profile=False, twoloop="batched",
                    names=None):
    """盒约束 [lo, hi] 上的 L-BFGS：投影梯度活跃集 + 可行 Armijo 线搜索。

    与 `torch.optim.LBFGS + clamp + 梯度清零` 的四点本质区别：
      1. 停机判据用**投影梯度** pg = P(x-g) - x 的无穷范数（‖pg‖=0 ⟺ KKT），
         不会被"清零后的梯度"骗成伪收敛；
      2. 活跃集（贴边且下降方向朝外）从拟牛顿方向中剔除（对应分量置 0），
         冻结坐标不再向自由坐标泄漏伪曲率；
      3. 步长先夹到第一个撞界拐点 t_max，在 [0, t_max] 内 x+t·d 严格不越界，
         目标函数沿搜索路径光滑 → Armijo 线搜索的假设成立（不需要任何 clamp）；
      4. 曲率对 (s,y) 仅在 yᵀs > 1e-10·|s||y| 时保留，保证 H 近似正定。

    f_grad(x) -> (f: float, g: Tensor)：必须返回**真实**目标值与梯度，
    不得修改 x、不得 clamp（边界由本函数负责）。

    lo/hi 与 x0 同 device/dtype；固定参数用 lo == hi 表示。
    record : 可选 list，每次函数求值的 f 会 append 进去。

    返回 (x, f, status)，status ∈
      'projected-gradient' 真 KKT 收敛
      'no-descent'          找不到下降方向（可能落在鞍点 → 该上二阶 polish）
      'ftol'                函数值相对下降小于 ftol
      'max-iter'            到达迭代上限

    性能（本版）:
      * 曲率历史常驻 (m, n) 缓冲 + 有效长度 k_hist（替代 [(s,y,rho)] 列表）；
      * two-loop 用**闭式三角求解**（第一/第二循环分别是严格上/下三角系统），
        two-loop 本身 ~110 op/次且与 m 无关；逐对 torch.dot 在 m=50 时 ≈760 op
        （GPU 上每个 op ≈ 一次 kernel launch，是主要固定开销）。整迭代
        850 → 373 ATen op（m=50），即 ≈2.3x，且不再随 m 增长；
      * 非 verbose 时不算 n_active、用浮点掩码替代布尔索引散播 + 去掉
        blocked.any()（实测 device sync 7.16 → 6.14 次/迭代）；
      * profile=True 打印 eval/house 耗时占比（env: FIT_OPT_PROF=1）。
    """
    dev, dt = x0.device, x0.dtype
    x = torch.clamp(x0.clone(), lo, hi)
    # 曲率历史: 常驻 (m, n) 缓冲（等价原 [(s, y, rho)] 列表）
    n_dim = x.numel()
    S_buf = torch.empty((m, n_dim), device=dev, dtype=dt)
    Y_buf = torch.empty_like(S_buf)
    R_buf = torch.empty((m,), device=dev, dtype=dt)
    # 滚动用的第二组缓冲（history 满时把 S[1:] 拷进 S2[:-1] 后交换，避免
    # 同张量重叠切片 copy_ 触发 "single memory location" 报错）
    S_buf2 = torch.empty_like(S_buf)
    Y_buf2 = torch.empty_like(S_buf)
    R_buf2 = torch.empty_like(R_buf)
    k_hist = 0
    I_buf = torch.eye(m, device=dev, dtype=dt)   # 闭式 two-loop 的三角求解用
    mask_f = torch.empty_like(x)                 # 自由分量浮点掩码（免布尔散播/同步）
    ratio = torch.empty_like(x)                  # 撞界拐点缓冲（每轮只 fill_）

    t_eval = 0.0        # f_grad 累计耗时（profile=True）
    n_eval = 0
    t_loop = time.perf_counter() if profile else 0.0
    diag = {"trials": {}, "fallback": 0, "restart_ls": 0, "restart_nod": 0,
            "restart_step0": 0, "restart_stall": 0, "capped": 0, "max_ls_hit": 0,
            }
    slow_log = []       # profile=True 时记录"多试探迭代"的方向结构（只读诊断）
    gam_val = float("nan")

    def call(z):
        nonlocal t_eval, n_eval
        if profile:
            _t0 = time.perf_counter()
        fv, gv = f_grad(z)
        if profile:
            t_eval += time.perf_counter() - _t0
            n_eval += 1
        if record is not None:
            record.append(fv)
        return fv, gv

    f, g = call(x)
    status = "max-iter"
    n_active = 0
    restarts = 0        # 线搜索失败/方向退化时清空曲率历史重启的次数
    tiny_streak = 0     # 连续"ΔNLL≈0"的迭代数（不当作收敛）
    n_ls_fallback = 0   # 靠"回溯最优点"接受（而非 Armijo）的次数
    w = hi - lo
    thr_edge = 1e-8 * w                          # 贴边判定阈值（与 x 无关，循环外算一次）
    fixed = lo >= hi                             # 固定参数（lo == hi），循环不变量

    if (not torch.isfinite(g).all().item()) or not (f == f and abs(f) != float("inf")):
        # 随机初值发散（梯度/目标非有限）—— 直接判该 run 失败，不要白烧 25 次线搜索
        if verbose:
            print(f"    [pLBFGS] stop: status=nan-start, NLL={f}")
        return x, f, "nan-start"

    for it in range(max_iter):
        # ---- ① 停机判据: 投影梯度 (≡ KKT) ----
        pg = x - torch.clamp(x - g, lo, hi)
        pg_inf = pg.abs().max().item()
        if pg_inf <= gtol:
            status = "projected-gradient"
            break

        # ---- ② 活跃集: 贴边且下降方向 (−g) 朝外 ----
        at_lo = (x - lo) <= thr_edge
        at_hi = (hi - x) <= thr_edge
        active = ((at_lo & (g > 0)) | (at_hi & (g < 0))) & (~fixed)
        free = ~(active | fixed)
        # n_active 只服务于 verbose 日志 —— 非 verbose 时不付这次 device sync
        n_active = int(active.sum().item()) if verbose else 0
        if not bool(free.any()):
            status = "projected-gradient"       # 全部是活跃约束 → 已是 KKT
            break

        # ---- ③ 方向: two-loop recursion（冻结分量方向置零） ----
        # 闭式解: 第一循环 (I + R·U)a = R·b、第二循环 (I + R·V)β = R(γc + V a)
        # 都是单位对角三角系统，用两次 solve_triangular + 几个 matmul 完成，
        # 与逐对 torch.dot 的顺序循环**逐元素等价**（实测相对差 ~5e-16）。
        # op 数从 O(m)（m=50 时 ≈760）降到常数 ≈110，且与 m 无关。
        if k_hist == 0:
            d = -g
        elif twoloop == "legacy":
            # A/B 对照用: 逐对 torch.dot 的原始顺序循环（m=50 时 ≈760 op/次）。
            # rho 取回 Python float，保持与原实现算子数一致（多一次同步可忽略）。
            rho_l = R_buf[:k_hist].tolist()
            q = g.clone()
            alphas = []
            for i in range(k_hist - 1, -1, -1):
                a = rho_l[i] * torch.dot(S_buf[i], q)
                alphas.append(a)
                q = q - a * Y_buf[i]
            s_l, y_l = S_buf[k_hist - 1], Y_buf[k_hist - 1]
            gam_val = float(torch.dot(s_l, y_l) / torch.dot(y_l, y_l))
            q = q * gam_val
            r = q
            for i in range(k_hist):
                a = alphas[k_hist - 1 - i]
                b = rho_l[i] * torch.dot(Y_buf[i], r)
                r = r + S_buf[i] * (a - b)
            d = -r
        else:
            S = S_buf[:k_hist]
            Y = Y_buf[:k_hist]
            R = R_buf[:k_hist]
            M = S @ Y.t()                       # M_ij = s_i·y_j
            I = I_buf[:k_hist, :k_hist]
            a = torch.linalg.solve_triangular(
                I + R[:, None] * torch.triu(M, 1),
                (R * (S @ g)).unsqueeze(1), upper=True).squeeze(1)
            q = g - Y.t() @ a
            gam = (torch.dot(S[k_hist - 1], Y[k_hist - 1])
                   / torch.dot(Y[k_hist - 1], Y[k_hist - 1]))
            gam_val = float(gam)
            V = torch.tril(M.t(), -1)           # V_ij = y_i·s_j (j<i)
            be = torch.linalg.solve_triangular(
                I + R[:, None] * V,
                (R * (gam * (Y @ q) + V @ a)).unsqueeze(1), upper=False).squeeze(1)
            d = -(gam * q + S.t() @ (a - be))
        # 非自由分量置零：乘法掩码替代 d[~free]=0.0（1 op、无散播、无 any() 同步）
        # ⚠ 关键: 拟牛顿方向 d 在贴界坐标上可能指向盒外（虽然梯度指向盒内），
        #   这时 ratio=(界−x)/d=0/负 → t_break=0 → **整步被算成 0** → ΔNLL=0
        #   → 被 ftol 误判成收敛（实测: 9 次求值、|pg| 还剩 300 就"收敛"）。
        #   处理: 贴界且方向朝外的分量直接置零（这一步它本来也动不了）。
        blocked = ((at_lo & (d < 0)) | (at_hi & (d > 0))) & free
        free = free & (~blocked)                # 等价原来的 if any(): 置零 + 收窄 free
        mask_f.copy_(free)
        d = d * mask_f
        gtd = torch.dot(g, d)
        if (not bool(torch.isfinite(gtd))) or gtd >= 0:
            d = -pg * mask_f                    # 退化 → 投影最速下降（在界上恒可行）
            gtd = torch.dot(g, d)
            if (not bool(torch.isfinite(gtd))) or gtd >= 0:
                # 曲线历史被污染 → 清空重来（最多 8 次）后再判定失败
                if restarts < 8 and pg_inf > gtol * 1e3:
                    k_hist = 0
                    restarts += 1
                    diag["restart_nod"] += 1
                    continue
                status = "no-descent"
                break
        if not bool(free.any()):
            # 其余方向都在界外 → 用投影最速下降/或已到 KKT
            d = -pg * mask_f
            if float(d.abs().max().item()) <= 0.0:
                status = "projected-gradient"
                break
            gtd = torch.dot(g, d)
            if gtd >= 0:
                status = "no-descent"
                break

        # ---- ④ 初始步长 + 可行步长上限 ----
        # 首轮 d=−g、|g| 可达 1e3~1e6；t0=min(1, 1/|g|_∞) 保证单个坐标首步移动
        # 不超过 1 个单位（量纲合理），避免 t=1 把线搜索炸掉回溯 20+ 次。
        if k_hist > 0:
            t = torch.ones((), device=dev, dtype=dt)
        else:
            t = torch.tensor(min(1.0, 1.0 / max(float(g.abs().max().item()), 1e-30)),
                             device=dev, dtype=dt)
        # 撞界拐点: t_break 会**正好**把那个坐标放到界上（下一步它就变成活跃约束）。
        # 注意不要因为 t_break 极小就去"冻结"该坐标 —— 那会让它永远到不了界。
        ratio.fill_(float("inf"))               # 复用缓冲（原来每轮 full_like 分配）
        pos = free & (d > 0)
        neg = free & (d < 0)
        ratio[pos] = (hi - x)[pos] / d[pos]
        ratio[neg] = (lo - x)[neg] / d[neg]
        t_break = ratio.min().item()
        capped = False
        if t_break < 1.0:
            t = torch.minimum(t, torch.tensor(max(t_break, 0.0), device=dev, dtype=dt))
            capped = True
            diag["capped"] += 1
        t = t.clamp(min=0.0, max=1.0)

        # ---- ⑤ Armijo 回溯（试试点一律 clamp 回盒内） ----
        accepted = False
        xn = x
        fn = f
        gn = g
        best_trial = None            # (fn, xn, gn, t) —— 回溯中目标最低的点
        n_trials = 0
        for _ in range(max_ls):
            xn = torch.clamp(x + t * d, lo, hi)
            fn, gn = call(xn)
            n_trials += 1
            if best_trial is None or fn < best_trial[0]:
                best_trial = (fn, xn, gn, t)
            if fn <= f + 1e-4 * t.item() * gtd.item():
                accepted = True
                break
            t = t * 0.5
        diag["trials"][n_trials] = diag["trials"].get(n_trials, 0) + 1
        if n_trials == max_ls:
            diag["max_ls_hit"] += 1
        if profile and n_trials >= 8:
            # 只读诊断: 多试探迭代的方向结构（哪几个坐标把 |d|∞ 顶起来了）
            absd = d.abs()
            top = torch.topk(absd, k=min(3, absd.numel()))
            slow_log.append({
                "it": it, "trials": n_trials,
                "d_inf": float(top.values[0].item()),
                "t_acc": float(t.item()),
                "gtd": float(gtd.item()),
                "gam": gam_val,
                "top": [(int(i), float(v), float(g[i].item()),
                         bool((x[i] <= lo[i] + thr_edge[i])
                              or (x[i] >= hi[i] - thr_edge[i])))
                        for v, i in zip(top.values, top.indices)],
            })
        if not accepted:
            # 数值噪声底上 Armijo 可能永远无法满足（真下降被噪声掩盖）——
            # 标准做法是取回溯中"最好的点"，而不是判失败（torch 的
            # strong_wolfe 也是返回 bracket 最优点）。
            if best_trial is not None and best_trial[0] < f:
                fn, xn, gn, t = best_trial
                accepted = True
                n_ls_fallback += 1
                diag["fallback"] += 1
            elif restarts < 8 and pg_inf > gtol * 1e3:
                k_hist = 0
                restarts += 1
                diag["restart_ls"] += 1
                if verbose:
                    print(f"    [pLBFGS] it{it}: 线搜索无下降 → 清空曲率历史重启 "
                          f"({restarts}/8)")
                continue
            else:
                status = "no-descent"
                break

        # ---- ⑥ 曲率对（正定保护） ----
        s = xn - x
        y = gn - g
        ys = torch.dot(y, s)
        if ys > 1e-8 * s.norm() * y.norm():
            if k_hist < m:
                S_buf[k_hist] = s.detach()
                Y_buf[k_hist] = y.detach()
                R_buf[k_hist] = 1.0 / ys.item()
                k_hist += 1
            elif m > 0:
                # 滚动: 丢掉最旧一对（等价 hist.pop(0)），尾部写入新对
                S_buf2[:-1].copy_(S_buf[1:])
                Y_buf2[:-1].copy_(Y_buf[1:])
                R_buf2[:-1].copy_(R_buf[1:])
                S_buf2[m - 1] = s.detach()
                Y_buf2[m - 1] = y.detach()
                R_buf2[m - 1] = 1.0 / ys.item()
                S_buf, S_buf2 = S_buf2, S_buf
                Y_buf, Y_buf2 = Y_buf2, Y_buf
                R_buf, R_buf2 = R_buf2, R_buf

        df = f - fn
        step_inf = float((t * d).abs().max().item())
        x, f, g = xn.detach(), fn, gn
        if verbose:
            print(f"    [pLBFGS] it{it:4d}  NLL={f:.6f}  Δ={-df:+.3e}  "
                  f"|pg|={pg_inf:.2e}  t={t.item():.2e}  active={n_active}"
                  f"{'  [capped]' if capped else ''}")
        # ---- ⑦ 停机判据 ----
        # 唯一合法的收敛判据是 ① 投影梯度→0（KKT）。"一步几乎没进展"可能只是
        # 步长被截断/方向退化/噪声底，不能当作收敛：改为累计 stall，并周期性
        # 清空曲率历史重启；连续 stall 很多次才以 'stalled' 退出（明确不是收敛）。
        if step_inf <= 0.0:
            if restarts < 8:
                k_hist = 0
                restarts += 1
                diag["restart_step0"] += 1
                continue
            status = "stalled"
            break
        if df <= ftol * max(1.0, abs(f)):
            tiny_streak += 1
            if tiny_streak % 3 == 0 and restarts < 8:
                k_hist = 0              # 停滞 → 换个 H 近似再试
                restarts += 1
                diag["restart_stall"] += 1
                continue
            if tiny_streak >= 30:
                status = "stalled"      # 明确不是"收敛"
                break
        else:
            tiny_streak = 0

    if verbose:
        print(f"    [pLBFGS] stop: status={status}, NLL={f:.6f}, "
              f"active={n_active}, iter={it + 1}, evals={len(record) if record is not None else -1}")
    if profile:
        n_it = it + 1 if max_iter > 0 else 0
        t_house = time.perf_counter() - t_loop - t_eval
        tot = max(t_eval + t_house, 1e-9)
        print(f"    [pLBFGS-prof] iters={n_it} evals={n_eval}  "
              f"eval={t_eval:.3f}s ({t_eval / max(n_eval, 1) * 1e3:.3f} ms/eval, "
              f"{100 * t_eval / tot:.1f}%)  "
              f"house={t_house:.3f}s ({t_house / max(n_it, 1) * 1e3:.3f} ms/iter, "
              f"{100 * t_house / tot:.1f}%)  "
              f"{n_eval / max(n_it, 1):.2f} eval/iter")
        tr = diag["trials"]
        hist = " ".join(f"{k}次×{tr[k]}" for k in sorted(tr))
        print(f"    [pLBFGS-diag] 线搜索试探分布: {hist}")
        print(f"    [pLBFGS-diag] fallback={diag['fallback']} "
              f"max_ls 打满={diag['max_ls_hit']} 撞界cap={diag['capped']} "
              f"重启(线搜索)={diag['restart_ls']} 重启(无下降)={diag['restart_nod']} "
              f"重启(步长为0)={diag['restart_step0']} 重启(停滞)={diag['restart_stall']}")
        if slow_log:
            print(f"    [pLBFGS-slow] 多试探迭代 {len(slow_log)} 次（≥8 次试探），"
                  f"方向由哪些坐标顶起：")
            for r in slow_log[:30]:
                tops = "  ".join(
                    f"{(names[i] if names and i < len(names) else i)}"
                    f"(|d|={v:.2e},|g|={gv:.2e}{',贴边' if bnd else ''})"
                    for i, v, gv, bnd in r["top"])
                print(f"      it={r['it']:4d} trials={r['trials']:2d} "
                      f"t_acc={r['t_acc']:.2e} γ={r['gam']:.3e} "
                      f"gtd={r['gtd']:.3e} | {tops}")
    return x, f, status


# ============================================================
# 重参数化（reparam，默认路径，逐字来自 example/fit.py）
# ============================================================
_REPARAM_EPS = 1e-12


def _reparam_pack(params, nc, n_res, lower, upper, amp_max, eps=_REPARAM_EPS):
    """物理参数 -> 无约束 u。params: [re(nc) | im(nc) | theta(n_res)]。

    nc 为耦合复数个数（index 0 是固定参考）；n_res 为自由共振态参数个数。
    lower/upper 为共振态参数上下界（n_res>0 时必须给出）。
    耦合用极坐标 + sigmoid 软墙 amp=amp_max·sigmoid(u_amp)（S1）：
    小幅度区 ≈ exp(u_amp)（尺度不变），接近 amp_max 时 dρ/du→0 自限幅。
    """
    dtype, device = params.dtype, params.device
    re = params[1:nc]
    im = params[nc + 1:2 * nc]
    amp = torch.sqrt(re * re + im * im)
    phi = torch.atan2(im, re)
    s = (amp / amp_max).clamp(min=eps, max=1.0 - eps)
    u = [torch.log(s / (1.0 - s)), phi]
    if n_res > 0:
        lower = lower.to(dtype=dtype, device=device)
        upper = upper.to(dtype=dtype, device=device)
        span = (upper - lower).clamp(min=eps)
        sres = ((params[2 * nc:] - lower) / span).clamp(min=eps, max=1.0 - eps)
        u.append(torch.log(sres / (1.0 - sres)))
    return torch.cat(u)


def _reparam_unpack(u, nc, n_res, lower, upper, amp_max,
                    dtype=torch.float64, device="cpu"):
    """无约束 u -> 物理参数（对 u 可微，供 autograd 链式法则）。

    amp = amp_max·sigmoid(u_amp) ∈ (0, amp_max)：小幅度区 ≈ exp(u_amp)，
    接近上限时梯度→0（自限幅，防对数幅度自加速失控，S1）；theta 用
    sigmoid 落在 (lo, hi) 内。
    """
    k = nc - 1
    if amp_max and amp_max > 0:
        amp = amp_max * torch.sigmoid(u[:k])
    else:
        amp = torch.exp(u[:k])
    phi = u[k:2 * k]
    re = amp * torch.cos(phi)
    im = amp * torch.sin(phi)
    parts = [torch.ones(1, dtype=dtype, device=device), re,
             torch.zeros(1, dtype=dtype, device=device), im]
    if n_res > 0:
        lower = lower.to(dtype=dtype, device=device)
        upper = upper.to(dtype=dtype, device=device)
        theta = lower + (upper - lower) * torch.sigmoid(u[2 * k:])
        parts.append(theta)
    return torch.cat(parts)


# ============================================================
# 优化器（逐字来自 example/fit.py UnifiedPWAOptimizer，保留到 compute_efficiency；绘图/摘要方法未 vendor）
# ============================================================
class UnifiedPWAOptimizer:
    def __init__(self, ana, free_res_info, params_names,
                 v_max=None, project_grad=None, optimizer_kind="reparam",
                 amp_max=None, amp_lambda=None):
        self.analysis = ana
        self.params_names = params_names
        self.device = "cuda"
        self.best_nll = float("inf")
        self.best_params = None
        self.all_results = []

        self.n_coupling_free = ana.getNVector()
        self.n_res_free = free_res_info.shape[1]
        self.n_params = 2 * self.n_coupling_free + self.n_res_free
        self.has_free_res = self.n_res_free > 0
        # 保存 free_res_info 供 generate_initial_params 使用
        self._free_res_info = free_res_info
        # 耦合幅度上界（防 LBFGS 放飞，实测随机初值放开共振态参数时
        # 耦合会无界增长到 1e14 → 振幅溢出）+ 投影梯度（防边界伪收敛）。
        # ⚠️ 默认 10000 而不能更小: 不同波的振幅归一化差异极大
        # （ONE 模型/弱归一化波如 PHSP 需要 |v|~300-1000，实测本模型
        # 最佳解 |A| 达 297；v_max=50 会把它们掐死在墙上，模型形状被
        # 强制扭曲 → 拟合直接失败/正 NLL）。
        # 优先级: 构造参数 > FIT_VMAX/FIT_PROJECT 环境变量 > 默认值
        self.v_max = v_max if v_max is not None else float(os.environ.get("FIT_VMAX", "10000.0"))
        _pg = project_grad if project_grad is not None else os.environ.get("FIT_PROJECT", "1")
        self.project_grad = _pg if isinstance(_pg, bool) else str(_pg) == "1"
        # reparam 幅度软墙上限（S1）: amp = amp_max·sigmoid(u_amp)，防对数幅度
        # 沿简并方向自加速失控；小幅度区仍≈exp。默认 1000（实测最佳 |A|≈297）。
        self.amp_max = (amp_max if amp_max is not None
                        else float(os.environ.get("FIT_AMP_MAX", "1000.0")))
        # reparam 幅度罚项（S2）: loss = NLL + λ·Σ|A_i|²，只进优化 loss，
        # 报告 NLL/Hessian 仍用真实 NLL。默认 1e-4（防简并方向漂移到软墙帽）。
        self.amp_lambda = (amp_lambda if amp_lambda is not None
                           else float(os.environ.get("FIT_AMP_LAMBDA", "1e-4")))
        # 优化器种类（默认 "reparam"）:
        #   "reparam" (默认)   = 重参数化软墙（耦合 sigmoid 幅度极坐标 + 共振态
        #                        sigmoid）+ torch LBFGS(strong_wolfe)，无投影/活跃集
        #   "projected"        = projected_lbfgs —— 盒约束优化，状态全在 GPU；
        #                        KKT 判据 gtol=1e-5 本模型达不到 → 常跑到 max-iter
        #   "lbfgs"            = 旧路径 torch.optim.LBFGS + clamp + 投影梯度清零，
        #                        仅用于 A/B 对照（在边界处会静默伪收敛）
        self.optimizer_kind = str(
            optimizer_kind if optimizer_kind is not None
            else os.environ.get("FIT_OPTIMIZER", "reparam")
        ).lower()
        # 每轮打印 projected L-BFGS 的 |pg|/active/ΔNLL（env FIT_OPT_VERBOSE=1）
        self.optimizer_verbose = _env_bool("FIT_OPT_VERBOSE", False)
        # 打印每次 run 的 eval / housekeeping 耗时占比（env FIT_OPT_PROF=1）
        self.optimizer_prof = _env_bool("FIT_OPT_PROF", False)
        # 曲率历史上限（env FIT_OPT_M，默认 50 = 旧行为）。闭式 two-loop 后
        # 每迭代 op 数与 m 几乎无关（实测 m=15/50 都是 ≈376 op/iter），而 m 越大
        # 收敛越快（well-cond: m=15 需 167 轮, m=50 只需 118 轮）→ 不砍 m。
        self.optimizer_m = _env_int("FIT_OPT_M", 50)
        # ---- 归因实验开关（默认 = 当前行为，仅用于 A/B；见 doc/optimizer-ablation-plan.md）----
        # two-loop 实现: batched(默认, 闭式三角求解) / legacy(逐对 torch.dot)
        self.optimizer_twoloop = str(os.environ.get("FIT_OPT_TWOLOOP", "batched")).lower()
        # honest=0: 投影路径也用 clamp + 投影清零梯度（隔离"真实梯度"这一项）
        self.optimizer_honest = _env_bool("FIT_OPT_HONEST", True)
        # legacy_sign=1: legacy 路径恢复旧的（写反的）投影符号，用于精确复现历史行为
        self.optimizer_legacy_sign = _env_bool("FIT_OPT_LEGACY_SIGN", False)
        # polish 步数上限（默认 200；969ad28 基线是 40）
        self.optimizer_polish_steps = _env_int("FIT_OPT_POLISH_STEPS", 200)
        # polish 统计（步数 / Hessian 次数 / 求值次数），供归因日志读取
        self._polish_stats = {}
        # 统一 Hessian 缓存: 同参数点只在第一次真正计算一步 getHessian，
        # 后续（正定性判定/参数误差/分支比误差）直接复用。
        self._hess_cache = None  # (params.clone(), hessian_full)

        # 共振态参数bounds (GPU)
        if self.has_free_res:
            self._lower = free_res_info[1].to(dtype=torch.float64, device=self.device)
            self._upper = free_res_info[2].to(dtype=torch.float64, device=self.device)

    # --------------------------------------------------------
    def generate_initial_params(self, seed=42):
        """生成统一参数向量 [real_coupling | imag_coupling | theta]。

        Layout: [real_0,...,real_{n_free-1}, imag_0,...,imag_{n_free-1},
                 theta_0,...,theta_{n_res-1}]
        real_0=1.0, imag_0=0.0 为固定参考振幅。
        seed=42 时共振态参数取 PDG 初值；seed>42 时在 bounds 内加 10% 噪声。
        """
        free_res_info = self._free_res_info
        n_coupling_free = self.n_coupling_free
        device = self.device

        n_res = free_res_info.shape[1]
        n_total = 2 * n_coupling_free + n_res
        params = torch.zeros(n_total, dtype=torch.float64, device=device)

        torch.manual_seed(seed)

        # 耦合实部
        params[0] = 1.0  # 固定参考
        for idx in range(1, n_coupling_free):
            amplitude = torch.rand(1, device=device).item() * 0.5
            phase = torch.rand(1, device=device).item() * 2 * torch.pi
            params[idx] = amplitude * np.cos(phase)

        # 耦合虚部
        params[n_coupling_free] = 0.0  # 固定参考
        for idx in range(1, n_coupling_free):
            amplitude = torch.rand(1, device=device).item() * 0.5
            phase = torch.rand(1, device=device).item() * 2 * torch.pi
            params[n_coupling_free + idx] = amplitude * np.sin(phase)

        # 共振态参数
        if n_res > 0:
            init_vals = free_res_info[0].to(device=device, dtype=torch.float64)
            if seed > 42:
                torch.manual_seed(seed)
                lower = free_res_info[1].to(device=device, dtype=torch.float64)
                upper = free_res_info[2].to(device=device, dtype=torch.float64)
                noise = (torch.rand(n_res, device=device, dtype=torch.float64) - 0.5) \
                        * 0.1 * (upper - lower)
                init_vals = torch.clamp(init_vals + noise,
                                        lower + 1e-7 * (upper - lower),
                                        upper - 1e-7 * (upper - lower))
            params[2 * n_coupling_free:] = init_vals

        print(f"生成初始参数 (seed={seed}): n_coupling={n_coupling_free}, n_res={n_res}")
        return params

    # --------------------------------------------------------
    def compute_loss_and_grad(self, params, honest=False):
        """计算 NLL 和梯度。params: float64, [n_params]

        honest=False : 兼容旧行为 —— 把参数 clamp 回界内，并把"指向界外"的梯度清零。
                       只给 legacy LBFGS 路径用（torch LBFGS 本身不理解 bounds）。
        honest=True  : 返回**真实梯度**、**不做任何 clamp**。给 projected L-BFGS 用：
                       边界由优化器内部的活跃集 + 可行线搜索处理，
                       这里动 x 或 g 都会破坏其收敛判据。
        """
        nc = self.n_coupling_free
        # 固定参考振幅 (1+0j)：始终钉死
        with torch.no_grad():
            params.data[0] = 1.0
            params.data[nc] = 0.0
        # 防御: projected 路径传进来的可能是普通张量；autograd.grad 需要它可求导
        if not params.requires_grad:
            params.requires_grad_(True)
        if not honest:
            with torch.no_grad():
                params.data[1:nc].clamp_(-self.v_max, self.v_max)
                params.data[nc + 1:2 * nc].clamp_(-self.v_max, self.v_max)
            # 共振态参数有界约束: clamp
            if self.has_free_res:
                with torch.no_grad():
                    start = 2 * nc
                    params.data[start:] = torch.clamp(
                        params.data[start:], self._lower, self._upper
                    )

        nll = self.analysis.getNLL(params)
        grad = torch.autograd.grad(nll, params, retain_graph=False)[0]

        # 固定参数的梯度清零
        with torch.no_grad():
            grad[0] = 0.0
            grad[nc] = 0.0
            # legacy 路径的投影: 冻结条件 = 下降方向 (−grad) 指向盒外
            #   下界 且 grad>0 (想往下)   /   上界 且 grad<0 (想往上)
            # ⚠ 旧版写成 下界&grad<0 / 上界&grad>0，符号反了：那会冻结"从墙上
            #   回到盒内"的**合法下降方向**，使参数一旦贴边就再也回不来
            #   （实测最优解里 4/10 个自由参数钉死在 free_range 边界）。
            if not honest and self.project_grad:
                g_c = grad[1:nc]
                c = params[1:nc]
                g_i = grad[nc + 1:2 * nc]
                ci = params[nc + 1:2 * nc]
                if self.optimizer_legacy_sign:
                    # FIT_OPT_LEGACY_SIGN=1: 精确复现 969ad28 的历史行为（符号写反，
                    # 冻结了"从墙上回到盒内"的合法下降方向）——仅用于归因对照。
                    g_c[(c <= -self.v_max) & (g_c < 0)] = 0.0
                    g_c[(c >= self.v_max) & (g_c > 0)] = 0.0
                    g_i[(ci <= -self.v_max) & (g_i < 0)] = 0.0
                    g_i[(ci >= self.v_max) & (g_i > 0)] = 0.0
                    if self.has_free_res:
                        res_start = 2 * nc
                        g_r = grad[res_start:]
                        phys = params[res_start:]
                        g_r[(phys <= self._lower) & (g_r < 0)] = 0.0
                        g_r[(phys >= self._upper) & (g_r > 0)] = 0.0
                    return nll, grad
                g_c[(c <= -self.v_max) & (g_c > 0)] = 0.0
                g_c[(c >= self.v_max) & (g_c < 0)] = 0.0
                g_i[(ci <= -self.v_max) & (g_i > 0)] = 0.0
                g_i[(ci >= self.v_max) & (g_i < 0)] = 0.0
                if self.has_free_res:
                    res_start = 2 * nc
                    g_r = grad[res_start:]
                    phys = params[res_start:]
                    g_r[(phys <= self._lower) & (g_r > 0)] = 0.0
                    g_r[(phys >= self._upper) & (g_r < 0)] = 0.0

        return nll, grad

    # --------------------------------------------------------
    def bounds(self, like):
        """构造 [lo, hi] 盒约束（与 params 同 device/dtype）。
        固定参数（re_0=1, im_0=0）用 lo==hi 表示。
        """
        lo = torch.full_like(like, -self.v_max)
        hi = torch.full_like(like, self.v_max)
        nc = self.n_coupling_free
        if self.has_free_res:
            s = 2 * nc
            lo[s:] = self._lower.to(like.dtype)
            hi[s:] = self._upper.to(like.dtype)
        lo[0] = hi[0] = 1.0
        lo[nc] = hi[nc] = 0.0
        return lo, hi

    # --------------------------------------------------------
    def optimize_single_run(
        self,
        initial_params,
        run_id=0,
        max_iter=500,
        lr=1.0,
        tolerance_grad=1e-8,
        tolerance_change=1e-10,
        history_size=100,
    ):
        """单次优化"""
        params = initial_params.clone().detach().requires_grad_(True)
        nll_history = []
        opt_status = "lbfgs"

        start_time = time.time()
        if self.optimizer_kind == "projected":
            # ---- 有界 L-BFGS：边界由活跃集 + 可行线搜索处理 ----
            lo, hi = self.bounds(params)

            def f_grad(z):
                # honest=True: 不做 clamp、不动梯度 —— 真实 f 与 g。
                # ⚠ 必须克隆成 requires_grad 的叶子：projected_lbfgs 内部传进来的
                #   是普通张量（无 grad_fn），直接送进 autograd.grad 会报
                #   "element 0 of tensors does not require grad"。
                q = z.detach().clone().requires_grad_(True)
                nll, grad = self.compute_loss_and_grad(q, honest=self.optimizer_honest)
                return nll.item(), grad.detach()

            x, final_nll, opt_status = projected_lbfgs(
                f_grad, params.detach(), lo, hi,
                m=min(int(history_size), int(self.optimizer_m)), max_iter=max_iter,
                gtol=max(tolerance_grad, 1e-10), ftol=1e-12,
                record=nll_history, verbose=(self.optimizer_verbose),
                profile=self.optimizer_prof, twoloop=self.optimizer_twoloop,
                names=self.params_names,
            )
            params = x.detach().requires_grad_(False)
        elif self.optimizer_kind == "reparam":
            # ---- 重参数化 + torch LBFGS(strong_wolfe)：软墙，无投影/活跃集 ----
            nc = self.n_coupling_free
            n_res = self.n_res_free
            if self.has_free_res:
                lower, upper = self._lower, self._upper
            else:
                lower = upper = torch.empty(0, dtype=torch.float64,
                                            device=self.device)

            u = _reparam_pack(params.detach(), nc, n_res, lower, upper,
                              self.amp_max).requires_grad_(True)
            optimizer = torch.optim.LBFGS(
                [u],
                lr=lr,
                max_iter=max_iter,
                tolerance_grad=tolerance_grad,
                tolerance_change=tolerance_change,
                history_size=history_size,
                line_search_fn="strong_wolfe",
            )

            def closure():
                optimizer.zero_grad()
                p = _reparam_unpack(u, nc, n_res, lower, upper, self.amp_max,
                                    dtype=params.dtype, device=params.device)
                nll = self.analysis.getNLL(p)
                loss = nll
                if self.amp_lambda > 0:
                    # S2: 幅度罚项只进优化 loss（参考波 idx0 不计），报告仍用真实 NLL
                    re_c = p[1:nc]
                    im_c = p[nc + 1:2 * nc]
                    loss = nll + self.amp_lambda * (re_c * re_c + im_c * im_c).sum()
                loss.backward()
                nll_history.append(nll.item())        # 记录真实 NLL
                return loss

            optimizer.step(closure)
            final_nll = nll_history[-1] if nll_history else float("inf")
            params = _reparam_unpack(
                u.detach(), nc, n_res, lower, upper, self.amp_max,
                dtype=params.dtype, device=params.device,
            ).detach().requires_grad_(False)
            try:
                n_iter = (optimizer.state_dict().get("state", {})
                          .get(0, {}).get("n_iter", 0))
            except Exception:
                n_iter = 0
            # ⚠ torch LBFGS 的容差停机 ≠ 物理空间 KKT 收敛：本模型实测约半数
            # 起点会在坏盆地"容差停机"（NLL 可比正常解差 100~700）。多起点流程
            # 请以 best-of-N 为准，勿据 status 判定单次结果成功。
            opt_status = ("reparam-max-iter" if n_iter >= max_iter
                          else "reparam-tol-stop")
        else:
            # ---- legacy: torch LBFGS + clamp + 投影梯度清零（A/B 对照用） ----
            optimizer = torch.optim.LBFGS(
                [params],
                lr=lr,
                max_iter=max_iter,
                tolerance_grad=tolerance_grad,
                tolerance_change=tolerance_change,
                history_size=history_size,
                line_search_fn="strong_wolfe",
            )

            def closure():
                optimizer.zero_grad()
                nll, grad = self.compute_loss_and_grad(params)
                params.grad = grad
                nll_history.append(nll.item())
                return nll

            optimizer.step(closure)
            final_nll = nll_history[-1] if nll_history else float("inf")

        end_time = time.time()

        # 最终clamp一次确保共振态参数在界内 + 耦合在 ±v_max 内
        with torch.no_grad():
            params.data[0] = 1.0
            params.data[self.n_coupling_free] = 0.0
            params.data[1:self.n_coupling_free].clamp_(-self.v_max, self.v_max)
            params.data[self.n_coupling_free + 1:2 * self.n_coupling_free].clamp_(
                -self.v_max, self.v_max)
            if self.has_free_res:
                start = 2 * self.n_coupling_free
                params.data[start:] = torch.clamp(params.data[start:], self._lower, self._upper)

        final_params = params.clone().detach()

        # Hessian
        hessian_start = time.time()
        hessian_full = self.analysis.getHessian(final_params)
        # print("hessian矩阵：", hessian_full)
        hessian_time = time.time() - hessian_start
        # 播种缓存: 同一最佳点后续要 Hessian（正定性/误差/分支比）直接复用
        self._hess_cache = (final_params.clone(), hessian_full)

        # 去除固定参数 (index 0 和 n_coupling_free)
        fixed_mask = torch.ones(self.n_params, dtype=torch.bool, device=self.device)
        fixed_mask[0] = False
        fixed_mask[self.n_coupling_free] = False
        hessian = hessian_full[fixed_mask][:, fixed_mask]

        # 特征值分析
        try:
            eigenvalues = torch.linalg.eigvalsh(hessian)
            # print("Hessian特征值：", eigenvalues)
            is_pos_def = bool(torch.all(eigenvalues > 0).item())
            min_eig = eigenvalues[0].item()
            max_eig = eigenvalues[-1].item()
            cond_num = max_eig / min_eig if min_eig > 0 else float("inf")
        except Exception:
            is_pos_def = False
            min_eig = max_eig = cond_num = float("nan")

        # 参数误差
        coupling_real_errors = None
        coupling_imag_errors = None
        res_errors = None
        if is_pos_def:
            try:
                covariance = torch.linalg.inv(hessian)
                std_dev = torch.sqrt(torch.diag(covariance))

                # 耦合参数误差: 前 2*(n_coupling_free-1) 个元素
                n_c_var = self.n_coupling_free - 1  # 扣除固定的
                coupling_real_errors = torch.zeros(
                    self.n_coupling_free, dtype=torch.float32, device=self.device
                )
                coupling_imag_errors = torch.zeros(
                    self.n_coupling_free, dtype=torch.float32, device=self.device
                )

                # std_dev 前 2*n_c_var 个元素: 实部误差和虚部误差交替
                for i in range(n_c_var):
                    coupling_real_errors[i + 1] = std_dev[2 * i].float()
                    coupling_imag_errors[i + 1] = std_dev[2 * i + 1].float()

                # 共振态参数误差
                if self.has_free_res:
                    res_start = 2 * n_c_var
                    res_errors = std_dev[res_start:].float()
            except Exception as e:
                log.error(f"计算参数误差时出错: {e}")

        result = {
            "run_id": run_id,
            "final_params": final_params,
            "final_nll": final_nll,
            "nll_history": nll_history,
            "time": end_time - start_time,
            "optimizer_status": opt_status,
            "hessian_time": hessian_time,
            "iterations": len(nll_history),
            "initial_params": initial_params.clone().detach(),
            "hessian_full": hessian_full,
            "hessian": hessian,
            "is_positive_definite": is_pos_def,
            "min_eigenvalue": min_eig,
            "max_eigenvalue": max_eig,
            "condition_number": cond_num,
            "coupling_real_errors": coupling_real_errors,
            "coupling_imag_errors": coupling_imag_errors,
            "res_errors": res_errors,
        }

        if final_nll < self.best_nll:
            self.best_nll = final_nll
            self.best_params = final_params.clone()
            self.best_result = result

        return result

    # --------------------------------------------------------
    def _project_params_(self, p):
        """把参数向量投影回可行域（固定参考 + 耦合 ±v_max + 共振态 bounds）"""
        with torch.no_grad():
            p.data[0] = 1.0
            p.data[self.n_coupling_free] = 0.0
            p.data[1:self.n_coupling_free].clamp_(-self.v_max, self.v_max)
            p.data[self.n_coupling_free + 1:2 * self.n_coupling_free].clamp_(
                -self.v_max, self.v_max)
            if self.has_free_res:
                res_start = 2 * self.n_coupling_free
                p.data[res_start:].clamp_(self._lower, self._upper)

    # --------------------------------------------------------
    def polish_damped_newton(self, params_phys, max_steps=200, tol=1e-6, lam0=1e-2,
                             tau=1e-8, step_cap=0.5, gtol=1e-6, verbose=True,
                             coup_step_cap=0.1, floor_tol=1e-3, patience=5):
        """二阶 polish: active-set + 缩放阻尼 LM + gain-ratio + Armijo 线搜索。

        tau: 「正定」判定用的**相对噪声底** λ_min > tau·λ_max。
             它不是条件数阈值！浮点振幅(precision:float/hybrid)给出的 Hessian
             相对噪声 ~1e-7，所以取 1e-8 即"明确为正"。
             ⚠ 曾误设 1e-3：那会把 λ_min/λ_max=+1.6e-6 这种**已经正定**的点
             判成"不正定"（条件数差 ≠ 不定），还会让 polish 误以为没到极小、
             沿最平方向空转（trace 里一串 ΔNLL=-0.0000 就是它）。

        相对旧版的四点改动（旧版在强不定 H 上会"巨步→拒绝→微步"空转，40 步烧完
        只前进一点点）:
          1. **活跃集**: 贴边且下降方向朝外的坐标从 Newton 系统里剔除，
             不再被 _project_params_ 夹回而毁掉整个下降方向；
          2. **缩放阻尼** H + λ·diag(H)（Marquardt），替代 H + λI —— 等量 λ 对
             耦合块(~1e2)与质量/宽度块(~1e4)尺度差两个数量级，会把好方向一起压死；
          3. λ 用 **gain-ratio** 自适应 + **Armijo** 回溯，替代 accept/reject×10；
          4. 终止判据用**投影梯度** |P(x-g)-x|_∞ < gtol（真 KKT），而不是 eig_min；
             PD 只在**非活跃子空间**上判（盒约束的正确二阶条件）。

        S4（reparam 防幅度放飞）: 耦合步长/负曲率逃逸步按当前 |A| 夹
        （coup_step_cap），候选点硬帽 amp_cap，连续 patience 步 ΔNLL<floor_tol
        即停（噪声底漂移）。

        返回 (params, nll, is_pos_def)。
        """
        dev, nc = self.device, self.n_coupling_free
        # S4: reparam 下按「幅度」而非 v_max(=20000) 限制耦合步长/逃逸步，
        # 并对候选点做 amp_max 硬帽；非 reparam 保持原行为（amp_cap=v_max 等价）。
        amp_cap = self.amp_max if self.optimizer_kind == "reparam" else self.v_max
        use_amp_cap = (self.optimizer_kind == "reparam" and nc > 1)

        def _max_amp(p):
            if nc <= 1:
                return 0.0
            r = p[1:nc]
            i = p[nc + 1:2 * nc]
            return float(torch.sqrt(r * r + i * i).max().item())

        mask = torch.ones(self.n_params, dtype=torch.bool, device=dev)
        mask[0] = False
        mask[nc] = False

        x = params_phys.clone().detach()
        self._project_params_(x)
        lo, hi = self.bounds(x)
        w = (hi - lo).clamp(min=1e-30)
        n_evals = [0]           # 归因用: polish 内部求值次数
        n_hess = [0]            # 归因用: 精确 Hessian 次数

        def fg(p):
            n_evals[0] += 1
            q = p.detach().clone().requires_grad_(True)
            n = self.analysis.getNLL(q)
            return n.item(), torch.autograd.grad(n, q, retain_graph=False)[0].detach()

        def pg_of(p, g):
            return p - torch.clamp(p - g, lo, hi)

        def active_of(p, g):
            at_lo = (p - lo) <= 1e-8 * w
            at_hi = (hi - p) <= 1e-8 * w
            return ((at_lo & (g > 0)) | (at_hi & (g < 0))) & mask

        f, g = fg(x)
        lam = lam0
        n_step = 0
        tiny_streak = 0

        for step in range(max_steps):
            n_step = step + 1
            act = active_of(x, g)
            free = mask & (~act)
            pg = pg_of(x, g)
            if not bool(free.any()):
                if verbose:
                    print(f"[polish] step{step}: 全部为活跃约束 → KKT")
                break
            pg_inf = pg[free].abs().max().item()

            H = self.analysis.getHessian(x)[free][:, free].double()
            n_hess[0] += 1
            gf = g[free].double()
            ev_all, Q_all = torch.linalg.eigh(H)
            lmax_all = ev_all[-1].abs().clamp(min=1e-30)
            at_min = bool((ev_all[0] > tau * lmax_all).item())

            if pg_inf <= gtol and at_min:
                if verbose:
                    print(f"[polish] step{step}: 真局部极小 |pg|={pg_inf:.2e}, "
                          f"active={int(act.sum())}")
                break

            if pg_inf <= gtol and not at_min:
                # 定了但 Hessian 仍不定 = 驻定鞍点（g≈0 ⇒ LM/Newton 步为 0，
                # 必须显式沿负曲率方向逃逸，否则会原地判"收敛"）
                v = Q_all[:, 0]
                base = max((0.1 * w[free] / v.abs().clamp(min=1e-30)).min().item(), 1e-12)
                if use_amp_cap:
                    # 逃逸步也按幅度夹：v 在 free 子空间，映射回全向量取耦合分量
                    v_full = torch.zeros_like(x)
                    v_full[free] = v
                    v_coup = max(v_full[1:nc].abs().max().item(),
                                 v_full[nc + 1:2 * nc].abs().max().item())
                    if v_coup > 0:
                        base = min(base, coup_step_cap * max(_max_amp(x), 1.0) / v_coup)
                cand_best = None
                for sgn in (1.0, -1.0):
                    cand = x.clone()
                    cand[free] = x[free] + sgn * base * v
                    self._project_params_(cand)
                    if use_amp_cap and _max_amp(cand) > amp_cap:
                        continue
                    fn, gn = fg(cand)
                    if cand_best is None or fn < cand_best[0]:
                        cand_best = (fn, cand, gn)
                if cand_best is None:
                    # 两个方向的逃逸点都被 amp_cap 拒绝 → 无法逃逸，保留当前点
                    break
                if cand_best[0] < f - max(tol, 0.0):
                    f, x, g = cand_best[0], cand_best[1], cand_best[2]
                    if verbose:
                        print(f"[polish] step{step}: 负曲率逃逸 "
                              f"(λmin/λmax={ev_all[0].item() / lmax_all.item():.2e}) "
                              f"→ NLL={f:.6f}")
                    continue
                break                       # 逃不出去 → 放弃

            dg = torch.diag(H).abs()
            # Marquardt 缩放；对角退化(≈0)时用谱尺度兜底，否则 λ·dg 永远压不住
            # 负曲率方向（会一直在"非下降方向"分支里空转）
            dg = dg.clamp(min=max(1e-3 * lmax_all.item(), 1e-30))

            accepted = False
            for _ in range(25):                             # λ 自适应
                M = H + torch.diag(lam * dg)
                try:
                    d = torch.linalg.solve(M, -gf)
                except Exception:
                    d = torch.linalg.lstsq(M, -gf).solution
                gd = torch.dot(gf, d)
                if (not bool(torch.isfinite(gd))) or gd >= 0:   # 非下降 → 加阻尼
                    lam *= 4.0
                    continue
                # 物理步长帽（相对 free_range 宽度），避免巨步
                t = min(1.0, (step_cap * w[free] / d.abs().clamp(min=1e-30)).min().item())
                if use_amp_cap:
                    # S4: 耦合步长按「当前幅度」夹，单步最多涨 coup_step_cap 比例
                    d_full = torch.zeros_like(x)
                    d_full[free] = d
                    d_coup = max(d_full[1:nc].abs().max().item(),
                                 d_full[nc + 1:2 * nc].abs().max().item())
                    if d_coup > 0:
                        t = min(t, coup_step_cap * max(_max_amp(x), 1.0) / d_coup)
                for _ in range(30):                         # Armijo 回溯
                    cand = x.clone()
                    cand[free] = x[free] + t * d
                    self._project_params_(cand)
                    if use_amp_cap and _max_amp(cand) > amp_cap:
                        t *= 0.5
                        continue
                    fn, gn = fg(cand)
                    if fn <= f - 1e-4 * abs(t * gd.item()):
                        pred = -(t * gd.item() + 0.5 * t * t * torch.dot(d, H @ d).item())
                        rho = (f - fn) / pred if pred > 0 else 1.0
                        lam = max(lam * (0.5 if rho > 0.75
                                         else (2.0 if rho < 0.25 else 1.0)), 1e-10)
                        accepted = True
                        break
                    t *= 0.5
                if accepted:
                    break
                lam *= 4.0
                if lam > 1e12:
                    break
            if not accepted:
                if verbose:
                    print(f"[polish] step{step}: stall (λ={lam:.1e}, |pg|={pg_inf:.2e}, "
                          f"active={int(act.sum())})")
                break

            df = f - fn
            x, f, g = cand, fn, gn
            if verbose:
                print(f"[polish] step{step}: λ={lam:.2e} α={t:.2e} ΔNLL={-df:+.4f} "
                      f"|pg|={pg_inf:.2e} active={int(act.sum())} maxA={_max_amp(x):.3e}")
            if df <= 1e-9 * max(1.0, abs(f)):
                break
            # S4: 连续处于数值噪声底 → 停机，避免沿简并方向做微小累积漂移
            if df < floor_tol:
                tiny_streak += 1
                if tiny_streak >= patience:
                    if verbose:
                        print(f"[polish] stop: 噪声底 (连续 {tiny_streak} 步 ΔNLL<{floor_tol})")
                    break
            else:
                tiny_streak = 0

        # ---- 终态: 重算活跃集, 只在非活跃子空间判 PD ----
        act = active_of(x, g)
        free = mask & (~act)
        pg = pg_of(x, g)
        pg_inf = pg[free].abs().max().item() if bool(free.any()) else 0.0
        H_final = self.analysis.getHessian(x)
        n_hess[0] += 1
        # 归因统计（供 fit.py 汇总/日志读取；不改变行为）
        self._polish_stats = {"steps": n_step, "n_hess": n_hess[0],
                              "n_evals": n_evals[0]}
        if bool(free.any()):
            eig_f = torch.linalg.eigvalsh(H_final[free][:, free].double())
            lmax = eig_f[-1].abs().clamp(min=1e-30)
            pd = bool((eig_f[0] > tau * lmax).item())
            ratio = eig_f[0].item() / lmax.item()
        else:
            # 自由子空间为空: 全部方向都是活跃约束 —— 空矩阵是"正定"的（虚真），
            # 但该点上的参数误差无定义（这些参数只由边界决定）
            eig_f = torch.zeros(1, dtype=torch.float64, device=dev)
            pd, ratio = True, float("nan")
        # 播种缓存: 抛光终点的 Hessian 供误差/分支比复用
        self._hess_cache = (x.clone(), H_final)
        if verbose:
            print(f"[polish] done: NLL={f:.6f}, PD(free)={pd}, "
                  f"λmin={eig_f[0].item():.3e} λmax={lmax.item():.3e} "
                  f"λmin/λmax={ratio:.2e}, "
                  f"active={int(act.sum())}/{int(mask.sum())}, |pg|={pg_inf:.2e}, "
                  f"steps={n_step}")
            if not bool(free.any()):
                print("[polish] 注意: 所有自由方向都是活跃约束 → "
                      "参数误差无定义，只能报单侧限制")
        return x, f, pd

    # --------------------------------------------------------
    def _get_hessian_cached(self, params):
        """统一 Hessian（带缓存）: 参数与上次完全相同时直接复用，否则计算。
        fit.py 在多处（正定性/参数误差/分支比误差）会在同一最佳点上要 Hessian,
        只算一次即可。"""
        if (self._hess_cache is not None
                and self._hess_cache[0].shape == params.shape
                and torch.equal(self._hess_cache[0], params)):
            return self._hess_cache[1]
        h = self.analysis.getHessian(params)
        self._hess_cache = (params.clone(), h)
        return h

    # --------------------------------------------------------
    def compute_param_errors(self, params_phys, tau=1e-8):
        """在给定参数点用精确 Hessian 求参数误差。

        与 polish 保持**同一套判据**: 只在**非活跃子空间**上判正定并求逆。
        被边界钉住的参数（贴边且梯度朝外）没有统计误差 —— 它们是被
        free_range 截断的，返回 NaN，并在 res_errors/耦合误差里如实标出。

        返回 (coupling_real_errors, coupling_imag_errors, res_errors)。
        """
        hessian_full = self._get_hessian_cached(params_phys)
        nc = self.n_coupling_free

        # 完整自由索引（排除固定的 re_0 / im_0）
        fixed_mask = torch.ones(self.n_params, dtype=torch.bool, device=self.device)
        fixed_mask[0] = False
        fixed_mask[nc] = False
        red_idx = torch.nonzero(fixed_mask, as_tuple=False).flatten()
        H_red = hessian_full[fixed_mask][:, fixed_mask]

        # 活跃集: 贴边且下降方向朝外（与 polish / projected_lbfgs 同一条规则）
        p = params_phys.detach()
        q = p.clone().requires_grad_(True)
        g = torch.autograd.grad(self.analysis.getNLL(q), q)[0].detach()
        lo, hi = self.bounds(p)
        w = (hi - lo).clamp(min=1e-30)
        at_lo = (p - lo) <= 1e-8 * w
        at_hi = (hi - p) <= 1e-8 * w
        active_full = ((at_lo & (g > 0)) | (at_hi & (g < 0))) & fixed_mask
        act_red = active_full[red_idx]
        keep = ~act_red

        def _label(full_idx):
            if full_idx < nc:
                return f"Re({self.params_names[full_idx]})"
            if full_idx < 2 * nc:
                return f"Im({self.params_names[full_idx - nc]})"
            return self.params_names[full_idx - nc]

        if int(keep.sum().item()) == 0:
            log.warning("所有自由方向都被边界钉住，无法给出参数误差")
            return None, None, None

        H_k = H_red[keep][:, keep].double()
        eig = torch.linalg.eigvalsh(H_k)
        lmax = eig[-1].abs().clamp(min=1e-30)
        if eig[0].item() <= tau * lmax.item():
            log.warning(f"非活跃子空间 Hessian 仍不定: λmin={eig[0].item():.3e}, "
                        f"λmin/λmax={eig[0].item() / lmax.item():.2e} → 不给误差")
            return None, None, None

        # 协方差只在非活跃子空间求逆；被钉住的参数留 NaN
        try:
            cov = torch.linalg.inv(H_k)
            sd_keep = torch.sqrt(torch.diag(cov).clamp(min=0.0))
        except Exception as e:
            log.error(f"计算参数误差时出错: {e}")
            return None, None, None

        sd_red = torch.full((H_red.shape[0],), float("nan"),
                            dtype=torch.float64, device=self.device)
        sd_red[keep] = sd_keep
        pinned = [_label(int(red_idx[i].item()))
                  for i in range(len(red_idx)) if not bool(keep[i])]
        if pinned:
            print(f"[errors] {len(pinned)} 个参数被 free_range 钉住，无统计误差(标 NaN): "
                  f"{', '.join(pinned)}")
            print("[errors]   这表示数据想把它们推到范围外 → 放宽该 free_range，"
                  "或按单侧限制报告")
        print(f"[errors] 非活跃子空间: {int(keep.sum())} 维, "
              f"λmin={eig[0].item():.3e}, λmin/λmax={eig[0].item() / lmax.item():.2e}")

        n_c_var = nc - 1
        coupling_real_errors = torch.full((nc,), float("nan"),
                                          dtype=torch.float32, device=self.device)
        coupling_imag_errors = torch.full((nc,), float("nan"),
                                          dtype=torch.float32, device=self.device)
        for i in range(n_c_var):
            coupling_real_errors[i + 1] = sd_red[2 * i].float()
            coupling_imag_errors[i + 1] = sd_red[2 * i + 1].float()
        res_errors = None
        if self.has_free_res:
            res_errors = sd_red[2 * n_c_var:].float()
        return coupling_real_errors, coupling_imag_errors, res_errors

    # --------------------------------------------------------
    def extract_coupling_complex(self, params):
        """从统一参数中提取复数耦合向量 (complex64, n_coupling_free)"""
        real = params[:self.n_coupling_free].float()
        imag = params[self.n_coupling_free:2 * self.n_coupling_free].float()
        return torch.complex(real, imag)

    def extract_theta_phys(self, params):
        """从统一参数中提取共振态物理参数"""
        if not self.has_free_res:
            return None
        return params[2 * self.n_coupling_free:]

    # --------------------------------------------------------
    def compute_fit_fractions(self, params=None):
        """拟合分数 (fit fractions): FF_i = ∫|A_i|² / Σ_j ∫|A_j|²。
        只用 phsp_truth（无效率 MC）→ 与效率/归一化无关，跨实验可比。
        误差传播用拟合同源的统一 Hessian（缓存命中直接复用）。"""
        if params is None:
            if self.best_params is None:
                log.warning("没有优化结果!")
                return None, None
            params = self.best_params

        coupling = self.extract_coupling_complex(params)
        # 传拟合同源的全量 Hessian → FF 误差的正定性判定与拟合完全一致
        # （旧版内部用独立的 computeCouplingHessian, 近平坦方向
        #  min_eig~1e-5 时正定判定翻脸 → 误差被跳过变全 0）。
        hessian_full = self._get_hessian_cached(params)
        # getFitFractions 在配置无 phsp_truth 时天然返回空张量 [0,2]
        # （早期拟合不带 mctruth）→ 这里自然跳过, 不抛异常、不触碰相关 kernel
        ff_result = self.analysis.getFitFractions(coupling, hessian_full)
        if ff_result is None or ff_result.numel() == 0:
            log.warning("跳过拟合分数: 配置没有 phsp_truth (无效率相空间 MC), "
                        "需要时再加入并重跑")
            return None, None
        return ff_result[:, 0], ff_result[:, 1]

    # --------------------------------------------------------
    def compute_efficiency(self, params=None):
        """分波效率: ε_i = (Σ_{phsp}|A_i|²/N_phsp) / (Σ_{phsp_truth}|A_i|²/N_truth)。
        phsp(如 cut 后 MC)=带效率样本, phsp_truth=无效率 MC truth,
        即分波加权的探测/选择效率 ∫|A_i|²ε(x)dΦ / ∫|A_i|²dΦ (tf-pwa get_efficiency 语义)。
        效率依赖拟合结果(振幅形状含共振参数), 用拟合后 params 计算。
        误差 = 参数误差(拟合同源 Hessian) ⊕ MC 统计误差(tf-pwa add_int_error 同款)。
        配置缺 phsp 或 phsp_truth 时返回空张量 [0,2] → 这里自然跳过。"""
        if params is None:
            if self.best_params is None:
                log.warning("没有优化结果!")
                return None, None
            params = self.best_params

        coupling = self.extract_coupling_complex(params)
        hessian_full = self._get_hessian_cached(params)
        eff_result = self.analysis.getEfficiency(coupling, hessian_full)
        if eff_result is None or eff_result.numel() == 0:
            log.warning("跳过分波效率: 配置缺 phsp (带效率 MC) 或 phsp_truth, "
                  "需要时再加入并重跑")
            return None, None
        return eff_result[:, 0], eff_result[:, 1]

