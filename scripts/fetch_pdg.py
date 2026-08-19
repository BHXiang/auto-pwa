#!/usr/bin/env python3
"""Regenerate data/pdg.json from the OFFICIAL PDG package (pdg-2026, bundled
sqlite) merged with the curated seed table.

    <ctpwa env>/bin/python scripts/fetch_pdg.py

Per existing entry: name is converted to the PDG spelling (f(0)(1500) ->
f_0(1500), K* -> K^*), queried via PdgApi; hits update mass/width AND add
mass_error/width_error (drives tolerance checks and float-policy ranges) and
J/P from the sqlite quantum columns. Unmatched entries keep their current
values (status stays "seed"); matched become status "pdg".
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from pathlib import Path

import pdg
from pdg import PdgApi

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "data" / "pdg.json"

DB = Path(pdg.__file__).resolve().parent / "pdg.sqlite"


def to_pdg_name(name: str) -> str:
    """Convert our id/alias spelling to the PDG package spelling."""
    s = name
    s = s.replace("*", "^*")  # K*(892) -> K^*(892)
    s = re.sub(r"\((\d)\)", r"_\1", s)  # f(0)(1500) -> f_0(1500)
    s = re.sub(r"[+-]$", "", s)  # drop charge suffix (fuzzy match adds it back)
    return s


def quantum_jp(name: str) -> tuple[int | float, int] | None:
    """J, P from the sqlite quantum columns for the exact pdg name."""
    con = sqlite3.connect(f"sqlite:///{DB}" if False else str(DB))
    try:
        row = con.execute(
            "SELECT quantum_j, quantum_p FROM pdgparticle WHERE name=?", (name,)
        ).fetchone()
        if not row:
            return None
        j_raw, p_raw = row
        j = int(j_raw) if j_raw and j_raw.isdigit() else (
            float(j_raw) if j_raw else None)
        if j is None or not p_raw:
            return None
        return j, 1 if p_raw == "+" else -1
    finally:
        con.close()


def main() -> int:
    db_url = f"sqlite:///{DB}"
    api = PdgApi(db_url)
    seed = json.loads(OUT.read_text())["resonances"]

    n_hit = n_miss = 0
    for e in seed:
        candidates = {e["id"], *e.get("aliases", [])}
        hit = None
        for c in candidates:
            pdg_name = to_pdg_name(c)
            try:
                found = list(api.get_particles_by_name(pdg_name))
                # Access mass eagerly: some entries (e.g. K(L)0) have no mass
                # property and throw inside the API.
                for cand in found:
                    _ = cand.mass
                found = [cand for cand in found if cand.mass]
            except Exception:
                found = []
            if found:
                hit = found[0]
                break
        if hit is None:
            n_miss += 1
            continue
        # Merge authoritative values; keep curated fields.
        jp = quantum_jp(hit.name)
        e["mass"] = round(float(hit.mass), 6) if hit.mass else e["mass"]
        if getattr(hit, "mass_error", None):
            e["mass_error"] = round(float(hit.mass_error), 6)
        if getattr(hit, "width", None):
            e["width"] = round(float(hit.width), 6)
        if getattr(hit, "width_error", None):
            e["width_error"] = round(float(hit.width_error), 6)
        if jp:
            e["jp"] = {"j": int(jp[0]) if float(jp[0]).is_integer() else jp[0], "p": jp[1]}
        e["status"] = "pdg"
        n_hit += 1

    out = {
        "schemaVersion": "0.2.0",
        "source": "pdg-2026 official package (fetch_pdg.py)",
        "resonances": seed,
    }
    OUT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"[fetch_pdg] {len(seed)} entries: {n_hit} updated with PDG-2026 "
          f"(+errors), {n_miss} kept as seed -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
