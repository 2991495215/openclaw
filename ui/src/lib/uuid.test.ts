// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateUUID } from "./uuid.ts";

afterEach(() => vi.unstubAllGlobals());

describe("generateUUID", () => {
  it("uses crypto.randomUUID when available", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => "randomuuid",
      getRandomValues: () => {
        throw new Error("should not be called");
      },
    });
    const id = generateUUID();

    expect(id).toBe("randomuuid");
  });

  it("falls back to crypto.getRandomValues", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < view.length; i++) {
          view[i] = i;
        }
        return bytes;
      },
    });
    const id = generateUUID();

    expect(id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("rejects UUID generation when crypto is missing and warns only once", () => {
    vi.stubGlobal("crypto", undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => generateUUID()).toThrow("Web Crypto is required for UUID generation");
      expect(() => generateUUID()).toThrow("Web Crypto is required for UUID generation");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
