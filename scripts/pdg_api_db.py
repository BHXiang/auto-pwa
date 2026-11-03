#!/usr/bin/env python3
"""Build the runtime ResonanceDb from the official local PDG API.

The API reads the PDG package's bundled SQLite database; no network is used.
The curated pdg.json supplies aliases, decay-mode annotations and measurements,
but no longer limits which official states can be discovered.  The output is a
single JSON document consumed once per Node process by src/db.ts.
"""
from __future__ import annotations
import hashlib
import json
import re
import sqlite3
from pathlib import Path

import pdg
from pdg import PdgApi
from fetch_pdg import extract_particles, to_pdg_name, summary_value

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOT = ROOT / "data" / "pdg.json"
DB = Path(pdg.__file__).resolve().parent / "pdg.sqlite"


def parse_j(value):
    if value is None:
        return None
    text = str(value).strip()
    try:
        number = float(text.split("/")[0]) / float(text.split("/")[1]) if "/" in text else float(text)
        return int(number) if number.is_integer() else number
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def generic_alias(name: str) -> str | None:
    """Neutral PDG `phi(2170)0` -> analysis spelling `phi(2170)`."""
    return name[:-1] if name.endswith(")0") else None


def official_entry(p) -> dict | None:
    j, parity = parse_j(p.quantum_J), p.quantum_P
    try:
        mass_value = summary_value(p, 'M')
    except Exception:
        return None
    if j is None or parity not in ("+", "-") or mass_value is None:
        return None
    out = {
        "id": p.name,
        "aliases": [],
        "jp": {"j": j, "p": 1 if parity == "+" else -1},
        "mass": round(mass_value[0], 6),
        "status": "pdg",
        "decayModes": [],
    }
    if mass_value[1]:
        out["massError"] = round(mass_value[1], 6)
    alias = generic_alias(p.name)
    if alias:
        out["aliases"].append(alias)
    try:
        width_value = summary_value(p, 'G')
        if width_value is not None:
            out["width"] = round(width_value[0], 6)
            if width_value[1]:
                out["widthError"] = round(width_value[1], 6)
    except Exception:
        pass
    # C is defined only for self-conjugate states; charged multiplet members
    # sometimes carry a spurious quantum_C in the PDG database.
    if p.self_conjugate and p.quantum_C in ("+", "-"):
        out["c"] = 1 if p.quantum_C == "+" else -1
    return out


def merge_overlay(base: dict, overlay: dict, official_name: str) -> dict:
    """Official J/P/C/mass/width win; curated aliases/decays/measurements stay."""
    out = {**overlay, **{k: v for k, v in base.items() if k not in ("id", "aliases")}}
    out["id"] = overlay["id"]
    aliases = list(dict.fromkeys([*overlay.get("aliases", []), official_name, *base.get("aliases", [])]))
    out["aliases"] = aliases
    for key in ("decayModes", "measurements", "tex", "reason", "reference"):
        if key in overlay:
            out[key] = overlay[key]
    out["status"] = "pdg"
    return out


def main() -> None:
    api = PdgApi(f"sqlite:///{DB}")
    overlay = json.loads(SNAPSHOT.read_text())
    entries = {}
    for group in api.get_particles():
        for particle in group:
            entry = official_entry(particle)
            if entry is not None:
                entries[particle.name] = entry

    # Map curated names onto official particles.  A generic family name maps to
    # the neutral member when available; charge-specific names map exactly.
    for old in overlay["resonances"]:
        hits = []
        for candidate in [old["id"], *old.get("aliases", [])]:
            try:
                found = list(api.get_particles_by_name(to_pdg_name(candidate)))
            except Exception:
                found = []
            if found:
                hits = found
                break
        if not hits:
            continue
        wanted_charge = old["id"][-1:] if old["id"][-1:] in ("+", "-") else None
        chosen = next((p for p in hits if wanted_charge and p.name.endswith(wanted_charge)), None)
        if chosen is None:
            chosen = next((p for p in hits if p.name.endswith(")0")), hits[0])
        official = entries.get(chosen.name)
        if official is not None:
            entries[chosen.name] = merge_overlay(official, old, chosen.name)

    info = dict(sqlite3.connect(DB).execute("SELECT name, value FROM pdginfo").fetchall())
    db = {
        "schemaVersion": overlay.get("schemaVersion", "0.6.0"),
        "source": "PDG API (official package local SQLite)",
        "resonances": sorted(entries.values(), key=lambda e: (e["mass"], e["id"])),
        "particles": extract_particles(api),
    }
    meta = {
        "source": "pdg-api",
        "edition": info.get("edition"),
        "releaseTimestamp": info.get("data_release_timestamp"),
        "sqlitePath": str(DB),
        "sqliteSha256": hashlib.sha256(DB.read_bytes()).hexdigest(),
        "entries": len(db["resonances"]),
    }
    print(json.dumps({"db": db, "meta": meta}, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
