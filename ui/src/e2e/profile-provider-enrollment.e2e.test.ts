// Control UI tests cover the settings profile page against a mocked Gateway.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "playwright/test";
import { beforeEach, it } from "vitest";
import type { UserModelAccount } from "../../../packages/gateway-protocol/src/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI provider enrollment scope E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("profile-identity");
  }
});
const basePath = "/wilfred";
const profilePath = `${basePath}/settings/profile`;

const testProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["test@example.com"],
  githubIdentity: null,
  hasAvatar: false,
};
const testPresenceUsers: NonNullable<ControlUiMockGatewayScenario["presenceUsers"]> = [
  {
    self: true,
    id: testProfile.id,
    name: testProfile.displayName,
    email: testProfile.emails[0],
    avatarUrl: `/api/users/${testProfile.id}/avatar?v=${testProfile.updatedAt}`,
  },
];

suite.define(() => {
  async function openProfilePage(
    page: Page,
    methodResponses: Record<string, unknown> = {},
    presenceUsers = testPresenceUsers,
    operatorScopes?: string[],
  ) {
    const gateway = await installMockGateway(page, {
      basePath,
      presenceUsers,
      operatorScopes,
      methodResponses: {
        "users.self": { profile: testProfile },
        "agents.list": {
          defaultId: "clipper",
          agents: [{ id: "clipper", name: "Clipper" }],
        },
        ...methodResponses,
      },
    });
    const response = await page.goto(new URL(profilePath, suite.server.baseUrl).href);
    expect(response?.status()).toBe(200);
    return gateway;
  }

  it.each(["operator.write", "operator.write.no-provider-enrollment"])(
    "preserves profile and saved-account actions for %s",
    async (scope) => {
      const restricted = scope === "operator.write.no-provider-enrollment";
      await suite.withPage({ viewport: { width: 1280, height: 1400 } }, async ({ page }) => {
        const account: UserModelAccount = {
          authProfileId: "openai:retained",
          provider: "openai",
          label: "Test Person · Saved workspace",
          authType: "oauth",
          selected: false,
        };
        const links = [
          { provider: account.provider, authProfileId: account.authProfileId, updatedAt: 1 },
        ];
        const inventory = (selected: boolean) => ({
          profileId: testProfile.id,
          accounts: [{ ...account, selected }],
          links: selected ? links : [],
        });
        const gateway = await openProfilePage(
          page,
          {
            "users.listModelAccounts": inventory(false),
            "users.selectModelAccount": { links },
            "users.unlinkAuthProfile": { links: [] },
          },
          testPresenceUsers,
          [scope],
        );
        const section = page.locator("openclaw-model-accounts");
        await expect(section.getByRole("heading", { name: "Connected accounts" })).toBeVisible();
        await expect(page.locator(".identity-name-control input")).toBeEnabled();
        const addAccount = section.locator(".profile-auth-add-account");
        const enrollmentNotice = "Personal account sign-in requires operator.write access.";
        if (restricted) {
          await expect(addAccount).toBeDisabled();
          await expect(section).toContainText(enrollmentNotice);
        } else {
          await expect(addAccount).toBeEnabled();
          await expect(section).not.toContainText(enrollmentNotice);
        }
        await expect(section.locator(".profile-auth-account-select")).toBeEnabled();
        const connectGitHub = page.getByRole("button", { name: "Connect My GitHub", exact: true });
        await expect(connectGitHub).toBeEnabled();
        if (captureUiProof) {
          // Same-source comparison: before adopting the narrower grant vs. after.
          // Keep the adjacent personal GitHub action in the representative frame.
          const frame = await takeControlUiScreenshotFrame(
            page,
            section,
            [addAccount, section.locator(".profile-auth-account-select"), connectGitHub],
            { animations: "disabled", scrollTo: section },
          );
          await writeFile(
            path.join(
              proofDir,
              `profile-${restricted ? "restricted-write" : "existing-write"}.png`,
            ),
            frame.png,
          );
        }
        await gateway.setMethodResponse("users.listModelAccounts", inventory(true));
        await section.locator(".profile-auth-account-select").click();
        await expect(section.locator(".profile-auth-link-unlink")).toBeEnabled();
        await gateway.setMethodResponse("users.listModelAccounts", inventory(false));
        await section.locator(".profile-auth-link-unlink").click();
        await expect(section.locator(".profile-auth-account-select")).toBeEnabled();
        expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(1);
        expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(1);
        expect(await gateway.getRequests("users.authConnect.start")).toHaveLength(0);
        expect(await gateway.getRequests("users.authConnect.answer")).toHaveLength(0);
        await connectGitHub.click();
        await expect(page.locator("[data-github-setup]")).toBeVisible();
      });
    },
  );
});
