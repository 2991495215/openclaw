#!/usr/bin/env python3
"""Interleaved, isolated macOS runtime-layout measurements from a pinned manifest."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time


def load_runtime():
    spec = importlib.util.spec_from_file_location(
        "bench_runtime", Path(__file__).with_name("bench-desktop-runtime-probe.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summary(values):
    return {"n": len(values), "median": statistics.median(values),
            "min": min(values), "max": max(values)} if values else None


def save(output, result):
    temporary = output / "results.json.tmp"
    temporary.write_text(json.dumps(result, indent=2) + "\n")
    temporary.replace(output / "results.json")


def summarize_trials(result):
    result["counts"] = {}
    for variant in result["manifest"]["variants"]:
        rows = [row for row in result["trials"] if row["variant"] == variant["name"]]
        passed = [row for row in rows if row["success"]]
        result["counts"][variant["name"]] = {
            "attempted": len(rows), "successful": len(passed), "failed": len(rows) - len(passed)}
        result["summary"][variant["name"]] = {
            key: summary([row[key] for row in passed if isinstance(row.get(key), (int, float))])
            for key in ("cold_ready_s", "warm_ready_s", "agent_cli_s", "agent_runtime_ms",
                        "rss_ready_kib", "rss_post_turn_kib", "cpu_ready_s", "cpu_post_turn_s")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    args.output = args.output.resolve()
    if args.trials < 5:
        parser.error("At least five interleaved trials are required")
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text())
    result = {"schema": 1, "started": time.time(), "host": {
        "platform": platform.platform(), "machine": platform.machine(),
        "cpu_count": os.cpu_count(), "load_start": os.getloadavg()},
        "manifest": manifest, "trials": [], "summary": {}}
    runtime = load_runtime()
    for index in range(1, args.trials + 1):
        for variant in manifest["variants"]:
            if not variant.get("command"):
                continue
            name = variant["name"]
            trial = args.output / "trials" / f"{index:02d}-{name}"
            row = runtime.measure(variant, trial, args.timeout, doctor=index == 1)
            row.update(variant=name, index=index)
            result["trials"].append(row)
            save(args.output, result)
            print(json.dumps(row), flush=True)
    summarize_trials(result)
    result["finished"] = time.time()
    result["host"]["load_end"] = os.getloadavg()
    save(args.output, result)


if __name__ == "__main__":
    main()
