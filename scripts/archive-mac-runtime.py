#!/usr/bin/python3
"""Archive runtime resources while keeping native signing targets visible."""
import hashlib
import importlib.util
import os
from pathlib import Path
import plistlib
import stat
import sys
import zipfile


def archive_runtime(app):
    runtime = app / "Contents/Resources/runtime"
    archive = app / "Contents/Resources/runtime.zip"
    spec = importlib.util.spec_from_file_location(
        "native_inventory", Path(__file__).parent / "lib/mac-native-inventory.py")
    inventory = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inventory)
    records = inventory.inventory(str(runtime)).split(b"\0")
    retained = {os.fsdecode(records[index + 1]) for index in range(0, len(records) - 1, 2)
                if records[index] in (b"executable", b"library")}
    # Resolution can validate build identity before the resource archive is extracted.
    retained.add(str(runtime / "lib/node_modules/openclaw/dist/build-info.json"))
    archived = []
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED, compresslevel=6) as output:
        for directory, directories, files in os.walk(runtime, followlinks=False):
            for name in sorted(directories + files):
                entry = Path(directory) / name
                if str(entry) in retained:
                    continue
                info = entry.lstat()
                relative = entry.relative_to(runtime).as_posix()
                if stat.S_ISLNK(info.st_mode):
                    member = zipfile.ZipInfo(relative)
                    member.create_system = 3
                    member.external_attr = info.st_mode << 16
                    output.writestr(member, os.readlink(entry))
                    archived.append(entry)
                elif stat.S_ISDIR(info.st_mode):
                    output.write(entry, relative + "/")
                elif stat.S_ISREG(info.st_mode):
                    output.write(entry, relative)
                    archived.append(entry)
                else:
                    raise ValueError(f"Unsupported runtime entry: {relative}")
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    plist = app / "Contents/Info.plist"
    with plist.open("rb") as source:
        info = plistlib.load(source)
    info["OpenClawRuntimeArchiveSHA256"] = digest.hexdigest()
    with plist.open("wb") as output:
        plistlib.dump(info, output)
    for entry in archived:
        entry.unlink()
    for directory, _, _ in os.walk(runtime, topdown=False):
        if directory != str(runtime) and not os.listdir(directory):
            os.rmdir(directory)
    print(f"Archived {len(archived)} resources; retained {len(retained) - 1} native files")


if __name__ == "__main__":
    archive_runtime(Path(sys.argv[1]).resolve(strict=True))
