#!/bin/bash
# GPU 就绪验证：在 Windows 侧执行 `wsl --shutdown` 重启 WSL 后运行。
# 使用用户的 conda 环境配方（/home/whitewash/Script/conda.sh ctpwa）。
# 全部通过即可跑 solve1 首轮拟合。
set -u

echo "== 0. 载入 conda ctpwa 环境 =="
source /home/whitewash/Script/conda.sh ctpwa
which python && echo "CUDA_HOME=$CUDA_HOME"

echo
echo "== 1. /dev/dxg（WSL GPU 透传设备）=="
if [ -e /dev/dxg ]; then ls -la /dev/dxg; else echo "✗ 缺失 — GPU 透传未挂载，仍需 wsl --shutdown 重启"; fi

echo
echo "== 2. nvidia-smi =="
nvidia-smi 2>&1 | head -12 || echo "✗ nvidia-smi 失败"

echo
echo "== 3. torch CUDA 检测 =="
python -c "
import torch
ok = torch.cuda.is_available()
print('cuda available:', ok)
if ok:
    print('device:', torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))
" 2>&1 | grep -v Warning

echo
echo "== 4. ctpwa.analysis()（solve1 config 解析 + GPU 初始化）=="
cd /home/whitewash/pwa/Jpsi2omegaKK/KsKs/solve1 && timeout 120 python -c "
import torch, ctpwa
ana = ctpwa.analysis()
print('OK: amplitudes =', len(ana.getAmplitudeNames()), ', NVector =', ana.getNVector())
" 2>&1 | tail -4

echo
echo "== 完成。第 4 步 OK 即可运行首轮拟合 =="
