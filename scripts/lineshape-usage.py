#!/usr/bin/env python3
"""扫各分析 config.yml，统计"每个共振态实际用了哪些线形模型"，产出证据表。

用法：<ctpwa env>/bin/python scripts/lineshape-usage.py [分析目录...]
默认扫本机的 5 个分析；输出 data/lineshape-usage-stats.json。

用途：让"线形惯例"有**语料证据**（而不是凭印象），并直接暴露用法冲突
（例如 f0(980) 在一个分析里用 BWR、另一个用 Flatte）。
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import re

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "lineshape-usage-stats.json"
DEFAULT_DIRS = [
    Path("/home/whitewash/pwa/chicj2KKeta"),
    Path("/home/whitewash/pwa/chic2ppeta"),
    Path("/home/whitewash/pwa/Jpsi2omegaKK/KsKs"),
    Path("/home/whitewash/pwa/Jpsi2KKeta/solve5"),
    Path("/home/whitewash/Works/Jpsi2KKeta/region_big"),
]


def configs(base: Path):
    return sorted(base.glob("iterations/iter-*/config.yml"))


def resonances(path: Path) -> dict[str, str]:
    """按行解析 `Resonances:` 块里的 `<name>: model: X`。

    不用 PyYAML：ctpwa 的 config 在 Constraints.trans 里用**列表当映射键**
    （`? - R_Keta_0 … : 1`），PyYAML 会报 "found unhashable key"。
    """
    out: dict[str, str] = {}
    in_block = False
    cur: str | None = None
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not in_block:
            if re.match(r"^Resonances:\s*$", line):
                in_block = True
            continue
        if re.match(r"^\S", line) and not line.startswith("  "):
            break
        m = re.match(r"^  ([^\s:#][^:]*):\s*$", line)
        if m:
            cur = m.group(1).strip()
            out.setdefault(cur, "")
            continue
        m2 = re.match(r"^\s{4}model:\s*(\S+)", line)
        if m2 and cur:
            out[cur] = m2.group(1)
    return {k: v for k, v in out.items() if v}


def main() -> int:
    dirs = [Path(a) for a in sys.argv[1:]] or DEFAULT_DIRS
    by_name: dict[str, Counter] = defaultdict(Counter)
    per_analysis: dict[str, dict[str, Counter]] = {}
    for base in dirs:
        if not base.is_dir():
            print(f"skip (missing): {base}")
            continue
        seen: Counter = Counter()
        for path in configs(base):
            for name, model in resonances(path).items():
                seen[(name, model)] += 1
        if seen:
            per_analysis[base.name] = {f"{n}|{m}": c for (n, m), c in sorted(seen.items())}
            for (n, m), c in seen.items():
                by_name[n][m] += c
    stats = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "note": "各分析 config.yml 里每个共振态实际使用的线形模型（证据，用于校准惯例；不是规则）",
        "byName": {n: dict(c) for n, c in sorted(by_name.items())},
        "conflicts": {n: dict(c) for n, c in sorted(by_name.items()) if len(c) > 1},
        "perAnalysis": per_analysis,
    }
    OUT.write_text(json.dumps(stats, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(by_name)} 个态, {len(stats['conflicts'])} 处用法冲突)")
    for n, c in stats["conflicts"].items():
        print(f"  ⚠ 冲突 {n}: {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
