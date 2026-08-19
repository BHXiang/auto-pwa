# auto-pwa-env.sh — workspace-local ctpwa environment for dsh-pwa tooling.
#
# Equivalent of `source /home/whitewash/Script/conda.sh ctpwa` WITHOUT the
# conda activate machinery (which writes outside the workspace and forces
# sandbox escalations). Sets only environment variables; safe under
# workspace-write sandbox. Usage in every command:
#
#     source /home/whitewash/dsh-pwa/scripts/auto-pwa-env.sh && python ...
#
# Note: python resolves to the ctpwa env interpreter via PATH. GPU access
# (/dev/dxg) is still unavailable inside the bwrap sandbox — fits must run
# from a native (non-sandboxed) process such as the DSH host spawned by a
# terminal started with `source /home/whitewash/Script/conda.sh ctpwa`.

export CUDA_HOME=/usr/local/cuda-13.2
export PATH=/usr/local/cuda-13.2/bin:/home/whitewash/miniconda3/envs/ctpwa/bin:${PATH}
export LD_LIBRARY_PATH=/usr/local/cuda-13.2/lib64:/home/whitewash/miniconda3/envs/ctpwa/lib/python3.12/site-packages/torch/lib:/home/whitewash/pkgs/root/lib:${LD_LIBRARY_PATH}
