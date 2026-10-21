/* @vitest-environment jsdom */
import { Show, createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { PanelFeedback, PanelFeedbackScope } from "./panel-feedback.tsx";

it("combines failures outside content and retries the current readers without hidden or retired pages", () => {
  const oldRetry = vi.fn();
  const nextRetry = vi.fn();
  const otherRetry = vi.fn();
  const [retry, setRetry] = createSignal({ callback: oldRetry });
  const [shown, setShown] = createSignal(true);
  const [mounted, setMounted] = createSignal(true);
  const [message, setMessage] = createSignal<string | undefined>("Access denied");
  const view = mountSolid(() => (
    <PanelFeedbackScope>
      <div data-testid="content">Saved process</div>
      <PanelFeedback label="Processes" message={message()} onRetry={retry().callback} />
      <Show when={mounted()}>
        <ContentPresentation value={shown}>
          <PanelFeedbackScope>
            <PanelFeedback
              label="Automations"
              message="Connection unavailable"
              onRetry={otherRetry}
            />
          </PanelFeedbackScope>
        </ContentPresentation>
      </Show>
    </PanelFeedbackScope>
  ));
  flush();
  expect(view.container.querySelectorAll(".panel-feedback")).toHaveLength(1);
  expect(view.getByTestId("content").textContent).toBe("Saved process");
  expect(view.getByRole("status").textContent).toBe("Some details are unavailable");
  setRetry({ callback: nextRetry });
  setShown(false);
  flush();
  view.getByRole("button", { name: "Retry" }).click();
  expect(nextRetry).toHaveBeenCalledOnce();
  expect(oldRetry).not.toHaveBeenCalled();
  expect(otherRetry).not.toHaveBeenCalled();
  expect(view.getByRole("status").textContent).toBe("Processes unavailable");
  setShown(true);
  setMounted(false);
  setMessage(undefined);
  flush();
  expect(view.container.querySelector(".panel-feedback")).toBeNull();
});

it("deduplicates messages without dropping distinct recovery callbacks or replaying a disabled read", () => {
  const first = vi.fn();
  const second = vi.fn();
  const disabled = vi.fn();
  const view = mountSolid(() => (
    <PanelFeedbackScope>
      <PanelFeedback label="Files" message="Unavailable" onRetry={first} />
      <PanelFeedback label="Files" message="Unavailable" onRetry={second} />
      <PanelFeedback label="Files" message="Unavailable" onRetry={disabled} retryDisabled />
    </PanelFeedbackScope>
  ));
  flush();
  expect(view.getByRole("status").textContent).toBe("Files unavailable");
  view.getByRole("button", { name: "Retry" }).click();
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  expect(disabled).not.toHaveBeenCalled();
});
