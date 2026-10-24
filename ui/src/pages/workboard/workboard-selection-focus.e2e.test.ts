import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
  startControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { configSnapshot, makeBoard, makeCard } from "./workboard.e2e.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Workboard selection focus",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  it("returns focus in rendered order and skips unmounted selected cards", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        const board = makeBoard("default", { total: 3, active: 3 });
        const first = makeCard({ id: "first-card", title: "Review release notes", position: 1000 });
        const second = makeCard({
          id: "second-card",
          title: "Prepare announcement",
          position: 2000,
        });
        const done = makeCard({ id: "done-card", title: "Published release", status: "done" });
        await installMockGateway(page, {
          ...workboardUi,
          methodResponses: {
            "config.get": configSnapshot("selection-focus"),
            "workboard.boards.list": { boards: [board] },
            "workboard.cards.list": {
              boards: [board],
              cards: [done, first, second],
              statuses: ["todo", "done"],
            },
          },
        });
        await page.goto(suite.server.baseUrl + "workboard");
        const tile = page.locator("article.workboard-card").filter({ hasText: first.title });
        const secondTile = page.locator("article.workboard-card").filter({ hasText: second.title });
        const doneTile = page.locator("article.workboard-card").filter({ hasText: done.title });
        await tile.waitFor();
        for (const selected of [doneTile, secondTile, tile]) {
          await selected.focus();
          await page.keyboard.press("Shift+Enter");
        }
        const clear = page.getByRole("button", { name: "Clear selection", exact: true });
        await clear.waitFor();
        await clear.focus();
        await page.keyboard.press("Enter");
        await clear.waitFor({ state: "hidden" });
        await expect
          .poll(() => tile.getAttribute("class"))
          .not.toContain("workboard-card--selected");
        await page.screenshot({
          path: suite.artifactDir + "/selection-cleared.png",
          animations: "disabled",
        });
        await expect
          .poll(() => tile.evaluate((element) => element === document.activeElement))
          .toBe(true);
        for (const selected of [tile, doneTile]) {
          await selected.focus();
          await page.keyboard.press("Shift+Enter");
        }
        await page.getByRole("button", { name: "Collapse Todo column", exact: true }).click();
        await tile.waitFor({ state: "detached" });
        await clear.focus();
        await page.keyboard.press("Enter");
        await clear.waitFor({ state: "hidden" });
        await expect
          .poll(() => doneTile.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.getByRole("button", { name: "Expand Todo column", exact: true }).click();
        await tile.waitFor();
        await tile.focus();
        await page.keyboard.press("Shift+Enter");
        await clear.focus();
        await page.keyboard.press("Enter");
        await clear.waitFor({ state: "hidden" });
        await expect
          .poll(() => tile.evaluate((element) => element === document.activeElement))
          .toBe(true);
      },
    );
  });
});
