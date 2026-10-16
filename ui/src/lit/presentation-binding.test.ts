import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import {
  PRESENTATION_CHANGED_EVENT,
  presentedContent,
  type PresentationBinding,
} from "./presentation-binding.ts";

afterEach(() => document.body.replaceChildren());

it.each([false, true])("reveals parked content on parent commit or preview=%s", (preview) => {
  const owner = new EventTarget();
  let presented = true;
  const binding: PresentationBinding = {
    owner,
    isPresented: () => presented,
    preview: () => preview,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const paint = () =>
    render(html`${presentedContent(binding, html`<span>Retained content</span>`)}`, container);
  const part = paint();
  expect(container.textContent).toBe("Retained content");

  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  expect(container.textContent).toBe("");
  presented = true;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  expect(container.textContent).toBe(preview ? "Retained content" : "");
  paint();
  expect(container.textContent).toBe("Retained content");

  part.setConnected(false);
  presented = false;
  owner.dispatchEvent(new Event(PRESENTATION_CHANGED_EVENT));
  expect(container.textContent).toBe("Retained content");
  part.setConnected(true);
  expect(container.textContent).toBe("");
  render(null, container);
});
