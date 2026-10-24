import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UNIX_SOCKET_PATH_BYTES = 103;

export function createNativeResourceAuthority() {
  let directory = mkdtempSync(join(tmpdir(), "oc-br-"));
  if (
    process.platform !== "win32" &&
    Buffer.byteLength(join(directory, "resource.sock")) > UNIX_SOCKET_PATH_BYTES
  ) {
    // A configured temp root can exceed Darwin's sockaddr_un even for a short private socket.
    rmSync(directory, { recursive: true, force: true });
    directory = mkdtempSync("/tmp/oc-br-");
  }
  chmodSync(directory, 0o700);
  const secret = randomBytes(32).toString("hex");
  return {
    directory,
    secret,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\oc-br-${secret}`
        : join(directory, "resource.sock"),
  };
}
