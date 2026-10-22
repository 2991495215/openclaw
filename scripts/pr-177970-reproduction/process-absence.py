#!/usr/bin/env python3
"""Read-only absence guard using the shared proof's kernel identity reader."""
import ctypes
import errno
import json
import os
from pathlib import Path
import runpy
import sys

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

if __name__ == "__main__":
    require_runner()
    source, bundle = map(guarded_path, sys.argv[1:])
    bundle = bundle.resolve(strict=True)
    kernel = Kernel(source)
    remaining = []
    for pid in kernel.pids(os.getuid()):
        row = kernel.read(pid)
        if row is not None and Path(row["executable"]).is_relative_to(bundle):
            remaining.append(row)
    print(json.dumps({"remaining": remaining, "bundle": str(bundle)}, indent=2))
    if remaining:
        raise SystemExit("Bundle process remains; refusing another proof cell")
