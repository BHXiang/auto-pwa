#!/bin/bash
# =============================================================================
#  ctpwa SLURM 提交脚本（一份模板，V100 为默认示范）
#
#  插件怎么用它：  sbatch --chdir=<iterDir> <iterDir>/job.sh [fit.py 的参数...]
#    - auto_pwa_run_fit({ iterDir, jobScript: "auto" })（或直接省略 jobScript）
#      会把本文件装成 <iterDir>/job.sh 再提交
#    - 也可以复制出去自己改（jobScript 传路径），改完照常提交
#
#  三条硬契约（改脚本时别破坏）：
#   ① 不写 cd、不写死 iter 路径：工作目录由 --chdir 设为迭代目录，
#      同一份脚本才能给 _trials/<候选>/ 复用（--chdir 换成 trial 目录）
#   ② 日志写 fit.log（--output=fit.log，相对 sbatch 的 cwd = 迭代目录）
#   ③ fit.py 的参数用 "$@" 透传（--runs/--max-iter/--warm/--config 都靠它）
#
#  换硬件 / 换队列：只改 Part 1 里带 ★ 的 3 行（详见 Part 1 末尾的对照表）
# =============================================================================

######## Part 1 #########
# Script parameters     #
#########################

# ★1 分区：决定在哪个排队池里等。V100 在 gpu；A100 在 gpupwa（见 Part 1 末尾对照表）
#SBATCH --partition=gpu

# ★2 QOS（服务质量档，必填）：V100 常用 pwanormal；A100/gpupwa 用 pwadedicate
#SBATCH --qos=pwanormal

# 计费组（必填）：按实验组扣机时，写错会被拒
#SBATCH --account=gpupwa

# 作业名：squeue 里显示的名字，便于认出是哪一轮作业
#SBATCH --job-name=ctpwa-fit

# 任务数：单卡拟合 1 个任务就够（ctpwa 不做多进程并行，多给 core 没用）
#SBATCH --ntasks=1

# 标准输出/错误：相对路径 = sbatch 的当前目录（插件已 --chdir 到迭代目录），
# 最终落在 <iterDir>/fit.log —— 插件靠它读进度和结果。
# 不要改成绝对路径，也不要把 stdout/stderr 拆成两个文件（插件只 tail 这一个）
#SBATCH --output=fit.log

# 每核内存（MB）：50 GB 够 ctpwa + ROOT + torch；太小会在加载权重时 OOM
#SBATCH --mem-per-cpu=50000

# ★3 GPU 卡数：1 张即可（gpupwa 上 2 卡的空隙很少，排一小时是常态；
# 要跑测试需要多大显存，ctpwa可以多GPU以提供显存容量，再改这里并同步 --partition/--qos）
#SBATCH --gres=gpu:v100:1

# 墙钟上限（可选）：不写就用分区默认；默认48小时kill作业
# #SBATCH --time=12:00:00

# ---- 硬件对照表（改 ★1/★2/★3 即可） ----------------------------------------
#   卡型   分区        QOS             GRES
#   V100   gpu         pwanormal       gpu:v100:1      ← 本模板默认，通常更好排
#   A100   gpupwa      pwadedicate     gpu:a100:1      ← gpupwa 常年满员，1 卡>2 卡
#   A100   gpupwa      pwadebug        gpu:a100:1      ← 短调试队列。排队快、15分钟kill
#
# 注意：换卡型要同时改 ★1/★2/★3 三行；只改 GRES 会提交到错误分区而被拒。
# ctpwa 只支持 GPU，且当前按单卡跑；不要指望多卡自动加速。

######## Part 2 ######
# Script workload    #
######################

# ---- ctpwa 环境 -------------------------------------------------------------
# 计算节点上 `conda activate` 不可靠（有时拿不到 shell hook），所以直接把
# env 的 bin/lib 拼进 PATH/LD_LIBRARY_PATH，不 source conda.sh、不 activate。
CTPWA_ENV="${HOME}/miniconda3/envs/ctpwa"
[ -x "${CTPWA_ENV}/bin/python" ] || CTPWA_ENV=/besfs10/groups/jpsi/jpsigroup/user/bhxiang/miniconda3/envs/ctpwa

# torch JIT 编译目标：V100=7.0，A100=8.0，两个都写互不影响
export TORCH_CUDA_ARCH_LIST='7.0 8.0'
# CUDA 工具链位置（与 ~/Script/conda.sh 里的 ctpwa 配置一致）
export CUDA_HOME=/usr/local/cuda-12.9
# python 用 env 自带的；nvcc 等优先用 CUDA 的
export PATH="${CUDA_HOME}/bin:${CTPWA_ENV}/bin:${PATH}"
# 运行期动态库：CUDA + torch + env 自身
export LD_LIBRARY_PATH="${CUDA_HOME}/lib64:${CTPWA_ENV}/lib/python3.12/site-packages/torch/lib:${CTPWA_ENV}/lib:${LD_LIBRARY_PATH}"

# ---- 运行 -------------------------------------------------------------------
# 记录节点/目录/开始时间，出问题先看这几行
echo "[job] host=$(hostname) cwd=$(pwd) start=$(date '+%F %T')"
nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader 2>/dev/null | head -2

# 前台跑 fit.py（cwd 就是迭代目录，config.yml / results/ 都在这里）。
# "$@" = 插件传进来的 --runs/--max-iter/--warm/--config；不要加 & 后台化，
# 否则 SLURM 作业会提前结束，插件就等不到“完成”了
"${CTPWA_ENV}/bin/python" -u fit.py "$@"
rc=$?

# 把真实退出码带出去：非 0 时 fit_status 判 failed，日志末尾有 exit=N 可查
echo "[job] end=$(date '+%F %T') exit=${rc}"
exit ${rc}
