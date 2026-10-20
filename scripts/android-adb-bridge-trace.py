"""Temporary GDB probe for the pinned SDK emulator's ADB bridge closures."""

import hashlib
import json
import os
import time

import gdb


# ELF virtual addresses from the official emulator 37.2.12 (16428233) binaries.
# Closure enqueueing is inlined into several callers; destroyPipe alone misses it.
TARGETS = {
    "23b788a3b87b3228558924de4cb5477e2818b3b9415d6ce27d6438cf3e462b98": {
        "destroy-pipe": 0xC2E620,
        "guest-close": 0xC2F630,
        "guest-callback-close": 0xC30150,
        "reset-active-pipe": 0xC2EAC0,
        "proxy-close": 0xC2F4B4,
        "proxy-event": 0xC2F4A0,
    },
    "2924da89cef31402e0379b643a73e4d60097239323095730fc8a78aa55b082f6": {
        "destroy-pipe": 0x11D7520,
        "guest-close": 0x11D8530,
        "guest-callback-close": 0x11D9050,
        "reset-active-pipe": 0x11D79C0,
        "proxy-close": 0x11D83B4,
        "proxy-event": 0x11D83A0,
    },
}

inferior_pid = globals().get("probe_pid", 0)
mappings = []
ready_hit = False
hit_count = 0
interrupted = False


def emit(event, **fields):
    record = {
        "event": event,
        "timeSeconds": time.time(),
        "gdbPid": os.getpid(),
        "inferiorPid": inferior_pid,
        **fields,
    }
    print("OPENCLAW_ADB_BRIDGE " + json.dumps(record, separators=(",", ":")), flush=True)


def read_mappings(executable):
    result = []
    with open(f"/proc/{inferior_pid}/maps", encoding="utf-8", errors="replace") as source:
        for line in source:
            fields = line.split(maxsplit=5)
            start, end = (int(value, 16) for value in fields[0].split("-"))
            major, minor = (int(value, 16) for value in fields[3].split(":"))
            inode = int(fields[4])
            emulator = (
                inode == executable.st_ino
                and os.makedev(major, minor) == executable.st_dev
            )
            result.append((start, end, int(fields[2], 16), emulator, inode, fields[1]))
    return result


def capture_frames():
    frames = []
    frame = gdb.newest_frame()
    while frame is not None and len(frames) < 16:
        pc = frame.pc()
        mapped = next((item for item in mappings if item[0] <= pc < item[1]), None)
        frames.append({
            "module": "emulator" if mapped is not None and mapped[3] else "other",
            "offset": pc - mapped[0] + mapped[2] if mapped is not None and mapped[4] else None,
        })
        frame = frame.older()
    return frames


def on_stop(event):
    global interrupted
    if isinstance(event, gdb.SignalEvent) and event.stop_signal == "SIGINT":
        interrupted = True


class BridgeBreakpoint(gdb.Breakpoint):
    def __init__(self, address, target, readiness=False):
        super().__init__(f"*{address:#x}", internal=True, temporary=readiness)
        self.target = target
        self.readiness = readiness
        self.silent = True

    def stop(self):
        global ready_hit, hit_count
        if self.readiness:
            ready_hit = True
            return True
        try:
            hit_count += 1
            if hit_count > 64:
                emit("error", reason="debugger-error")
                return True
            emit(
                "hit",
                target=self.target,
                tid=gdb.selected_thread().ptid[1],
                frames=capture_frames(),
            )
            return False
        except Exception:
            emit("error", reason="debugger-error")
            return True


def trace():
    global mappings
    if type(inferior_pid) is not int or inferior_pid <= 0:
        emit("error", reason="debugger-error")
        return
    executable_path = f"/proc/{inferior_pid}/exe"
    digest = hashlib.sha256()
    with open(executable_path, "rb") as executable:
        for chunk in iter(lambda: executable.read(1024 * 1024), b""):
            digest.update(chunk)
    binary_hash = digest.hexdigest()
    if binary_hash not in TARGETS:
        emit("error", reason="binary-mismatch")
        return
    for command in (
        "set auto-load off",
        "set debuginfod enabled off",
        "set confirm off",
        "set pagination off",
        "set print frame-arguments none",
        "set print entry-values no",
        "set print frame-info short-location",
        "set print thread-events off",
        # QEMU uses SIGUSR1 (SIG_IPI) to kick its CPU threads.
        "handle SIGUSR1 nostop noprint pass",
        "handle SIGINT stop nopass",
    ):
        gdb.execute(command, to_string=True)
    gdb.execute(f"attach {inferior_pid}", to_string=True)
    mappings = read_mappings(os.stat(executable_path))
    bases = [item[0] for item in mappings if item[3] and item[2] == 0]
    if len(bases) != 1:
        emit("error", reason="breakpoint-unresolved")
        return
    breakpoints = []
    readiness = None
    for target, offset in TARGETS[binary_hash].items():
        address = bases[0] + offset
        if not any(item[3] and "x" in item[5] and item[0] <= address < item[1] for item in mappings):
            emit("error", reason="breakpoint-unresolved")
            return
        breakpoint = BridgeBreakpoint(address, target, readiness=target == "proxy-event")
        if breakpoint.pending or not breakpoint.enabled or len(breakpoint.locations) != 1:
            emit("error", reason="breakpoint-unresolved")
            return
        breakpoints.append(breakpoint)
        if target == "proxy-event":
            readiness = breakpoint
    emit("installed", binarySha256=binary_hash, breakpoints=5)
    gdb.events.stop.connect(on_stop)
    gdb.execute("continue")
    if interrupted:
        return
    if not ready_hit:
        emit("error", reason="unexpected-stop")
        return
    # GDB only auto-deletes a temporary breakpoint when it actually stops.
    # Delete outside stop(), where changing debugger state is supported.
    if readiness.is_valid():
        readiness.delete()
    emit("ready", target="proxy-event")
    gdb.execute("continue")
    if not interrupted:
        emit("error", reason="unexpected-stop")


try:
    trace()
except KeyboardInterrupt:
    pass
except Exception:
    emit("error", reason="debugger-error")
finally:
    try:
        if inferior_pid > 0 and gdb.selected_inferior().pid == inferior_pid:
            gdb.execute("detach", to_string=True)
            emit("detached")
    except Exception:
        emit("error", reason="detach-failed")
