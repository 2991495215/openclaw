import { lazy, Show, useContext } from "solid-js";
import type { ControlUiSurface } from "../../../src/plugin-sdk/control-ui.js";
import { useOptionalApplication } from "../lib/reactive/context.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { ContentPresentation } from "../lib/solid/presentation.ts";
import type { PluginReplacementProps } from "./control-ui-view.solid.tsx";

export const PluginReplacement = lazy(() => import("./control-ui-view.solid.tsx"), {
  export: "PluginReplacement",
});

export function PluginSurface<S extends ControlUiSurface>(
  props: PluginReplacementProps<S> & { enabled?: boolean },
) {
  const context = useOptionalApplication();
  const runtime = context && projectOwner(context.plugins, (source) => source);
  const contentPresented = useContext(ContentPresentation);
  const presented = () => (props.presented ?? true) && contentPresented();
  const selected = createParkedProjection(
    () =>
      props.enabled === false ? undefined : runtime?.read().selectedReplacement(props.surface),
    presented,
  );
  return (
    <Show when={selected()} fallback={props.renderDefault()}>
      <PluginReplacement
        surface={props.surface}
        props={props.props}
        renderDefault={props.renderDefault}
        renderCompanion={props.renderCompanion}
        replacementRef={props.replacementRef}
        presented={presented()}
      />
    </Show>
  );
}
