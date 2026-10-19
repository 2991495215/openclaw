import { describe, expect, it } from "vitest";
import { parseHttpUrl, resolveRequestUrl } from "./request-url.js";

describe("parseHttpUrl", () => {
  it("parses HTTP URLs without imposing caller-specific credential, host, query or fragment policy", () => {
    expect(
      parseHttpUrl("http://user:pass@127.0.0.1:8080/a?q=1#part", "syntax", "scheme").href,
    ).toBe("http://user:pass@127.0.0.1:8080/a?q=1#part");
    expect(parseHttpUrl("https://example.com/a", "syntax", "scheme").protocol).toBe("https:");
  });

  it("preserves the caller's distinct malformed-URL and protocol diagnostics", () => {
    expect(() => parseHttpUrl("not a URL", "caller syntax error", "caller protocol error")).toThrow(
      "caller syntax error",
    );
    expect(() =>
      parseHttpUrl("file:///private/data", "caller syntax error", "caller protocol error"),
    ).toThrow("caller protocol error");
  });
});

describe("resolveRequestUrl", () => {
  it.each([
    {
      name: "resolves string input",
      input: "https://example.com/a",
      expected: "https://example.com/a",
    },
    {
      name: "resolves URL input",
      input: new URL("https://example.com/b"),
      expected: "https://example.com/b",
    },
    {
      name: "resolves object input with url field",
      input: { url: "https://example.com/c" } as unknown as RequestInfo,
      expected: "https://example.com/c",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRequestUrl(input)).toBe(expected);
  });
});
