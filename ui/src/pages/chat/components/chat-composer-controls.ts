import { html, nothing } from "lit";
import {
  createComponent,
  createMemo,
  getOwner,
  runWithOwner,
  Show,
  useContext,
  type Component,
  type Accessor,
} from "solid-js";
import { renderKbd } from "../../../components/kbd.ts";
import { solidContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";

function createProjectedProps<P extends object>(read: Accessor<P>): P {
  const owner = getOwner();
  const values = new Map<PropertyKey, Accessor<unknown>>();
  const presence = new Map<PropertyKey, Accessor<boolean>>();
  const value = (key: PropertyKey) => {
    let projection = values.get(key);
    if (!projection) {
      projection = runWithOwner(owner, () => createMemo(() => Reflect.get(read(), key)));
      values.set(key, projection);
    }
    return projection();
  };
  const has = (key: PropertyKey) => {
    let projection = presence.get(key);
    if (!projection) {
      projection = runWithOwner(owner, () => createMemo(() => Reflect.has(read(), key)));
      presence.set(key, projection);
    }
    return projection();
  };
  const keys = createMemo(() => Reflect.ownKeys(read()), {
    equals: (previous, next) =>
      previous.length === next.length && previous.every((key, index) => key === next[index]),
  });
  // Each consumer tracks only its field; unrelated props must not rewrite native inputs.
  // The proxy owns no snapshot; its traps supply every field from the current source.
  // SAFETY: All keys and property reads come from the current P through these traps.
  const current = new Proxy({} as P, {
    get: (_target, key) => value(key),
    has: (_target, key) => has(key),
    ownKeys: () => keys(),
    getOwnPropertyDescriptor: (_target, key) =>
      has(key)
        ? {
            configurable: true,
            enumerable: true,
            value: value(key),
          }
        : undefined,
  });
  return current;
}

function ProjectedContent<P extends object>(props: { component: Component<P>; value: P }) {
  const presented = useContext(SolidContentPresentation);
  return Show({
    get when() {
      return presented() ? props.component : undefined;
    },
    keyed: true,
    children: (component: Component<P>) =>
      createComponent(
        component,
        createProjectedProps(() => props.value),
      ),
  });
}

export function solidTemplate<P extends object>(component: Component<P>, props: P) {
  return html`${solidContent(ProjectedContent<P>, { component, value: props })}`;
}

export function hasComposerContent(value: unknown): boolean {
  return value != null && value !== false && value !== "" && value !== nothing;
}

export function renderComposerSendTooltip(label: string, alternate: string, modifier: string) {
  return html`${label}${" "}${renderKbd("⏎", { inline: true })}${" · "}${alternate}${" "}${renderKbd(modifier.split(/(⌘)/u).filter(Boolean), { inline: true })}`;
}
