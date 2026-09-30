import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open settings", exact: true })
    .click();
  await page.getByLabel("Workspace password").fill("branchlab-e2e-password");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lock workspace", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
});

test("explore, interview, branch, report and export a persisted simulation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: /Explore a demo/i }).click();
  await expect(
    page.getByRole("heading", { name: "The four-day experiment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Completed", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("6 of 6 rounds complete", { exact: true }),
  ).toBeVisible();

  await page
    .getByLabel("Message analyst")
    .fill("Where do the actors disagree?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(1);

  await page
    .getByRole("button", {
      name: /Maya Chen, .*Supportive|Maya Chen, .*Skeptical|Maya Chen, .*Undecided/,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Maya Chen", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Message Maya Chen")
    .fill("What would change your mind?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.locator(".chat-message.assistant")).toHaveCount(1);
  await page.getByRole("button", { name: "Back to analyst" }).click();

  await page.getByRole("button", { name: "Sources", exact: false }).click();
  await page
    .getByText("Pilot brief · fictional scenario", { exact: true })
    .click();
  await expect(page.locator(".source-content pre")).toContainText(
    "fictional scenario",
  );

  await page.getByRole("button", { name: "Report", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate report", exact: true })
    .click();
  await expect(page.locator(".research-report")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What remains uncertain" }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Branch scenario/ }).click();
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
  await expect(page.locator(".comparison-panel")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Transparent pilot branch",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("9 of 9 rounds complete", { exact: true }),
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

test("custom scenario handles imported source text and validation", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /New simulation/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Start from scratch" }).click();
  await page.getByLabel("Simulation name").fill("Community solar pilot");
  await page
    .getByLabel("What do you want to explore?")
    .fill("How might residents respond to a subsidized community solar pilot?");
  await page.locator('input[type="file"]').setInputFiles({
    name: "brief.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Fictional brief: local residents may opt into a 3-month solar pilot. No outcomes are known.",
    ),
  });
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Actors", { exact: true }).fill("4");
  await page.getByLabel("Rounds", { exact: true }).fill("2");
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
  await page.getByRole("button", { name: "Sources", exact: false }).click();
  await expect(page.getByText("brief.md", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Export and manage simulation" })
    .click();
  await page
    .getByRole("button", { name: "Delete simulation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Community solar pilot", exact: true }),
  ).toHaveCount(0);
});

test("mobile navigation and dialogs fit without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: /Explore a demo/i }).click();
  await expect(
    page.getByRole("button", { name: "Completed", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Open conversation panel" }).click();
  await expect(page.getByLabel("Message analyst")).toBeVisible();
  await page.getByRole("button", { name: "Close conversation panel" }).click();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page
    .getByRole("button", { name: /New simulation/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
