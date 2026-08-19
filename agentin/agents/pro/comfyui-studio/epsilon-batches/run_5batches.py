"""
run_5batches.py — submit 5 Epsilon scenario batches (100 frames) to local ComfyUI.

Reads 5 jobs files, each line format:
  prefix|positive_prompt|background_prompt

For each line:
- clones master graph JSON
- replaces `6.inputs.text` with positive_prompt
- replaces `109.inputs.text` with background_prompt
- replaces `128.inputs.save_prefix` with prefix (and prefix-derived subfolder)
- advances 4 ksampler seeds (base + 17/31/47/61 hour offsets, random within window)
- POSTs to http://127.0.0.1:8188/prompt
- writes results + audit line to log
"""

import json
import os
import time
import random
import urllib.request
import urllib.error
from pathlib import Path

BASE = "http://127.0.0.1:8188"
JOBS_DIR = Path(r"C:\Users\dkeiz\Documents\qwen\antigravity\localagent\agentin\agents\pro\comfyui-studio\epsilon-batches")
GRAPH_PATH = JOBS_DIR / "batch_graphs" / "eps_graph_master.json"
LOG_PATH = JOBS_DIR / "batch_5batches_2026-08-13.log"
OUTPUT_ROOT = r"C:\Users\dkeiz\Downloads\ComfyUI_windows_portable\ComfyUI\output\WellGenerations"

# (jobs_file, scenario_folder) — 5 batches × 20 = 100 frames
SCENARIOS = [
    ("jobs_maglev.txt",        "Eps_Maglev_Ride"),
    ("jobs_rooftop.txt",       "Eps_RooftopGarden"),
    ("jobs_capsulehotel.txt",  "Eps_CapsuleHotel"),
    ("jobs_skyport.txt",       "Eps_SkyportHall"),
    ("jobs_streetfashion.txt", "Eps_StreetFashion"),
]


def log(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def parse_jobs(path: Path):
    """Return list of (prefix, positive_prompt, background_prompt)."""
    out = []
    with open(path, "r", encoding="utf-8") as f:
        for ln in f.readlines():
            line = ln.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|", 2)
            if len(parts) != 3:
                log(f"  ! malformed line skipped: {line[:80]}...")
                continue
            out.append(tuple(parts))
    return out


def submit(graph: dict):
    """POST a workflow graph to /prompt and return the prompt_id (or error)."""
    body = json.dumps({"prompt": graph}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/prompt",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
            return data.get("prompt_id"), data, None
    except urllib.error.HTTPError as e:
        try:
            err = json.load(e)
        except Exception:
            err = {"error": str(e)}
        return None, None, err
    except Exception as e:
        return None, None, {"error": str(e)}


def build_graph(master: dict, prefix: str, positive: str, background: str, seeds: dict):
    """Return a fresh graph dict with prompts + seeds + prefix swapped in."""
    g = json.loads(json.dumps(master))  # deep copy

    # prompt nodes
    g["6"]["inputs"]["text"]  = positive
    g["109"]["inputs"]["text"] = background

    # 4 ksampler seeds advance per-frame to avoid identical compositions
    g["40"]["inputs"]["seed"]  = seeds["primary"]
    g["102"]["inputs"]["seed"] = seeds["detail_refine"]
    g["114"]["inputs"]["seed"] = seeds["prep_refine"]
    g["118"]["inputs"]["seed"] = seeds["background"]

    # output node: prefix + subfolder
    g["128"]["inputs"]["save_prefix"] = prefix
    g["128"]["inputs"]["output_path"] = OUTPUT_ROOT

    return g


def make_seeds(base: int, day: int = 20260813):
    """Deterministic per-frame seed set derived from a base seed."""
    rng = random.Random(f"epsilon-batch-{day}-{base}")
    return {
        "primary":        base,
        "detail_refine":  base + rng.randint(7, 73),
        "prep_refine":    base + rng.randint(101, 311),
        "background":     base + rng.randint(401, 887),
    }


def run_scenario(master: dict, jobs_path: Path, folder: str):
    log(f"=== scenario '{folder}' :: {jobs_path.name} ===")
    jobs = parse_jobs(jobs_path)
    log(f"  parsed {len(jobs)} jobs")
    queued, failed = 0, 0
    for idx, (prefix, pos, bg) in enumerate(jobs, 1):
        # base seed: scenario prefix * 1_000_000 + per-frame index
        seed_base = (hash(folder) & 0xFFFFFF) * 1_000 + idx * 1_000_003
        seeds = make_seeds(seed_base)

        # subfolder: prefix will already include folder, so we just save into OUTPUT_ROOT
        # ttn imageOutput prepends save_prefix to filename; subfolder is OUTPUT_ROOT itself
        # (ComfyUI defaults to creating files directly under output_path)
        full_prefix = f"{folder}_{idx:02d}_"
        graph = build_graph(master, full_prefix, pos, bg, seeds)

        pid, data, err = submit(graph)
        if err is not None:
            log(f"  [{folder} {idx:02d}/{len(jobs):02d}] FAIL seed={seed_base} :: {err}")
            failed += 1
        else:
            log(f"  [{folder} {idx:02d}/{len(jobs):02d}] queued pid={pid} seed={seed_base} prefix={full_prefix}")
            queued += 1

        time.sleep(0.08)  # tiny breathing room for /prompt endpoint

    return queued, failed


def main():
    if not GRAPH_PATH.exists():
        log(f"!! master graph missing: {GRAPH_PATH}")
        return
    if not JOBS_DIR.exists():
        log(f"!! jobs dir missing: {JOBS_DIR}")
        return

    master = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    log(f"loaded master graph :: {len(master)} nodes :: checkpoint = {master['4']['inputs']['ckpt_name']}")
    log(f"output_path -> {OUTPUT_ROOT}")

    total_q, total_f = 0, 0
    for jobs_name, folder in SCENARIOS:
        jp = JOBS_DIR / jobs_name
        if not jp.exists():
            log(f"!! jobs file missing: {jp}")
            total_f += 20
            continue
        q, f = run_scenario(master, jp, folder)
        total_q += q
        total_f += f
        log(f"  -- {folder} totals: queued={q} failed={f}")

    log(f"=== ALL DONE :: queued={total_q} failed={total_f} ===")


if __name__ == "__main__":
    main()
