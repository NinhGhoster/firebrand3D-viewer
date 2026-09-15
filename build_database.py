#!/usr/bin/env python3
"""Build database.json for the firebrand viewer from the Level 2 release.

Replaces the orsu version, which walked the tree and parsed positions out of paths like
``3D/branchlet/{variant}/{exp_order}/``. That structure no longer exists: the roots were
renamed (3D -> 3D_shapes, RGB -> RGB_videos, thermal -> thermal_videos, sheet ->
data_sheets), stringybark became fibrous_bark, and the fibrous bark sheets were split into
per-rate folders.

Rather than port the path parsing, this reads the index files the release ships —
firebrand_manifest.csv, experiment_media.csv and thermal_acquisition_parameters.csv. They
already carry mesh and media paths in the new form, so there is nothing to parse and nothing
to re-break at the next restructure.

What this emits beyond the old builder, and why each is needed:

  firebrand_uid    'File (ID)' recurs between fuel trees — S10a_mesh_1 exists in more than
                   one — and using it as identity has already biased one join. The release
                   ships firebrand_uid for exactly this reason.
  v_sa_mm          volume / surface area, the measure the research characterises firebrand
                   morphology with. The viewer had no column for it at all.
  flags            every record carries a data_quality_flag. 3,787 have no measured mass and
                   62 sit at the balance's 0.001 g floor; without the flag the viewer shows
                   the floor as though it were a reading.
  facets           species, hazard rating, structure, trunk section, sample length. Each fuel
                   family is described by different factors, so one fixed filter set cannot
                   serve all four.
  title            a readable run name. The raw id is a machine string with pipes and slashes.
  thermal          per-record threshold and frame rate. The viewer's colour bar was hardcoded
                   to 270-1000 K; the data is degrees Celsius on a per-record span.

Usage:  python3 build_database.py [LEVEL2_DIR] [OUTPUT_JSON]
"""
import csv
import json
import os
import re
import sys

# Caddy serves /mnt/firebrand3d under /media/, so level2/3D_shapes/x.drc is reachable at
# /media/level2/3D_shapes/x.drc. The manifest stores paths relative to level2/.
MEDIA_PREFIX = os.environ.get("MEDIA_PREFIX", "/media/level2/")

LEVEL2 = sys.argv[1] if len(sys.argv) > 1 else "/mnt/firebrand3d/level2"
OUTPUT = sys.argv[2] if len(sys.argv) > 2 else "database.json"

# A flag value of 'ok' means the record is fine; the column is never empty, so presence of a
# flag is not itself a problem. Only these say something is wrong with the measurement.
REAL_FLAGS = {
    "no_mass": "Mass was not measured for this firebrand",
    "mass_at_balance_floor": "Mass sits at the balance's smallest readable increment (0.001 g), so it is a limit, not a reading",
    "density_implausible": "Density falls outside the plausible range, so it is not meaningful",
    "volume_below_1mm3": "Volume is below 1 mm3, at the edge of what the scanner resolves",
    "no_rgb": "No RGB recording survives for this run",
    "no_thermal": "No thermal recording survives for this run",
}

SPECIES_LABEL = {
    "E_obliqua": "E. obliqua", "E_radiata": "E. radiata", "E_rubida": "E. rubida",
    "E_melliodora": "E. melliodora", "Eucalyptus": "Eucalyptus",
    "Acacia": "Acacia", "Pine": "Pine",
}
FAMILY_LABEL = {
    "branchlet": "Branchlet", "fibrous_bark": "Fibrous bark", "candlebark": "Candlebark",
    "preliminary_branchlet_test": "Preliminary branchlet test",
}
# 'BL' is the paper's shorthand for branchlet and means nothing to a reader arriving here,
# so it is spelled out. Candlebark forms are capitalised for display only; the directory
# names stay lower case.
STRUCTURE_LABEL = {
    "BL_leafy": "Leafy branchlet",
    "BL_leafless": "Leafless branchlet",
    "Twigs": "Separated twigs",
    "cylindrical": "Cylindrical",
    "flat": "Flat",
}


def pretty(value):
    """Very_high -> Very high. Underscores are a directory convention, not prose."""
    return value.replace("_", " ") if value else value


def structure_label(value):
    return STRUCTURE_LABEL.get(value, pretty(value)) if value else None


def num(value):
    """Manifest blanks mean 'not measured', which must reach the viewer as null."""
    if value in (None, ""):
        return None
    try:
        return float(value)
    except ValueError:
        return None


def prefixed(path):
    return MEDIA_PREFIX + path if path else None


def build_title(r, family):
    """A run name a person can read, composed from whichever factors describe this family."""
    sp = SPECIES_LABEL.get(r.get("species_short", ""), r.get("species_short", ""))
    hrr = f"{int(float(r['nominal_hrr_kw']))} kW" if r.get("nominal_hrr_kw") else None
    if family == "fibrous_bark":
        parts = [sp, pretty(r.get("hazard_rating")), hrr, r.get("trunk_section")]
    elif family == "candlebark":
        parts = [sp, hrr, structure_label(r.get("fuel_structure")), r.get("initial_sample_size"),
                 f"rep {r['repetition_id']}" if r.get("repetition_id") else None]
    elif family == "preliminary_branchlet_test":
        parts = ["Preliminary test", sp,
                 f"rep {r['repetition_id']}" if r.get("repetition_id") else None]
    else:
        parts = [sp, hrr, structure_label(r.get("fuel_structure")),
                 f"rep {r['repetition_id']}" if r.get("repetition_id") else None]
    return " · ".join(p for p in parts if p)


def main():
    paths = {n: os.path.join(LEVEL2, n) for n in
             ("firebrand_manifest.csv", "experiment_media.csv",
              "thermal_acquisition_parameters.csv")}
    for name, p in paths.items():
        if not os.path.isfile(p):
            sys.exit(f"FATAL: {p} not found — is {LEVEL2} the Level 2 release?")

    with open(paths["firebrand_manifest.csv"], encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    with open(paths["experiment_media.csv"], encoding="utf-8") as f:
        media = list(csv.DictReader(f))
    with open(paths["thermal_acquisition_parameters.csv"], encoding="utf-8") as f:
        thermal_params = {r["thermal_record"]: r for r in csv.DictReader(f)}

    # Media first, so each run carries every recording rather than the one its first mesh
    # happened to name. A trailing letter on a section (S13a, S13b) is a continuation segment
    # of one recording, so these are parts of an experiment, not separate experiments.
    # experiment_media.csv mis-assigns media in one case: fibrous_bark|E_radiata/High/150kW|S16
    # has no plain S16.mp4 (only the S16a and S16b segments), and the manifest builder fell
    # back to claiming every file in the folder — so that experiment is credited with nine
    # recordings belonging to other trunk sections. Guard on the section base, where a
    # trailing letter marks a continuation segment of the same recording, so S16, S16a and
    # S16b match but S13 does not. This protects the viewer; the release still needs fixing.
    section_base = lambda s: re.sub(r"[a-z]$", "", s)
    rgb, thermal, dropped = {}, {}, []
    for m in media:
        eid = m["experiment_id"]
        if eid.startswith("fibrous_bark|"):
            section = eid.rsplit("|", 1)[-1]
            stem = os.path.basename(m["media_path"]).rsplit(".", 1)[0]
            if section_base(stem) != section_base(section):
                dropped.append((eid, m["media_path"]))
                continue
        bucket = rgb if m["media_kind"] == "RGB" else thermal
        bucket.setdefault(eid, []).append(m["media_path"])

    runs = {}
    for r in rows:
        eid = r["experiment_id"]
        run = runs.get(eid)
        if run is None:
            family = r["fuel_family"]
            length = None
            if r.get("initial_sample_size"):
                match = re.search(r"\d+(?:\.\d+)?", r["initial_sample_size"])
                if match:
                    length = float(match.group())

            # Thermal segments carry their own encoded span; the viewer's colour bar was
            # previously hardcoded to a single range in the wrong unit.
            segs = []
            for p in sorted(thermal.get(eid, [])):
                tp = thermal_params.get(p, {})
                # The sidecar beside each thermal video carries the frame size and the
                # temperature range the greyscale was encoded against. Reading it here means
                # the viewer can size the frame and label the scale from data, instead of
                # waiting on the video element's metadata and guessing 16:9 until it arrives.
                side = {}
                jp = os.path.join(LEVEL2, os.path.splitext(p)[0] + ".json")
                if os.path.isfile(jp):
                    try:
                        with open(jp, encoding="utf-8") as jf:
                            side = json.load(jf)
                    except (ValueError, OSError):
                        side = {}
                segs.append({
                    "path": prefixed(p),
                    "label": os.path.basename(p).rsplit(".", 1)[0],
                    "threshold_degC": num(tp.get("threshold_degC")),
                    "frame_rate": num(tp.get("frame_rate")),
                    "num_frames": int(tp["num_frames"]) if tp.get("num_frames") else None,
                    "width": side.get("width"),
                    "height": side.get("height"),
                    "min_degC": side.get("min_val"),
                    "max_degC": side.get("max_val"),
                })

            run = runs[eid] = {
                "id": eid,
                "title": build_title(r, family),
                "fuel_type": family,
                "fuel_label": FAMILY_LABEL.get(family, pretty(family)),
                "species": SPECIES_LABEL.get(r.get("species_short", ""), r.get("species_short") or None),
                "hazard_rating": pretty(r.get("hazard_rating")) or None,
                "structure": structure_label(r.get("fuel_structure")),
                "trunk_section": r.get("trunk_section") or None,
                "diameter_class": r.get("diameter_class") or None,
                "variant": None,      # filled below, family-dependent
                "experiment_order": r.get("repetition_id") or None,
                "hrr_kw": int(float(r["nominal_hrr_kw"])) if r.get("nominal_hrr_kw") else None,
                "sample_length_cm": length,
                "size_class": None,   # filled below
                "rgb_videos": [prefixed(p) for p in sorted(rgb.get(eid, []))],
                "thermal_videos": [s["path"] for s in segs],
                "thermal_segments": segs,
                "firebrands": [],
            }
            # variant is the run's subtitle and size_class its grouping label; which column
            # carries them depends on the family, since each is described differently.
            if family == "fibrous_bark":
                run["variant"], run["size_class"] = run["hazard_rating"], run["trunk_section"]
            elif family == "candlebark":
                run["variant"], run["size_class"] = run["structure"], r.get("initial_sample_size") or None
            else:
                run["variant"], run["size_class"] = run["species"], run["structure"]

        vol, area = num(r.get("volume_mm3")), num(r.get("surface_area_mm2"))
        raw_flags = [f for f in (r.get("data_quality_flag") or "").split(";") if f and f != "ok"]
        run["firebrands"].append({
            "uid": r["firebrand_uid"],
            "file_id": r["source_file_id"],
            "source_name": r.get("scan_batch") or None,
            "volume_mm3": vol,
            "surface_area_mm2": area,
            # The measure the research characterises morphology with, absent from the old
            # viewer entirely. Derived here so no rebuild of the release is needed.
            "v_sa_mm": round(vol / area, 4) if vol and area else None,
            "length_mm": num(r.get("length_mm")),
            "width_mm": num(r.get("width_mm")),
            "height_mm": num(r.get("height_mm")),
            "mass_g": num(r.get("mass_g")),
            "density_kg_m3": num(r.get("density_kg_m3")),
            "mesh_path": prefixed(r.get("mesh_path")),
            "flags": raw_flags,
            "flag_notes": [REAL_FLAGS.get(f, f) for f in raw_flags],
        })

    out = sorted(runs.values(), key=lambda x: (x["fuel_type"], x["title"]))
    for run in out:
        run["firebrands"].sort(key=lambda b: b["file_id"])

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    meshes = sum(len(r["firebrands"]) for r in out)
    flagged = sum(1 for r in out for b in r["firebrands"] if b["flags"])
    vsa = sum(1 for r in out for b in r["firebrands"] if b["v_sa_mm"] is not None)
    uids = {b["uid"] for r in out for b in r["firebrands"]}
    fids = {b["file_id"] for r in out for b in r["firebrands"]}
    print(f"wrote {OUTPUT}")
    print(f"  runs                 {len(out)}")
    print(f"  meshes               {meshes}")
    print(f"  unique firebrand_uid {len(uids)}   unique file_id {len(fids)}  <- why uid is needed")
    print(f"  with V/Sa            {vsa}")
    print(f"  carrying a real flag {flagged}")
    print(f"  rgb / thermal        {sum(len(r['rgb_videos']) for r in out)} / {sum(len(r['thermal_videos']) for r in out)}")
    print(f"  multi-segment runs   {sum(1 for r in out if len(r['rgb_videos']) > 1 or len(r['thermal_videos']) > 1)}")
    if dropped:
        print(f"  media DROPPED as mis-assigned in the release: {len(dropped)}")
        for eid, p_ in dropped[:12]:
            print(f"    {eid}  <-  {p_}")
    print(f"  thermal spans known  {sum(1 for r in out for s in r['thermal_segments'] if s['threshold_degC'] is not None)}")
    print(f"  thermal with min/max {sum(1 for r in out for s in r['thermal_segments'] if s.get('max_degC') is not None)}")
    print(f"  thermal with size    {sum(1 for r in out for s in r['thermal_segments'] if s.get('width'))}")
    for fam in sorted({r["fuel_type"] for r in out}):
        print(f"    {fam:28s} {sum(1 for r in out if r['fuel_type'] == fam):4d} runs")


if __name__ == "__main__":
    main()
