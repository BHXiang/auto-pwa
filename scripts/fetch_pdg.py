#!/usr/bin/env python3
"""Regenerate data/pdg.json from the OFFICIAL PDG package (pdg-2026, bundled
sqlite) merged with the curated seed table.

    <ctpwa env>/bin/python scripts/fetch_pdg.py

Per existing entry: name is converted to the PDG spelling (f(0)(1500) ->
f_0(1500), K* -> K^*), queried via PdgApi; hits update mass/width AND add
mass_error/width_error (drives tolerance checks and float-policy ranges),
J/P from the sqlite quantum columns, and the newest individual MASS
measurements (value/errors/stat/syst/used_in_average + DOI/Inspire refs,
see extract_measurements). Unmatched entries keep their current values
(status stays "seed"); matched become status "pdg".
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
OUT_NEXT = HERE.parent / "data" / "pdg.json.next"
QUERY = HERE.parent / "data" / "pdg-query-names.json"
LOCAL = HERE.parent / "data" / "local-states.json"

DB = Path(pdg.__file__).resolve().parent / "pdg.sqlite"


def to_pdg_name(name: str) -> str:
    """Convert our id/alias spelling to the PDG package spelling."""
    s = name
    s = s.replace("*", "^*")  # K*(892) -> K^*(892)
    s = re.sub(r"\((\d)\)", r"_\1", s)  # f(0)(1500) -> f_0(1500)
    s = re.sub(r"[+-]$", "", s)  # drop charge suffix (fuzzy match adds it back)
    return s


def parse_j(j_raw: str | None) -> float | None:
    """J from a PDG quantum_j string: '0', '1', '3/2', '11/2', ..."""
    if not j_raw:
        return None
    s = str(j_raw).strip()
    if "/" in s:
        num, _, den = s.partition("/")
        try:
            return float(num) / float(den)
        except (TypeError, ValueError):
            return None
    try:
        return float(s)
    except ValueError:
        return None


def quantum_jp(name: str) -> tuple[float, int] | None:
    """J, P from the sqlite quantum columns for the exact pdg name."""
    con = sqlite3.connect(str(DB))
    try:
        row = con.execute(
            "SELECT quantum_j, quantum_p FROM pdgparticle WHERE name=?", (name,)
        ).fetchone()
        if not row:
            return None
        j_raw, p_raw = row
        j = parse_j(j_raw)
        if j is None or not p_raw:
            return None
        return j, 1 if p_raw == "+" else -1
    finally:
        con.close()


def property_gev(prop) -> tuple[float, float] | None:
    """(value, error) in GeV from a PdgMass/PdgWidth property.

    Baryon resonances are frequently quoted as a RANGE: ``value`` is None and
    ``value_text`` looks like '150 to 250 to 400'. Fall back to the central
    number of that range so half-integer-spin states still get a usable seed
    mass/width (the meson sector has single summary values).
    """
    scale = 0.001 if "MeV" in (getattr(prop, "units", "") or "") else 1.0
    value = getattr(prop, "value", None)
    if value is None:
        nums = re.findall(r"[-+]?\d*\.?\d+", getattr(prop, "value_text", "") or "")
        if len(nums) >= 2:
            value = float(nums[len(nums) // 2])  # central of 'a to b to c'
    if value is None:
        return None
    err = max(
        getattr(prop, "error_positive", None) or 0.0,
        getattr(prop, "error_negative", None) or 0.0,
    )
    return float(value) * scale, float(err) * scale


def discover_baryons(api) -> list[dict]:
    """Seed entries for the N* / Delta* families (half-integer J).

    The curated table historically covered the meson sector only, so any
    analysis with a baryon in the final state (p pbar eta, K Lambda, ...)
    could not propose an N* or Delta*: every half-integer-J candidate failed
    the 'not-on-pdg' gate. Names, J and P come from the official PDG sqlite;
    mass/width from the summary property (range central when the PDG quotes
    a range). These entries are enriched like every other seed entry.
    """
    con = sqlite3.connect(str(DB))
    try:
        rows = con.execute(
            "SELECT name, quantum_j, quantum_p FROM pdgparticle "
            "WHERE (name LIKE 'N(%' OR name LIKE 'Delta(%') "
            "AND quantum_j IS NOT NULL AND quantum_p IS NOT NULL"
        ).fetchall()
    finally:
        con.close()
    out: list[dict] = []
    seen: set[str] = set()
    for name, j_raw, p_raw in rows:
        j = parse_j(j_raw)
        if j is None or not p_raw or name in seen:
            continue
        seen.add(name)
        entry: dict = {
            "id": name,
            "aliases": [],
            "jp": {"j": int(j) if float(j).is_integer() else j, "p": 1 if p_raw == "+" else -1},
            "mass": 0.0,
            "width": 0.0,
            "status": "pdg",
            "decayModes": [],
        }
        try:
            for cand in api.get_particles_by_name(name):
                if cand.name != name:
                    continue
                for prop in cand.masses():
                    got = property_gev(prop)
                    if got:
                        entry["mass"] = round(got[0], 6)
                        if got[1]:
                            entry["mass_error"] = round(got[1], 6)
                        break
                for prop in cand.widths():
                    got = property_gev(prop)
                    if got:
                        entry["width"] = round(got[0], 6)
                        if got[1]:
                            entry["width_error"] = round(got[1], 6)
                        break
                break
        except Exception:
            pass
        out.append(entry)
    return out


def normalize_seed_name(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def extract_particles(api) -> dict[str, dict]:
    """mcid-keyed particle table for identity / symmetry checks.

    Key = signed Monte-Carlo ID — the community "PDGID" (K+ = 321, K- = -321,
    pi0 = 111, J/psi = 443, Lambda = 3122, K(S)0 = 310). This is what the
    tooling resolves `Particles.<name>.pdgid` against, and it is what makes
    the symmetry questions decidable from data instead of naming heuristics:

      - identical  : same mcid
      - conjugate  : `conjugate` (antiparticle mcid)
      - self-conj. : `selfConjugate` (PDG cc_type == 'S')

    ⚠ C is stored ONLY for self-conjugate states. The sqlite `quantum_c`
    column also carries values for charged multiplet members (rho(770)+ -> '-',
    a_2(1320)+ -> '+') where C is physically undefined, so `selfConjugate`
    is the gate and `c` only carries the value. '?' = unknown, never a value.

    ⚠ `PdgParticle.antiparticle` raises PdgNoDataError for states with no
    distinct antiparticle block (K(S)0/K(L)0) — handled, `conjugate` stays
    unset for those.

    Restricted to mesons/baryons/leptons/gamma: quarks, gluons, nuclei and BSM
    entries are irrelevant to partial-wave analyses and would only bloat the
    shipped JSON (~71 KB for 599 entries).
    """
    con = sqlite3.connect(str(DB))
    try:
        rows = con.execute(
            "SELECT name, mcid, cc_type, charge, quantum_j, quantum_p, "
            "quantum_c, quantum_g, quantum_i FROM pdgparticle WHERE mcid IS NOT NULL"
        ).fetchall()
    finally:
        con.close()

    out: dict[str, dict] = {}
    for name, mcid, cc_type, charge, j_raw, p_raw, c_raw, g_raw, i_raw in rows:
        try:
            p = api.get_particle_by_mcid(int(mcid))
        except Exception:
            continue
        if not (p.is_meson or p.is_baryon or p.is_lepton or name == "gamma"):
            continue
        self_conj = cc_type == "S"
        entry: dict = {"name": name, "ccType": cc_type, "selfConjugate": self_conj}
        if charge is not None:
            entry["charge"] = charge
        # Mass in GeV (summary property). Some states (K(L)0, ...) have no
        # mass property and raise — omit rather than fail.
        try:
            mass = p.mass
            if mass:
                entry["mass"] = round(float(mass), 6)
        except Exception:
            pass
        j = parse_j(j_raw)
        if j is not None:
            entry["j"] = int(j) if float(j).is_integer() else j
        if p_raw in ("+", "-"):
            entry["p"] = 1 if p_raw == "+" else -1
        if self_conj:
            if c_raw in ("+", "-"):
                entry["c"] = 1 if c_raw == "+" else -1
            if g_raw in ("+", "-"):
                entry["g"] = 1 if g_raw == "+" else -1
        else:
            try:
                anti = p.antiparticle
                if (
                    anti is not None
                    and anti.mcid is not None
                    and int(anti.mcid) != int(mcid)
                ):
                    entry["conjugate"] = int(anti.mcid)
            except Exception:
                # K(S)0 / K(L)0: no distinct antiparticle block (the API goes
                # looking for -310 and raises). Leave `conjugate` unset.
                pass
        if i_raw not in (None, "?"):
            entry["i"] = i_raw
        out[str(int(mcid))] = entry
    return out


def quantum_c(name: str) -> int | None:
    """C parity (+1/-1) for self-conjugate (neutral) states, else None.

    The sqlite quantum_c column is authoritative but also carries values for
    charged multiplet members (e.g. rho(770)+), where C is physically
    undefined — we only accept charge == 0 rows. Non-C-eigenstates (K0, D0,
    B0, K(S)0, ...) have NULL quantum_c and stay None, which is exactly the
    conservative behavior the plugin wants.
    """
    con = sqlite3.connect(str(DB))
    try:
        row = con.execute(
            "SELECT charge, quantum_c FROM pdgparticle WHERE name=?", (name,)
        ).fetchone()
        # '?' is the "unknown" sentinel (K(3100), X(3940), ...) — never a value.
        if not row or row[0] != 0.0 or row[1] not in ("+", "-"):
            return None
        return 1 if row[1] == "+" else -1
    finally:
        con.close()


def extract_measurements(particle, max_n: int = 6) -> list[dict]:
    """Individual MASS measurements (newest first), converted to GeV.

    PdgParticle.mass_measurements() yields one PdgMeasurement per experiment;
    each carries technique/comment/reference (DOI, Inspire ID, year) and a
    PdgValue with value/errors (stat & syst separated) plus used_in_average.
    Values come in MeV from the database; GeV is the plugin convention.
    """
    out: list[dict] = []
    try:
        for m in particle.mass_measurements():
            try:
                v = m.get_value()
            except Exception:
                continue
            value = getattr(v, "value", None)
            if value is None:
                continue
            unit = getattr(v, "unit_text", "") or ""
            scale = 0.001 if "MeV" in unit else 1.0
            ref = getattr(m, "reference", None)
            year = None
            if ref is not None:
                try:
                    year = int(getattr(ref, "publication_year", None) or 0) or None
                except (TypeError, ValueError):
                    year = None
            entry: dict = {
                "year": year,
                "publication": getattr(ref, "publication_name", None) if ref else None,
                "doi": getattr(ref, "doi", None) if ref else None,
                "inspireId": getattr(ref, "inspire_id", None) if ref else None,
                "technique": getattr(m, "technique", None) or None,
                "comment": (getattr(m, "comment", None) or "")[:80] or None,
                "value": round(float(value) * scale, 6),
            }
            for src, dst in [
                ("error_positive", "errorPositive"),
                ("error_negative", "errorNegative"),
                ("stat_error_positive", "statError"),
                ("syst_error_positive", "systError"),
            ]:
                raw = getattr(v, src, None)
                if raw is not None:
                    entry[dst] = round(float(raw) * scale, 6)
            entry["usedInAverage"] = bool(getattr(v, "used_in_average", False))
            out.append({k: x for k, x in entry.items() if x is not None})
            if len(out) >= max_n:
                break
    except Exception:
        # Measurements are enrichment, never a hard failure.
        pass
    return out


def main() -> int:
    db_url = f"sqlite:///{DB}"
    api = PdgApi(db_url)
    # **输入 = 查询名单**（不再从输出文件里读种子：那会让手改的内容自动"转正"）
    seed = json.loads(QUERY.read_text())["resonances"]

    # Merge the baryon sector (idempotent): the curated table is meson-only, so
    # without this every N*/Delta* proposal is rejected as 'not-on-pdg'.
    known = {normalize_seed_name(e["id"]) for e in seed}
    for e in seed:
        known.update(normalize_seed_name(a) for a in e.get("aliases", []))
    added = 0
    for b in discover_baryons(api):
        if normalize_seed_name(b["id"]) in known:
            continue
        seed.append(b)
        known.add(normalize_seed_name(b["id"]))
        added += 1
    if added:
        print(f"[fetch_pdg] +{added} baryon seed entries (N*/Delta*, half-integer J)")
    # Keep a stable, human-diffable order.
    seed.sort(key=lambda e: (e.get("mass") or 0.0, e["id"]))

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
        c = quantum_c(hit.name)
        # Charged states (id ends with + or -) never carry C, even when the
        # API fuzzy-match returned the neutral multiplet member (e.g.
        # to_pdg_name strips the charge and "rho(770)+" resolves to the 0).
        if c is not None and not re.search(r"[+-]$", e["id"]):
            e["c"] = c
        else:
            e.pop("c", None)
        ms = extract_measurements(hit)
        if ms:
            e["measurements"] = ms
        e["status"] = "pdg"
        n_hit += 1

    # pdg.json 只放**官方命中**：未命中的名字要么是拼写问题，要么确实不在 PDG
    # （后者应登记到 data/local-states.json，而不是混进这张"官方事实"表）。
    kept = [e for e in seed if e.get("status") == "pdg"]
    dropped = [e.get("id") for e in seed if e.get("status") != "pdg"]
    out = {
        "schemaVersion": "0.6.0",
        "source": "pdg-2026 official package (fetch_pdg.py; pure PDG)",
        "resonances": kept,
        "particles": extract_particles(api),
    }
    OUT_NEXT.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"[fetch_pdg] {len(kept)} PDG entries prepared ({n_hit} enriched); "
          f"particles table: {len(out['particles'])} mcids -> {OUT_NEXT}")
    if dropped:
        print(f"[fetch_pdg] {len(dropped)} names did NOT match PDG: {', '.join(sorted(dropped))}")
        # **绝不静默丢数据**：同步必须由人确认。设 ALLOW_PDG_DROP=1 才允许丢。
        if os.environ.get("ALLOW_PDG_DROP") != "1":
            print("[fetch_pdg] ❌ 中止同步：现有 pdg.json 未被覆盖。"
                  "请检查名字转换（tex→PDG 拼写），确需丢弃请设 ALLOW_PDG_DROP=1。")
            try:
                OUT_NEXT.unlink()
            except FileNotFoundError:
                pass
            return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
