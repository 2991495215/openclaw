import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ExtensionFactory } from "./extensions/types.js";
import { DefaultResourceLoader } from "./resource-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("DefaultResourceLoader", () => {
  it("reports tool and flag conflicts in extension order while retaining the first owner", async () => {
    const root = tempDirs.make("openclaw-resource-loader-conflicts-");
    let description = "Initial registration";
    const factory: ExtensionFactory = (api) => {
      api.registerTool({
        name: "shared",
        label: "Shared",
        description,
        parameters: Type.Object({}),
        execute: async () => ({ content: [], details: undefined }),
      });
      api.registerFlag("shared", { type: "boolean", default: false });
      api.registerCommand("shared", { handler: async () => {} });
    };
    const loader = new DefaultResourceLoader({
      cwd: root,
      extensionFactories: [factory, factory, factory],
    });

    await loader.reload();

    expect(loader.getExtensions().errors).toEqual([
      { path: "<inline:2>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:2>", error: 'Flag "--shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Tool "shared" conflicts with <inline:1>' },
      { path: "<inline:3>", error: 'Flag "--shared" conflicts with <inline:1>' },
    ]);
    expect(loader.getExtensions().extensions).toHaveLength(3);

    loader.getExtensions().runtime.flagValues.set("shared", true);
    description = "Reloaded registration";
    await loader.reload();
    expect(loader.getExtensions().runtime.flagValues.get("shared")).toBe(false);
    expect(loader.getExtensions().extensions).toHaveLength(3);
    for (const [index, extension] of loader.getExtensions().extensions.entries()) {
      const sourceInfo = {
        path: `<inline:${index + 1}>`,
        source: "inline",
        scope: "temporary",
        origin: "top-level",
      };
      expect(extension.sourceInfo).toMatchObject(sourceInfo);
      expect(extension.tools.get("shared")).toMatchObject({
        definition: { description: "Reloaded registration" },
        sourceInfo,
      });
      expect(extension.commands.get("shared")).toMatchObject({ sourceInfo });
    }
  });
});
