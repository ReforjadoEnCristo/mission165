#!/usr/bin/env python3
"""Merge one voice-logged exercise into Damian's Mission 165 JSONBin.

Reads the latest bin, writes a timestamped backup, then merges the sets into
both keys the app syncs:

  data["m165-history"]
  data["m165-setgrid-draft-<date>-<dayId>"]

Day titles and exercise totals come from the app's DAYS array. Spoken names
("Squat", "RDL") are resolved with the app's EX_NAME_ALIASES table before
anything is written. An existing set is never overwritten: a blank can be
filled, and the same set sent twice is skipped. New rows are marked
source "voice". updatedAt is bumped only when the bin actually changes.

The live bin is the default. Point --bin-url at a local mock for tests.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime

BIN_ID = "6ae6c009ac6210605a62d670"
DEFAULT_BIN_URL = "https://api.jsonbin.io/v3/b/" + BIN_ID
BACKUP_DIR = "/workspace/fitness/backups"

# Used only when index.html cannot be read. Kept in step with DAYS.
FALLBACK_DAYS = {
    1: {"title": "Lower A — Glute & Quad Strength", "total": 5},
    2: {"title": "Upper A — Back, Shoulders & Arms", "total": 8},
    3: {"title": "Lower B — Hinge & Hamstrings", "total": 6},
    4: {"title": "Full Body + Glute Finisher", "total": 9},
}
FALLBACK_ALIASES = {
    "squat": "Barbell Back Squat",
    "rdl": "Smith Romanian Deadlift",
    "romanian deadlift": "Smith Romanian Deadlift",
    "smith rdl": "Smith Romanian Deadlift",
    "leg press": "Deep Leg Press",
    "deep leg press": "Deep Leg Press",
    "leg curl": "Single-Leg Standing Leg Curl",
    "seated calf": "Seated Calf Raise",
    "hip abduction": "Seated Hip Abduction",
    "deadlift": "Deadlift (Trap Bar or Barbell)",
}


def index_candidates(explicit):
    here = os.path.dirname(os.path.abspath(__file__))
    paths = []
    if explicit:
        paths.append(explicit)
    paths.append(os.path.join(here, "..", "index.html"))
    paths.extend([
        "/workspace/m165_v4_publish/index.html",
        "/workspace/live_index.html",
    ])
    return paths


def read_index(explicit):
    for path in index_candidates(explicit):
        if path and os.path.isfile(path):
            with open(path, encoding="utf-8") as f:
                return f.read(), os.path.abspath(path)
    return "", ""


def load_access_key(html, explicit):
    if explicit:
        return explicit
    env = os.environ.get("M165_ACCESS_KEY", "").strip()
    if env:
        return env
    if html:
        m = re.search(r'var SYNC_ACCESS_KEY="([^"]+)"', html)
        if m:
            return m.group(1)
    raise RuntimeError("Could not find SYNC_ACCESS_KEY (pass --access-key or M165_ACCESS_KEY)")


def load_program(html):
    """Pull day titles, exercise counts, names, and aliases out of index.html."""
    if not html:
        return {
            "days": {i: dict(v) for i, v in FALLBACK_DAYS.items()},
            "names": set(FALLBACK_ALIASES.values()),
            "aliases": dict(FALLBACK_ALIASES),
            "source": "fallback",
        }
    days = {}
    names = set()
    for m in re.finditer(r'\{id:(\d+),title:"([^"]+)",sub:"[^"]*",exercises:\[(.*?)\]\s*\}', html, re.S):
        day_id = int(m.group(1))
        body = m.group(3)
        found = re.findall(r'X\("([^"]+)"', body)
        names.update(found)
        days[day_id] = {"title": m.group(2), "total": len(found), "names": found}
    aliases = {}
    block = re.search(r"var EX_NAME_ALIASES=\{(.*?)\};", html, re.S)
    if block:
        aliases = {k.lower(): v for k, v in re.findall(r'"([^"]+)":"([^"]+)"', block.group(1))}
    if not days:
        days = {i: dict(v) for i, v in FALLBACK_DAYS.items()}
        names = set(FALLBACK_ALIASES.values())
        source = "fallback"
    else:
        source = "index.html"
    if not aliases:
        aliases = dict(FALLBACK_ALIASES)
    return {"days": days, "names": names, "aliases": aliases, "source": source}


def resolve_exercise(name, program):
    raw = (name or "").strip()
    if not raw:
        return ""
    if raw in program["names"]:
        return raw
    key = raw.lower()
    if key in program["aliases"]:
        return program["aliases"][key]
    for known in program["names"]:
        if known.lower() == key:
            return known
    return raw


def norm_load(v):
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        return v
    s = str(v).strip()
    if not s:
        return None
    try:
        n = float(s)
    except ValueError:
        return s
    if n.is_integer():
        return int(n)
    return n


def same_load(a, b):
    return norm_load(a) == norm_load(b)


def blank(v):
    return norm_load(v) is None


def merge_sets(existing, incoming):
    """Union by set number. Never replace a number that is already filled.

    Returns (rows, changed, skipped).
    """
    by_n = {}
    for s in existing or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            continue
        if n < 1:
            continue
        by_n[n] = dict(s)
    changed = False
    skipped = 0
    for s in incoming or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            n = (max(by_n) if by_n else 0) + 1
        if n < 1:
            n = (max(by_n) if by_n else 0) + 1
        weight = s.get("weight", None)
        reps = s.get("reps", None)
        note = s.get("note") or ""
        if n in by_n:
            cur = by_n[n]
            if (not blank(weight) and not blank(reps)
                    and same_load(cur.get("weight"), weight)
                    and same_load(cur.get("reps"), reps)):
                skipped += 1
                continue
            filled = False
            if blank(cur.get("weight")) and not blank(weight):
                cur["weight"] = norm_load(weight)
                filled = True
            if blank(cur.get("reps")) and not blank(reps):
                cur["reps"] = norm_load(reps)
                filled = True
            if not cur.get("note") and note:
                cur["note"] = note
                filled = True
            if filled:
                changed = True
                if not cur.get("source"):
                    cur["source"] = "voice"
                if cur.get("confirmed") is not True:
                    cur["confirmed"] = True
            else:
                # Incoming disagreed with a number already stored. Keep the stored one.
                skipped += 1
            continue
        entry = {
            "n": n,
            "weight": norm_load(weight),
            "reps": norm_load(reps),
            "note": note,
            "confirmed": True,
            "source": "voice",
        }
        by_n[n] = entry
        changed = True
    rows = [by_n[k] for k in sorted(by_n)]
    return rows, changed, skipped


def format_weight_summary(sets):
    parts = []
    for s in sets:
        w = norm_load(s.get("weight"))
        r = norm_load(s.get("reps"))
        if w is not None and r is not None:
            parts.append(f"{w}x{r}")
        elif r is not None:
            parts.append(f"BWx{r}")
        elif w is not None:
            parts.append(f"{w}x—")
    return ", ".join(parts)


def parse_json_field(val, default):
    if val is None:
        return default
    if isinstance(val, str):
        try:
            return json.loads(val)
        except Exception:
            return default
    return val


def fetch_bin(url, key):
    out = subprocess.run(
        ["curl", "-sS", "-f", "-H", f"X-Access-Key: {key}",
         "-H", "User-Agent: Mozilla/5.0", url.rstrip("/") + "/latest"],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)["record"]


def put_bin(url, key, payload):
    out = subprocess.run(
        ["curl", "-sS", "-f", "-X", "PUT",
         "-H", "Content-Type: application/json",
         "-H", f"X-Access-Key: {key}",
         "-H", "User-Agent: Mozilla/5.0",
         "--data-binary", "@-", url.rstrip("/")],
        input=json.dumps(payload), capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def _union_keep(primary, extra):
    """Combine set rows. primary wins when both already have a number."""
    by_n = {}
    for s in primary or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            continue
        if n >= 1:
            by_n[n] = dict(s)
    for s in extra or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            continue
        if n < 1:
            continue
        if n not in by_n:
            by_n[n] = dict(s)
            continue
        cur = by_n[n]
        if blank(cur.get("weight")) and not blank(s.get("weight")):
            cur["weight"] = s.get("weight")
        if blank(cur.get("reps")) and not blank(s.get("reps")):
            cur["reps"] = s.get("reps")
        if not cur.get("note") and s.get("note"):
            cur["note"] = s.get("note")
        if not cur.get("source") and s.get("source"):
            cur["source"] = s.get("source")
    return [by_n[k] for k in sorted(by_n)]


def history_set(row):
    return {
        "n": int(row["n"]),
        "weight": norm_load(row.get("weight")),
        "reps": norm_load(row.get("reps")),
        "note": row.get("note") or "",
        "confirmed": bool(row.get("confirmed")),
        "source": row.get("source") or "",
    }


def align_sets(grid_rows, hist_rows):
    """One list for the card and for history. A filled grid cell wins."""
    by_n = {}
    for s in hist_rows or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            continue
        if n >= 1:
            by_n[n] = dict(s)
    for s in grid_rows or []:
        try:
            n = int(s.get("n"))
        except (TypeError, ValueError):
            continue
        if n < 1:
            continue
        if n not in by_n:
            by_n[n] = dict(s)
            continue
        cur = by_n[n]
        if not blank(s.get("weight")):
            cur["weight"] = norm_load(s.get("weight"))
        if not blank(s.get("reps")):
            cur["reps"] = norm_load(s.get("reps"))
        if s.get("note") and not cur.get("note"):
            cur["note"] = s.get("note")
        if s.get("source") == "manual" or (s.get("source") and not cur.get("source")):
            cur["source"] = s.get("source")
        if s.get("confirmed"):
            cur["confirmed"] = True
        by_n[n] = cur
    return [by_n[k] for k in sorted(by_n)]


def grid_flags(row):
    flagged = dict(row)
    if flagged.get("source") == "voice":
        flagged["planned"] = False
    elif "planned" not in flagged:
        flagged["planned"] = False
    return flagged


def apply_voice_log(data, program, date, day_id, exercise, incoming_sets, day_title=None):
    """Merge into a data object. Returns a result dict. Does not mutate callers' lists."""
    data = dict(data or {})
    canon = resolve_exercise(exercise, program)
    day = program["days"].get(day_id) or {}
    title = day_title or day.get("title") or f"Day {day_id}"
    total = day.get("total") or 0
    session_id = f"{date}-{day_id}"
    known = canon in program["names"]

    history = parse_json_field(data.get("m165-history"), [])
    if not isinstance(history, list):
        history = []
    sess = next((h for h in history if isinstance(h, dict) and h.get("id") == session_id), None)
    created = sess is None
    if sess is None:
        sess = {
            "id": session_id,
            "date": date,
            "dayId": day_id,
            "dayTitle": title,
            "doneCount": 0,
            "total": total or 6,
            "durationMin": None,
            "exercises": [],
        }
        history.append(sess)
    else:
        stale = {
            "Upper A — Chest, Back & Arms",
            "Lower B — Glute & Hamstring Focus",
            "Monday — Conditioning / Recovery",
        }
        if not sess.get("dayTitle") or sess.get("dayTitle") in stale:
            sess["dayTitle"] = title
        if total and (not sess.get("total") or (int(sess.get("total") or 0) == 6 and total != 6)):
            sess["total"] = total

    exercises = sess.setdefault("exercises", [])
    ex = next((e for e in exercises if isinstance(e, dict) and (e.get("name") == canon or resolve_exercise(e.get("name") or "", program) == canon)), None)
    if ex is None:
        ex = {"name": canon, "weight": "", "bonus": "", "topSet": None, "sets": []}
        exercises.append(ex)
    elif ex.get("name") != canon:
        ex["name"] = canon

    hist_rows, hist_changed, hist_skipped = merge_sets(ex.get("sets"), incoming_sets)

    grid_key = f"m165-setgrid-draft-{session_id}"
    grid = parse_json_field(data.get(grid_key), {})
    if not isinstance(grid, dict):
        grid = {}
    # Fold any alias key already stored under this exercise into the canonical name.
    existing_rows = []
    alias_keys = []
    for key in list(grid.keys()):
        if not key or str(key).startswith("_"):
            continue
        if resolve_exercise(key, program) == canon and isinstance(grid.get(key), list):
            # Canonical rows win over an alias copy of the same set number.
            if key == canon:
                existing_rows = _union_keep(grid[key], existing_rows)
            else:
                alias_keys.append(key)
    for key in alias_keys:
        existing_rows = _union_keep(existing_rows, grid[key])
        del grid[key]
    grid_rows, grid_changed, grid_skipped = merge_sets(existing_rows, incoming_sets)
    aligned = align_sets(grid_rows, hist_rows)
    ex["sets"] = [history_set(row) for row in aligned]
    ex["weight"] = format_weight_summary(ex["sets"])
    sess["doneCount"] = len(exercises)
    grid[canon] = [grid_flags(row) for row in aligned]

    changed = created or hist_changed or grid_changed
    # Title/total repairs count as a change too.
    data["m165-history"] = json.dumps(history)
    data[grid_key] = json.dumps(grid)
    return {
        "data": data,
        "changed": changed,
        "skipped": hist_skipped,
        "grid_skipped": grid_skipped,
        "exercise": canon,
        "known": known,
        "session_id": session_id,
        "grid_key": grid_key,
        "set_count": len(aligned),
        "day_title": sess.get("dayTitle") or title,
        "total": sess.get("total"),
    }


def backup_record(rec, backup_dir):
    os.makedirs(backup_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(backup_dir, f"bin_backup_{ts}.json")
    # Avoid clobbering a backup written in the same second.
    n = 1
    while os.path.exists(path):
        path = os.path.join(backup_dir, f"bin_backup_{ts}_{n}.json")
        n += 1
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2)
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Merge a voice-logged exercise into the Mission 165 bin.")
    ap.add_argument("--date", help="YYYY-MM-DD")
    ap.add_argument("--day-id", type=int, choices=[1, 2, 3, 4])
    ap.add_argument("--exercise", help="Exercise name or spoken alias, e.g. RDL")
    ap.add_argument("--sets-json", help='JSON list e.g. [{"n":1,"weight":185,"reps":10}]')
    ap.add_argument("--day-title", default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--bin-url", default=DEFAULT_BIN_URL, help="Bin URL without /latest. Defaults to the live bin.")
    ap.add_argument("--access-key", default=None)
    ap.add_argument("--backup-dir", default=BACKUP_DIR)
    ap.add_argument("--index", default=None, help="index.html to read day names and the access key from")
    ap.add_argument("--print-program", action="store_true", help="Print day titles and totals as JSON, then exit")
    args = ap.parse_args(argv)

    html, index_path = read_index(args.index)
    program = load_program(html)
    if args.print_program:
        days_out = {str(i): {"title": d["title"], "total": d["total"]} for i, d in sorted(program["days"].items())}
        json.dump({"source": program["source"], "index": index_path, "days": days_out,
                   "aliasCount": len(program["aliases"])}, sys.stdout)
        print()
        return 0

    if not args.date or args.day_id is None or not args.exercise or not args.sets_json:
        ap.error("--date, --day-id, --exercise, and --sets-json are required")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", args.date):
        ap.error("--date must be YYYY-MM-DD")

    incoming = json.loads(args.sets_json)
    if not isinstance(incoming, list) or not incoming:
        ap.error("--sets-json must be a non-empty list")

    key = load_access_key(html, args.access_key)
    rec = fetch_bin(args.bin_url, key)
    backup_path = backup_record(rec, args.backup_dir)
    data = dict(rec.get("data") or {})
    # Remember the pre-merge encoding so a pure duplicate does not rewrite the bin.
    before = json.dumps(data, sort_keys=True, default=str)
    result = apply_voice_log(data, program, args.date, args.day_id, args.exercise, incoming, args.day_title)
    after = json.dumps(result["data"], sort_keys=True, default=str)
    changed = result["changed"] or before != after

    if not result["known"]:
        print(f"WARNING: '{args.exercise}' is not a program exercise. Stored as '{result['exercise']}'. The card will not show it until the name matches.", file=sys.stderr)

    if not changed:
        print(f"NO CHANGE | duplicate or already logged | backup={backup_path} | session={result['session_id']} | exercise={result['exercise']} | sets={result['set_count']} | skipped={result['skipped']}")
        return 0

    old_ts = int(rec.get("updatedAt") or 0)
    new_ts = max(int(time.time() * 1000), old_ts + 1000)
    payload = {"updatedAt": new_ts, "data": result["data"]}
    if args.dry_run:
        print(f"DRY-RUN OK | backup={backup_path} | session={result['session_id']} | exercise={result['exercise']} | sets={result['set_count']} | title={result['day_title']} | updatedAt={new_ts}")
        return 0
    put_bin(args.bin_url, key, payload)
    print(f"SYNCED OK | backup={backup_path} | session={result['session_id']} | exercise={result['exercise']} | sets={result['set_count']} | title={result['day_title']} | updatedAt={new_ts}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        sys.stderr.write((e.stderr or e.stdout or str(e)) + "\n")
        sys.exit(1)
