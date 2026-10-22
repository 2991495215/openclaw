import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { toStreamingMarkdownParts } from "./markdown.ts";
import { MarkdownHtml } from "./solid/markdown-html.tsx";

vi.mock("highlight.js/lib/languages/rust", () => {
  throw new Error("synthetic grammar failure");
});

it("keeps failed grammar code readable while other languages finish normally", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const rust = '```rs\nfn main() { println!("<safe>"); }\n```\n\nReady.';
  const view = mountSolid(() => (
    <>
      <MarkdownHtml class="failed-rust" markdown={rust} />
      <MarkdownHtml class="working-json" markdown={'```json\n{"ready":true}\n```'} />
    </>
  ));
  const code = view.container.querySelector(".failed-rust code");
  await waitForSolid(() => {
    expect(warning).toHaveBeenCalledWith(
      "[markdown] Syntax highlighting could not be loaded; showing plain code.",
    );
    expect(view.container.querySelector(".working-json .hljs-attr")).not.toBeNull();
  });
  expect(view.container.querySelector(".failed-rust code")).toBe(code);
  expect(code?.textContent).toBe('fn main() { println!("<safe>"); }\n');
  expect(code?.querySelector("span, safe")).toBeNull();
  expect(toStreamingMarkdownParts(rust, {}, "failed-rust")[0]).toContain("language-rs");
});
