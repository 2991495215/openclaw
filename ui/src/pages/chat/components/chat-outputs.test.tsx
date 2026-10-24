/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import type { ChatDetailsOutputs } from "./chat-details-types.ts";
import { ChatOutputsDesktop, ChatOutputsMobile } from "./chat-outputs.tsx";

it.each([false, true])(
  "retains the focused artifact row across equivalent presentation updates (desktop=%s)",
  async (desktop) => {
    const artifacts: ChatDetailsOutputs["artifacts"] = [
      { id: "report", title: "Report.txt", type: "file", download: { mode: "bytes" } },
    ];
    const open = vi.fn();
    const read = (): ChatDetailsOutputs => ({
      artifacts,
      dashboard: null,
      onOpenArtifact: open,
      onViewAll() {},
      renderArtifactIcon: () => null,
      renderViewAllIcon: () => null,
    });
    const [outputs, setOutputs] = createSignal(read());
    function draw() {
      setOutputs(read());
      flush();
    }
    const view = mountSolid(() =>
      desktop ? <ChatOutputsDesktop {...outputs()} /> : <ChatOutputsMobile {...outputs()} />,
    );
    onTestFinished(view.unmount);
    await waitForSolid(() => expect(view.getByRole("button", { name: "Report.txt" })).toBeTruthy());
    const row = view.getByRole("button", { name: "Report.txt" });
    row.focus();
    draw();
    expect(view.queryByRole("status")).toBeNull();
    expect(view.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(view.getByRole("button", { name: "Report.txt" })).toBe(row);
    expect(document.activeElement).toBe(row);
    row.click();
    expect(open).toHaveBeenCalledWith("report");
  },
);
