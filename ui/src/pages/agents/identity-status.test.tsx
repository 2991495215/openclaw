/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentIdentityOutcome } from "./identity-actions.ts";
import { Agents } from "./view.tsx";

it("keeps identity inputs editable through an admitted save and clears its error on a new edit", async () => {
  const fixture = createAgentViewTestProps();
  let state!: ReturnType<typeof fixture.readData>;
  const mounted = mountSolid(() => {
    const observation = observeState({ ...fixture.readData() });
    state = observation.state;
    return (
      <Agents
        {...fixture}
        readData={observation.read}
        overview={{
          ...fixture.overview,
          onIdentityFieldChange(field, value) {
            state.identityDraft = { ...state.identityDraft, [field]: value };
            state.identityOutcome = null;
          },
        }}
      />
    );
  });
  const input = mounted.container.querySelector<HTMLInputElement>(
    ".agent-identity-editor__fields input",
  )!;
  const completion = createDeferred<AgentIdentityOutcome>();
  state.identityDraft = { name: "Garden guide", emoji: null, avatar: null };
  state.identitySaving = true;
  state.identityOutcome = completion.promise;
  await waitForSolid(() => expect(input.value).toBe("Garden guide"));
  expect(input.disabled).toBe(false);

  completion.resolve({ error: "Synthetic identity save rejected" });
  state.identitySaving = false;
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Synthetic identity save rejected"),
  );
  expect(mounted.container.querySelector(".agent-identity-editor__fields input")).toBe(input);
  expect(input.value).toBe("Garden guide");
  expect(input.disabled).toBe(false);

  input.value = "Garden curator";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
  expect(state.identityDraft.name).toBe("Garden curator");
  expect(mounted.container.querySelector(".agent-identity-editor__fields input")).toBe(input);
});
