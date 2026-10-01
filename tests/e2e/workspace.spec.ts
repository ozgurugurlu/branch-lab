import { test, expect, type Page } from "@playwright/test";

async function unlock(page: Page) {
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page.getByLabel("Workspace password").fill("branchlab-e2e-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lock workspace", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
}
async function demo(page: Page) {
  await page.getByRole("button", { name: /Explore a demo/i }).click();
  await expect(
    page.getByRole("heading", { name: "The four-day experiment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Completed", exact: true }),
  ).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await unlock(page);
});

test("chat, inspect, interview, branch, report, export and unlock persisted simulations", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await demo(page);
  await expect(
    page.getByText("6 of 6 rounds complete", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Message analyst")
    .fill("Where do the actors disagree?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);
  await page
    .getByLabel("Conversation recipient")
    .selectOption({ label: "Maya Chen" });
  await page
    .getByLabel("Message Maya Chen")
    .fill("What would change your mind?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to analyst" }).click();
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const legend = await page
    .locator(".workspace-dialog .network-hint")
    .boundingBox();
  const metrics = await page
    .locator(".workspace-dialog .metrics-strip")
    .boundingBox();
  expect(legend!.y + legend!.height).toBeLessThanOrEqual(metrics!.y);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer
    .getByText("Pilot brief · fictional scenario", { exact: true })
    .click();
  await expect(drawer.locator(".source-content pre")).toContainText(
    "fictional scenario",
  );
  await drawer.getByRole("button", { name: "Report", exact: true }).click();
  await drawer
    .getByRole("button", { name: "Generate report", exact: true })
    .click();
  await expect(drawer.locator(".research-report")).toBeVisible();
  await expect(
    drawer.getByRole("heading", { name: "What remains uncertain" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Branch scenario", exact: true })
    .click();
  await page.getByLabel("Branch name").fill("Transparent pilot branch");
  await page
    .getByLabel("What changes?")
    .fill(
      "Leadership funds a transparent pilot and a rotating coverage schedule with employee consultation.",
    );
  await page
    .getByRole("button", { name: "Create branch", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Transparent pilot branch",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("9 of 9 rounds complete", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Open simulation", exact: true })
    .click();
  await expect(page.locator(".comparison-panel")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Transparent pilot branch",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Export and manage simulation" })
    .click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export full JSON" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^branchlab-.*\.json$/);
  const stream = await download.createReadStream();
  let contents = "";
  for await (const chunk of stream!) contents += chunk.toString();
  const exported = JSON.parse(contents);
  expect(exported.rounds).toHaveLength(9);
  expect(exported.parentId).toBeTruthy();
  expect(exported.sources[0].hash).toHaveLength(64);
  expect(exported).not.toHaveProperty("owner");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lock workspace", exact: true })
    .click();
  await expect(page.getByLabel("Workspace password")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Transparent pilot branch",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("Workspace password").fill("branchlab-e2e-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Transparent pilot branch",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  expect(errors).toEqual([]);
});

test("imported source permissions survive creation, while delete failures are recoverable", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page.getByLabel("Simulation name").fill("Community solar pilot");
  await page
    .getByLabel("What do you want to explore?")
    .fill("How might residents respond to a subsidized community solar pilot?");
  await page.locator('input[type="file"]').setInputFiles({
    name: "brief.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Fictional brief: residents may opt into a 3-month solar pilot. No outcomes are known.",
    ),
  });
  await page.getByLabel("Access for brief.md").selectOption("analyst-only");
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Actors", { exact: true }).fill("4");
  await page.getByLabel("Rounds", { exact: true }).fill("2");
  await expect(
    page.getByLabel("Allow cloud model processing for this run"),
  ).not.toBeChecked();
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Community solar pilot", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run one round", exact: true })
    .click();
  await expect(
    page.getByText("1 of 2 rounds complete", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(page.getByText("brief.md", { exact: true })).toBeVisible();
  await expect(page.locator(".source-document summary")).toContainText(
    "Analyst only",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Export and manage simulation" })
    .click();
  await page
    .getByRole("button", { name: "Delete simulation", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await page.route("**/api/simulations/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "TEMPORARY_FAILURE",
            message: "Storage is temporarily unavailable.",
            retryable: true,
          },
        }),
      });
    } else await route.continue();
  });
  await dialog
    .getByRole("button", { name: "Delete simulation", exact: true })
    .click();
  await expect(
    dialog.getByText("Storage is temporarily unavailable.", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.unroute("**/api/simulations/*");
  await dialog
    .getByRole("button", { name: "Delete simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Community solar pilot", exact: true }),
  ).toHaveCount(0);
});

test("a lost chat response can be retried without duplicated saved messages", async ({
  page,
}) => {
  await demo(page);
  const ids: string[] = [];
  let drop = true;
  await page.route("**/api/simulations/*/chat", async (route) => {
    ids.push(route.request().postDataJSON().requestId);
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  const text = "What would change this simulation's outcome?";
  await page.getByLabel("Message analyst").fill(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.locator(".conversation-bottom .inline-error"),
  ).toBeVisible();
  await expect(page.getByLabel("Message analyst")).toHaveValue(text);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);
  await expect(page.locator(".conversation-message.user")).toHaveCount(1);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBe(ids[0]);
  await page.reload();
  await expect(page.locator(".conversation-message.assistant")).toHaveCount(1);
});

test("mobile composer, keyboard dialogs and simulation drawer stay usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await expect(page.getByLabel("Message analyst")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Network", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  const hint = await page
    .locator(".workspace-dialog .network-hint")
    .boundingBox();
  const metrics = await page
    .locator(".workspace-dialog .metrics-strip")
    .boundingBox();
  expect(hint!.y + hint!.height).toBeLessThanOrEqual(metrics!.y);
  await page.keyboard.press("Tab");
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Network", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByLabel("Describe a scenario")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("pause saves the current round and workspace erasure clears private state", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page.getByLabel("Simulation name").fill("Pause and erase check");
  await page
    .getByLabel("What do you want to explore?")
    .fill("How might residents respond to a community solar pilot?");
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Actors", { exact: true }).fill("4");
  await page.getByLabel("Rounds", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Pause and erase check", exact: true }),
  ).toBeVisible();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let steps = 0;
  await page.route("**/api/simulations/*/step", async (route) => {
    steps++;
    await pending;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Run simulation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New chat", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByText(/Pause requested\. This round will finish/),
  ).toBeVisible();
  release();
  await expect(
    page.getByText("1 of 2 rounds complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  expect(steps).toBe(1);
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page.getByText("Erase workspace data", { exact: true }).click();
  const erase = page.getByRole("button", {
    name: "Erase all workspace data",
    exact: true,
  });
  await expect(erase).toBeDisabled();
  await page
    .getByLabel("Type DELETE MY WORKSPACE to confirm")
    .fill("DELETE MY WORKSPACE");
  await erase.click();
  await expect(
    page.getByRole("heading", { name: "Pause and erase check", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Saved chats" }).getByRole("button"),
  ).toHaveCount(0);
  await unlock(page);
  await expect(page.getByLabel("Describe a scenario")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Saved chats" }).getByRole("button"),
  ).toHaveCount(0);
});

test("configuration bootstrap errors offer setup recovery without claiming saved progress", async ({
  page,
}) => {
  let configurationRequests = 0;
  await page.route("**/api/config", async (route) => {
    configurationRequests++;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DATABASE_SCHEMA",
          message: "The workspace database schema needs attention.",
          retryable: true,
          requestId: "bootstrap-recovery-check",
        },
      }),
    });
  });
  await page.reload();
  const banner = page.locator(".error-banner");
  await expect(banner).toContainText("database schema and migrations");
  await expect(banner).not.toContainText("saved checkpoint");
  await expect(banner).not.toContainText("model charges");
  await expect(banner).toContainText("bootstrap-recovery-check");
  await page
    .getByRole("button", { name: "Reload workspace", exact: true })
    .click();
  await expect.poll(() => configurationRequests).toBe(2);
  await page.unroute("**/api/config");
  await page
    .getByRole("button", { name: "Reload workspace", exact: true })
    .click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByLabel("Describe a scenario")).toBeVisible();
});
