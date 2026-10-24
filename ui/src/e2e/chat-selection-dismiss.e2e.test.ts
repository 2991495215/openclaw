import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI selection dismissal" });
const passage = "Review the deployment checklist.";

suite.define(() => {
  it("clears a transcript selection when clicking blank space and still allows a new selection", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        const thread = page.locator(".chat-thread").filter({ has: source });
        const toolbar = page.getByRole("toolbar", { name: "Selection actions" });
        await source.waitFor({ state: "visible" });
        await waitForChatScrollIdle(page);
        await source.dblclick({ position: { x: 12, y: 8 } });
        await toolbar.waitFor({ state: "visible" });
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Review");

        await thread.click({ position: { x: 4, y: 4 } });
        await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
        expect(await toolbar.count()).toBe(0);

        await source.dblclick({ position: { x: 12, y: 8 } });
        await toolbar.waitFor({ state: "visible" });
        await toolbar.getByRole("button", { name: "Add to chat", exact: true }).click();
        await page.getByRole("dialog", { name: "Comment", exact: true }).waitFor();
        expect(await page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
      },
    );
  });
});
