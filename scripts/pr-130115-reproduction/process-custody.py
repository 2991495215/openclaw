#!/usr/bin/env python3
"""Task-owned Darwin process census shared by observation and cleanup.

The maintained PR helper supplies the native ABI. Titles/argv are never identity.
Only the disposable runner may create a ledger or deliver a signal.
"""
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import runpy
import signal
import sys
import time


def guarded_path(value):
    root = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    path = Path(value).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("Process custody path escaped RUNNER_TEMP")
    return path


def require_runner():
    if not (sys.platform == "darwin" and os.environ.get("GITHUB_ACTIONS") == "true" and
            os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"):
        raise RuntimeError("Process custody requires the disposable macOS runner")


def key(row):
    return f'{row["pid"]}:{row["start"]}:{row["uid"]}'


def parent_of(row, rows):
    parent = rows.get(row["parent"])
    # A later-born process cannot be this child's parent after PID reuse.
    born = lambda value: tuple(int(part) for part in value["start"].split(":"))
    return parent if parent is not None and born(parent) <= born(row) else None


class Kernel:
    def __init__(self, source):
        # Reuse the checked-out main's maintenance ABI, not an ambient package.
        self.abi = runpy.run_path(str(guarded_path(source)))
        self.Info = self.abi["BsdInfo"]
        if ctypes.sizeof(self.Info) != 136:
            raise RuntimeError("Unsupported Darwin process ABI")
        self.lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        self.lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_pidinfo.restype = ctypes.c_int
        self.lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        self.lib.proc_pidpath.restype = ctypes.c_int
        self.lib.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        self.lib.proc_listpids.restype = ctypes.c_int

    def birth(self, pid):
        info = self.Info()
        ctypes.set_errno(0)
        size = self.lib.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
        error = ctypes.get_errno()
        if size <= 0 and error == errno.ESRCH:
            return None
        if size != 136 or error or info.pid != pid or info.start_usec >= 1_000_000 or info.status not in self.abi["STATES"]:
            raise RuntimeError(f"Incomplete kernel identity for PID {pid}: bytes={size}, errno={error}")
        if info.status == 5:  # A zombie cannot run or retain a child; its parent still reaps it.
            return None
        return {"pid": pid, "parent": info.ppid, "uid": info.uid,
                "start": f"{info.start_sec}:{info.start_usec}", "group": info.pgid}

    def read(self, pid):
        before = self.birth(pid)
        if before is None:
            return None
        buffer = ctypes.create_string_buffer(4096)
        ctypes.set_errno(0)
        length = self.lib.proc_pidpath(pid, buffer, len(buffer))
        error = ctypes.get_errno()
        after = self.birth(pid)
        if after is None:
            return None
        if key(before) != key(after):
            raise RuntimeError(f"PID {pid} changed incarnation during inspection")
        if length <= 0 or error or not buffer.value.startswith(b"/"):
            raise RuntimeError(f"Kernel executable path unavailable for PID {pid}: errno={error}")
        after["executable"] = str(Path(os.fsdecode(buffer.value)).resolve(strict=True))
        return after

    def pids(self, uid):
        if type(uid) is not int or not 0 <= uid <= 0xFFFFFFFF:
            raise ValueError("Invalid custody UID")
        # PROC_UID_ONLY filters in the kernel before per-process permission checks.
        # Unlike proc_listallpids, proc_listpids returns bytes, not a PID count.
        width = ctypes.sizeof(ctypes.c_int)
        ctypes.set_errno(0)
        size = self.lib.proc_listpids(4, uid, None, 0)
        error = ctypes.get_errno()
        if size <= 0 or size % width or error:
            raise RuntimeError(f"Kernel UID census size unavailable: bytes={size}, errno={error}")
        pids = (ctypes.c_int * (size // width + 512))()
        capacity = ctypes.sizeof(pids)
        ctypes.set_errno(0)
        used = self.lib.proc_listpids(4, uid, pids, capacity)
        error = ctypes.get_errno()
        # A full/partial buffer or failed query never establishes a complete census.
        if used <= 0 or used % width or used >= capacity or error:
            raise RuntimeError(f"Kernel UID census incomplete: bytes={used}, capacity={capacity}, errno={error}")
        return [pid for pid in pids[:used // width] if pid > 1]


def initialize(file, source, roots):
    require_runner()
    file = guarded_path(file)
    kernel = Kernel(source)
    owner = kernel.read(os.getpid())
    if owner is None:
        raise RuntimeError("Custody owner identity unavailable")
    normalized = [str(guarded_path(root).resolve(strict=True)) for root in roots]
    state = {"version": 1, "source": str(guarded_path(source)), "owner": owner,
             "roots": normalized, "records": {}, "issues": [], "signals": []}
    with file.open("x") as stream:
        json.dump(state, stream)
    return refresh(file)


def census(state):
    kernel = Kernel(state["source"])
    rows, issues = {}, []
    for pid in kernel.pids(state["owner"]["uid"]):
        try:
            row = kernel.read(pid)
            if row is None:
                continue
            if row["uid"] != state["owner"]["uid"]:
                raise RuntimeError(f"PID {pid} changed UID after kernel enumeration")
            rows[pid] = row
        except (OSError, RuntimeError) as error:
            # A denied/partial inspection cannot establish that the process is foreign or gone.
            issues.append({"pid": pid, "error": str(error)})
    owner = rows.get(state["owner"]["pid"])
    if owner is None or key(owner) != key(state["owner"]) or owner["executable"] != state["owner"]["executable"]:
        issues.append({"error": "Custody owner disappeared or changed identity"})
    records = state["records"]
    selected = {key(state["owner"])}
    # Retain known incarnations after reparenting; task-exclusive paths also recover
    # a bundled process whose parent exited before the first sampling interval.
    for row in rows.values():
        ident = key(row)
        path = Path(row["executable"])
        root = next((root for root in state["roots"] if path == Path(root) or path.is_relative_to(Path(root))), None)
        if ident in records or root:
            selected.add(ident)
            if ident not in records:
                records[ident] = {"first": row, "firstSeen": time.time(), "admittedBy": {"exclusiveExecutableRoot": root},
                                  "parents": [], "executables": []}
    changed = True
    while changed:
        changed = False
        for row in rows.values():
            parent = parent_of(row, rows)
            if parent is not None and key(parent) in selected and key(row) not in selected:
                ident = key(row)
                selected.add(ident)
                records[ident] = {"first": row, "firstSeen": time.time(), "admittedBy": {"parentIdentity": key(parent)},
                                  "parents": [], "executables": []}
                changed = True
    now = time.time()
    for record in records.values():
        record["live"] = False
    for row in rows.values():
        ident = key(row)
        if ident not in records:
            continue
        record = records[ident]
        record.update({"live": True, "current": row, "lastSeen": now})
        parent = parent_of(row, rows)
        parent_key = key(parent) if parent else None
        if parent_key and parent_key not in record["parents"]:
            record["parents"].append(parent_key)
        if row["executable"] not in record["executables"]:
            record["executables"].append(row["executable"])
    state.update({"observedAt": now, "issues": issues})
    return kernel


def refresh(file, deliver=None):
    require_runner()
    file = guarded_path(file)
    with file.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = json.loads(file.read_text())
        kernel = census(state)
        if deliver:
            identity, expected_executable, name = deliver
            if name not in ("SIGTERM", "SIGKILL"):
                raise ValueError("Unsupported custody signal")
            record = state["records"].get(identity)
            if record is None:
                raise ValueError("Signal target was never admitted by custody")
            # Explicit incarnation + executable equality immediately before the syscall.
            current = kernel.read(record["first"]["pid"])
            sent = False
            if current is not None and key(current) == identity:
                if current["executable"] != expected_executable:
                    raise RuntimeError("Signal target changed executable; inspect before retrying")
                try:
                    os.kill(current["pid"], getattr(signal, name))
                    sent = True
                except ProcessLookupError:
                    pass
            state["signals"].append({"at": time.time(), "identity": identity, "executable": expected_executable,
                                      "signal": name, "sent": sent})
        temp = file.with_suffix(".writing")
        temp.write_text(json.dumps(state, indent=2) + "\n")
        temp.replace(file)
        return state


def live_rows(state):
    return [dict(record["current"], identity=ident, observedParents=record["parents"])
            for ident, record in state["records"].items() if record["live"]]


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "snapshot":
        state = refresh(sys.argv[2])
        print(json.dumps({"observedAt": state["observedAt"], "issues": state["issues"], "processes": live_rows(state)}))
    else:
        raise SystemExit("Usage: process-custody.py snapshot LEDGER")
