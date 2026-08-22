#!/usr/bin/env python3
"""root_view: read histograms from a ctpwa weight_best.root for the AI.

The AI cannot look at PNG plots; this script turns any TH1 in the ROOT file
into structured JSON the model can reason about (per-bin values/errors):
  - ls:   list every histogram (full path + bin count) — discover what exists
  - read: dump the per-bin data of the requested objects (multiple allowed)

Every distribution directory in a ctpwa weight file holds
  hdata / hfit / hbkg                       (data, fit, background)
  h_<chain>-<intermediate>-<resonance>      (per-wave spectra: the size and
                                             shape of EACH resonance)
and cosbeta* directories hold the angular distributions.

Usage:
  <env python> root_view.py <root-file> ls
  <env python> root_view.py <root-file> read <path> [path ...]
Output: one JSON document on stdout.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import uproot


def list_histograms(file: uproot.ReadOnlyDirectory) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    # keys(recursive=True) yields full paths (with ;cycle suffixes).
    for key in file.keys(recursive=True):
        name = key.split(";")[0]
        if name in seen:
            continue  # ROOT cycle duplicates (obj;1, obj;2 ...)
        obj = file[name]
        if isinstance(obj, uproot.behaviors.TH1.TH1):
            seen.add(name)
            out.append({"path": name, "bins": len(obj.axis())})
    return sorted(out, key=lambda x: x["path"])


def read_histograms(file: uproot.ReadOnlyDirectory, paths: list[str]) -> list[dict]:
    out: list[dict] = []
    for p in paths:
        obj = file[p]
        if not isinstance(obj, uproot.behaviors.TH1.TH1):
            out.append({"path": p, "error": "not a TH1 histogram"})
            continue
        edges = obj.axis().edges()
        centers = [(edges[i] + edges[i + 1]) / 2 for i in range(len(edges) - 1)]
        values = [float(v) for v in obj.values()]
        errors = [float(e) for e in obj.errors()]
        out.append(
            {
                "path": p,
                "bins": len(values),
                "range": [float(edges[0]), float(edges[-1])],
                "integral": float(sum(values)),
                "centers": centers,
                "values": values,
                "errors": errors,
            }
        )
    return out


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    root_path = Path(sys.argv[1])
    mode = sys.argv[2]
    if mode == "read" and len(sys.argv) < 4:
        print(__doc__)
        return 2
    if not root_path.exists():
        print(json.dumps({"mode": mode, "error": f"root file not found: {root_path}"}))
        return 1
    if mode not in ("ls", "list", "read"):
        print(json.dumps({"mode": mode, "error": f"unknown mode {mode} (list|read)"}))
        return 2
    try:
        f = uproot.open(str(root_path))
        if mode in ("ls", "list"):
            print(json.dumps({"mode": "list", "objects": list_histograms(f)}, ensure_ascii=False))
        elif mode == "read":
            paths = sys.argv[3:]
            print(json.dumps({"mode": "read", "histograms": read_histograms(f, paths)}, ensure_ascii=False))
        return 0
    except Exception as e:  # noqa: BLE001 — report to the caller, never crash
        print(json.dumps({"mode": mode, "error": f"{type(e).__name__}: {e}"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
