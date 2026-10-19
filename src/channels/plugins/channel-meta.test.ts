import { describe, expect, it } from "vitest";
import { buildChannelMetaFromManifest } from "./channel-meta.js";

describe("buildChannelMetaFromManifest", () => {
  it("projects only channel metadata and retains explicit plugin overrides", () => {
    const channel = {
      id: "demo",
      label: "Demo",
      selectionLabel: "Demo plugin",
      docsPath: "/channels/demo",
      docsLabel: "demo",
      blurb: "Manifest description",
      aliases: ["example"],
      order: 40,
      exposure: { setup: false },
      configuredState: { env: { anyOf: ["DEMO_TOKEN"] } },
      setup: { fields: [{ key: "token", kind: "string" }] },
      doctorCapabilities: { groupModel: "route" },
      approvalFlags: ["native"],
    };

    expect(
      buildChannelMetaFromManifest({
        ...channel,
        blurb: "Runtime description",
        systemImage: "message",
        aliases: undefined,
        order: undefined,
      }),
    ).toEqual({
      id: "demo",
      label: "Demo",
      selectionLabel: "Demo plugin",
      docsPath: "/channels/demo",
      docsLabel: "demo",
      blurb: "Runtime description",
      systemImage: "message",
      exposure: { configured: true, setup: false, docs: true },
    });
  });
});
