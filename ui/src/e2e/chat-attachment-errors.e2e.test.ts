import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { attachmentImage } from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Attachment errors" });

suite.define(() => {
  it.each([
    { route: "chat", device: "desktop-dark", viewport: { width: 1280, height: 900 }, mode: "dark" },
    { route: "new", device: "mobile-light", viewport: { width: 390, height: 844 }, mode: "light" },
  ] as const)(
    "keeps named failures and recovery beside the $route draft on $device",
    ({ route, device, viewport, mode }) =>
      suite.withPage(
        { viewport, isMobile: route === "new", hasTouch: route === "new", colorScheme: mode },
        async ({ page }) => {
          await page.clock.install();
          await page.addInitScript(() => {
            const NativeFileReader = FileReader;
            let failed = false;
            window.FileReader = class extends NativeFileReader {
              override readAsDataURL(file: Blob) {
                if (file instanceof File && file.name === "unreadable.txt" && !failed) {
                  failed = true;
                  window.addEventListener(
                    "qa-attachment-error",
                    () => this.dispatchEvent(new ProgressEvent("error")),
                    { once: true },
                  );
                } else {
                  super.readAsDataURL(file);
                }
              }
            };
          });
          const gateway = await installMockGateway(page, {
            attachmentMaxBytes: 1024,
            methodResponses: { "config.get": themeConfigResponse("claw", mode) },
            agentModel: "demo/model",
            models: [{ id: "model", name: "Demo", provider: "demo" }],
            historyMessages: [{ role: "assistant", content: "Ready for attachments." }],
          });
          await page.goto(suite.server.baseUrl + route);
          const composer = page.locator(".agent-chat__composer-combobox textarea").first();
          const input = page.locator(".agent-chat__file-input").first();
          const draft = "Keep my draft and valid attachments.";
          await composer.fill(draft);
          const unreadable = {
            name: "unreadable.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("read me"),
          };
          await input.setInputFiles([
            { name: "kept.txt", mimeType: "text/plain", buffer: Buffer.from("keep") },
            { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
            { name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(2048) },
            unreadable,
          ]);
          await page.getByRole("button", { name: "Remove kept.txt", exact: true }).waitFor();
          await composer.focus();
          await page.evaluate(() => window.dispatchEvent(new Event("qa-attachment-error")));
          const focused = (target: import("playwright").Locator) =>
            target.evaluate((element) => element.ownerDocument.activeElement === element);
          await expect.poll(() => focused(composer)).toBe(true);
          const failures = page.locator(".chat-attachment-failures");
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            await page.clock.fastForward(7000);
            const frame = await takeControlUiScreenshotFrame(page, composer, [composer], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, device + "-" + route + "-errors.png"),
              frame.png,
            );
          }
          await expect.poll(() => failures.locator("li").count()).toBe(3);
          expect(await failures.textContent()).toContain("empty.txt");
          expect(await failures.textContent()).toContain("large.txt");
          expect(await failures.textContent()).toContain("unreadable.txt");
          expect(await failures.textContent()).toContain("empty");
          expect(await failures.textContent()).toContain("smaller");
          expect(await failures.textContent()).toContain("Choose");
          expect(await failures.getAttribute("aria-live")).toBe("polite");
          expect(await page.locator(".app-toast").count()).toBe(0);
          await page.clock.fastForward(7000);
          expect(await failures.locator("li").count()).toBe(3);
          expect(await composer.inputValue()).toBe(draft);
          const chooser = page.waitForEvent("filechooser");
          await page.getByRole("button", { name: "Choose files again", exact: true }).click();
          await (await chooser).setFiles(unreadable);
          await page.getByRole("button", { name: "Remove unreadable.txt", exact: true }).waitFor();
          const dismissError = (name: string) =>
            page.getByRole("button", {
              name: "Dismiss error for " + name,
              exact: true,
            });
          // Removing the middle notice advances to its next sibling without moving the page.
          await dismissError("large.txt").focus();
          const scroll = await page.evaluate(() => [window.scrollX, window.scrollY]);
          await page.keyboard.press("Enter");
          await expect.poll(() => focused(dismissError("unreadable.txt"))).toBe(true);
          expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual(scroll);
          await page.keyboard.press("Enter");
          await expect.poll(() => focused(dismissError("empty.txt"))).toBe(true);
          await page.keyboard.press("Enter");
          await expect.poll(() => focused(composer)).toBe(true);
          await expect.poll(() => failures.locator("li").count()).toBe(0);
          expect(await composer.inputValue()).toBe(draft);
          // An entirely rejected selection has no pending/readable-file update to drive rendering.
          await input.setInputFiles({
            name: "only-empty.txt",
            mimeType: "text/plain",
            buffer: Buffer.alloc(0),
          });
          await page
            .getByRole("button", { name: "Dismiss error for only-empty.txt", exact: true })
            .click();
          await expect.poll(() => failures.locator("li").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toEqual([]);
          if (route === "chat") {
            await page.getByRole("button", { name: "Send message", exact: true }).click();
            const request = await gateway.waitForRequest("chat.send");
            expect(request.params).toMatchObject({
              message: draft,
              attachments: [{ fileName: "kept.txt" }, { fileName: "unreadable.txt" }],
            });
          } else {
            await page.getByRole("button", { name: "Remove kept.txt", exact: true }).click();
            await page.getByRole("button", { name: "Remove unreadable.txt", exact: true }).click();
            await composer.fill("");
          }
          await expect.poll(() => composer.inputValue()).toBe("");
          await input.setInputFiles({
            name: "failed-only.txt",
            mimeType: "text/plain",
            buffer: Buffer.alloc(0),
          });
          await dismissError("failed-only.txt").focus();
          await page.keyboard.press("Enter");
          await expect.poll(() => focused(composer)).toBe(true);
          expect(await page.locator(".chat-attachment-thumb").count()).toBe(0);
          // A dismissal dispatched without owning focus must not steal it from the editor.
          await input.setInputFiles({
            name: "unfocused.txt",
            mimeType: "text/plain",
            buffer: Buffer.alloc(0),
          });
          await composer.focus();
          await dismissError("unfocused.txt").evaluate((button: HTMLButtonElement) =>
            button.click(),
          );
          await expect.poll(() => focused(composer)).toBe(true);
          expect(await composer.inputValue()).toBe("");
        },
      ),
  );
  it("downloads the original only on request when a preview is unavailable", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const id = crypto.randomUUID();
        const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`;
        const artifactId = `artifact_managed_image_${id}`;
        const image = {
          type: "image",
          artifactId,
          url: source,
          alt: "Holiday photo",
          mimeType: "image/png",
          width: 1600,
          height: 1000,
        };
        const bytes = attachmentImage("original.png").buffer;
        const requests: string[] = [];
        await page.route("**/api/chat/media/outgoing/**", async (route) => {
          const variant = new URL(route.request().url()).pathname.split("/").at(-1)!;
          requests.push(variant);
          await route.fulfill(
            variant === "thumbnail"
              ? { status: 404, body: "Not Found" }
              : { body: bytes, contentType: "image/png" },
          );
        });
        await installMockGateway(page, {
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
          historyMessages: [{ role: "assistant", content: [image], timestamp: 1 }],
          methodResponses: {
            "artifacts.download": {
              artifact: {
                id: artifactId,
                type: "image",
                title: "Holiday photo",
                mimeType: "image/png",
                download: { mode: "url" },
              },
              url: `${source}?mediaTicket=demo-ticket`,
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const card = page.locator(".chat-image-frame--compact");
        await card.waitFor({ state: "visible" });
        expect(requests).toEqual(["thumbnail"]);
        await card.getByRole("button", { name: "Image actions" }).click();
        const download = page.waitForEvent("download");
        await card.getByRole("menuitem", { name: "Download image" }).click();
        expect((await download).suggestedFilename()).toBe("Holiday photo.png");
        expect(requests).toEqual(["thumbnail", "full"]);
      },
    ));
});
