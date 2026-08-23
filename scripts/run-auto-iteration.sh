#!/usr/bin/env bash
# run-auto-iteration: 从基线自动迭代到收敛（无轮数人为限制）——headless 驱动。
#
# 用法:
#   ./scripts/run-auto-iteration.sh <分析目录> [max-rounds] [--reset-loop]
#
#   <分析目录>   含 config.yml（或 iterations/iter-NN 结构）的分析目录
#   max-rounds   loop 状态机的轮次预算上限（默认 10；收敛由状态机判定，
#                该值是"永不收敛"时的兜底，不是人为提前停）
#   --reset-loop 重置循环状态（备份并删除 .loop-state.json，从 baseIterDir
#                重新 init）——用于"从 0 推进到最优"的重复测试
#
# 行为:
#   1. 若已收敛（phase=done）且未 --reset-loop → 输出 FINAL-REPORT.md 退出
#   2. 否则启动 headless 会话，AI 按 auto-pwa 循环状态机自主迭代：
#      loop_next 评估 → suggest/diagnose/root_view 决策 → loop_decide iterate
#      （带 hypothesis+prediction）→ 拟合完成 → 下一轮 → 状态机判定 done
#   3. 完成后打印 FINAL-REPORT.md 路径与最优 NLL
#
# 环境: PWA_CTPWA_PYTHON / PWA_LD_LIBRARY_PATH（conda 激活 ctpwa 时可省略）
set -euo pipefail

ANALYSIS_DIR=${1:?用法: run-auto-iteration.sh <分析目录> [max-rounds] [--reset-loop]}
MAX_ROUNDS="${2:-10}"
RESET_LOOP=0
for a in "$@"; do
  [ "$a" = "--reset-loop" ] && RESET_LOOP=1
done

# ---- 路径（可覆盖）-------------------------------------------------------
DSH_ROOT="${DSH_ROOT:-$HOME/pkgs/deepseek-harness}"
PATCH_DIR="${PATCH_DIR:-$HOME/pkgs/auto-pwa/patch}"
export PWA_CTPWA_PYTHON="${PWA_CTPWA_PYTHON:-/home/whitewash/miniconda3/envs/ctpwa/bin/python}"
export PWA_LD_LIBRARY_PATH="${PWA_LD_LIBRARY_PATH:-/usr/local/cuda-13.2/lib64:/home/whitewash/miniconda3/envs/ctpwa/lib/python3.12/site-packages/torch/lib:/home/whitewash/pkgs/root/lib}"

[ -d "$ANALYSIS_DIR" ] || { echo "分析目录不存在: $ANALYSIS_DIR" >&2; exit 2; }
[ -f "$ANALYSIS_DIR/config.yml" ] || [ -d "$ANALYSIS_DIR/iterations" ] || {
  echo "分析目录缺少 config.yml 或 iterations/（请先初始化基座）" >&2; exit 2
}

# ---- 重置循环状态（可选）--------------------------------------------------
LOOP_STATE="$ANALYSIS_DIR/iterations/.loop-state.json"
if [ "$RESET_LOOP" = "1" ] && [ -f "$LOOP_STATE" ]; then
  cp "$LOOP_STATE" "$LOOP_STATE.bak-$(date +%s)"
  rm -f "$LOOP_STATE"
  echo "[run-auto-iteration] 已重置循环状态（旧状态备份为 .loop-state.json.bak-*）"
fi

# ---- 已收敛则直接报告 ------------------------------------------------------
if [ -f "$LOOP_STATE" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$LOOP_STATE')).get('phase')=='done' else 1)" 2>/dev/null; then
  echo "[run-auto-iteration] 已收敛，无需迭代。报告:"
  cat "$ANALYSIS_DIR/iterations/FINAL-REPORT.md" 2>/dev/null | head -30
  exit 0
fi

# ---- 基座迭代目录（--reset-loop 或全新时用 iter-000；否则沿用状态里的）---
BASE_DIR="$ANALYSIS_DIR/iterations/iter-000"
if [ -d "$BASE_DIR" ]; then
  BASE_CLAUSE="基线 = $BASE_DIR（若状态已存在则沿用其 currentIterDir）"
else
  BASE_CLAUSE="无 iter-000，从 $ANALYSIS_DIR/config.yml 用 auto_pwa_iter_start 初始化"
fi

# ---- 启动 headless 自主迭代 ------------------------------------------------
cd "$DSH_ROOT"
pnpm dsh --profile headless \
  --patch "$PATCH_DIR/auto-pwa.cordis.yml" \
  --patch "$PATCH_DIR/auto-pwa-headless.yml" \
  "对 $ANALYSIS_DIR 做分波自动迭代直到收敛（轮次预算 $MAX_ROUNDS 由状态机掌控，不要人为提前停）：

1. 恢复上下文：读 iterations/.loop-state.json 与 SUMMARY.jsonl（$BASE_CLAUSE）；
   状态为 done 则输出 FINAL-REPORT.md 并结束。
2. 每轮固定流程（全部走 auto_pwa_* 工具，禁止手工改 config）：
   a. auto_pwa_loop_next 评估当前迭代（NLL/ΔNLL/max|pull|/预测验证）
   b. 未收敛：auto_pwa_evaluate + auto_pwa_diagnose + auto_pwa_root_view 看形状，
      auto_pwa_suggest 找候选，jpc_check/lookup 复核物理
   c. auto_pwa_loop_decide iterate 提交决策（必须带 hypothesis 与 prediction，
      如 {metric: maxPull, threshold: 5, direction: below} 或 regionPull 指定质量窗）；
      多个候选不确定时先 auto_pwa_try_candidates + auto_pwa_compare 择优晋级
   d. 拟合完成通知后回到 a
3. 收敛目标（loop objective）：stopMaxPull=5、stopDeltaNll=10、significanceThreshold=3、
   maxRounds=$MAX_ROUNDS。由 auto_pwa_loop_next 判定 done 并写 FINAL-REPORT.md；
   拟合退化（Hessian 不正定/ΔNLL 大幅变差）用 loop_decide rollback。
4. 已知提示：角分布可能存在基线系统性偏差（多轮加共振态无法消除）——此时按
   ΔNLL 显著性判定"无进一步改进"并让状态机收敛，不要无限尝试同一方向。
5. 若某工具报输出 schema 错误，把错误原文留在回复里并尝试绕行（读落盘的
   evaluate.json/fit.json），不要卡死。

完成后输出：FINAL-REPORT.md 路径、最优迭代、最佳 NLL、收敛原因。"
