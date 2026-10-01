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
  await expect(
    page.locator(".conversation-report .research-report"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Message analyst")).toBeEnabled();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await unlock(page);
});

test("finishing a run writes its answer into chat while the composer stays available", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reports = 0;
  await page.route("**/api/simulations/*/report", async (route) => {
    reports++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: /Explore a demo/i }).click();
    await expect(
      page.getByRole("heading", {
        name: "Writing the simulation report…",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("6 of 6 rounds complete", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Message analyst")).toBeVisible();
    await page
      .getByLabel("Message analyst")
      .fill("Which assumption matters most?");
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".conversation-report")).toContainText(
      "completed simulation is saved",
    );
  } finally {
    release();
  }
  const report = page.getByRole("region", {
    name: "Simulation report",
    exact: true,
  });
  await expect(report.locator(".research-report")).toBeVisible();
  await expect(
    report.getByRole("heading", { name: "Scenario answer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  expect(reports).toBe(1);
  await report
    .getByRole("button", { name: /^View event / })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".event:focus")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await report.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/inline-report-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await report.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/inline-report-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expect(
    page.locator(".conversation-report .research-report"),
  ).toBeVisible();
  expect(reports).toBe(1);
});

test("a lost automatic report response retries the saved result without rerunning rounds", async ({
  page,
}) => {
  const bodies: Record<string, unknown>[] = [];
  let rounds = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/step"))
      rounds++;
  });
  await page.route("**/api/simulations/*/report", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.getByRole("button", { name: /Explore a demo/i }).click();
  const retry = page.getByRole("button", { name: "Retry report", exact: true });
  await expect(retry).toBeVisible();
  await expect(
    page.getByText("6 of 6 rounds complete", { exact: true }),
  ).toBeVisible();
  const list = (await (await page.request.get("/api/simulations")).json()).data;
  const saved = (
    await (await page.request.get(`/api/simulations/${list[0].id}`)).json()
  ).data;
  expect(saved.report.answer).toBeTruthy();
  await retry.click();
  await expect(
    page.locator(".conversation-report .research-report"),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0].requestId).toBeTruthy();
  expect(bodies[1]).toEqual(bodies[0]);
  expect(rounds).toBe(6);
  const after = (
    await (await page.request.get(`/api/simulations/${list[0].id}`)).json()
  ).data;
  expect(after.version).toBe(saved.version);
  expect(after.rounds).toEqual(saved.rounds);
});

test("a legacy report upgrades on request and keeps the saved text if the update fails", async ({
  page,
}) => {
  await demo(page);
  await page.route(/\/api\/simulations\/[^/]+$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    if (payload.data.report) delete payload.data.report.answer;
    await route.fulfill({ response, json: payload });
  });
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/simulations/*/report", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1)
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "MODEL_UNAVAILABLE",
            message: "The report could not be updated.",
            retryable: true,
          },
        },
      });
    else await route.continue();
  });
  await page.reload();
  const report = page.getByRole("region", {
    name: "Simulation report",
    exact: true,
  });
  const headline = await report.locator(".research-report > h3").textContent();
  await expect(
    report.getByRole("button", { name: "Update report", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(0);
  await report
    .getByRole("button", { name: "Update report", exact: true })
    .click();
  await expect(
    report.getByRole("button", { name: "Retry report", exact: true }),
  ).toBeVisible();
  await expect(report.locator(".research-report > h3")).toHaveText(headline!);
  await report
    .getByRole("button", { name: "Retry report", exact: true })
    .click();
  await expect(
    report.getByRole("heading", { name: "Scenario answer", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toMatchObject({ refresh: true });
  expect(bodies[1]).toEqual(bodies[0]);
  await expect(
    report.getByRole("button", { name: "Update report", exact: true }),
  ).toHaveCount(0);
});

test("pausing the final round defers the report and reopening never starts inference", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page
    .getByLabel("What do you want to explore?")
    .fill("How would a neighborhood respond to a shared community garden?");
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Rounds", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Run simulation", exact: true }),
  ).toBeEnabled();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let roundSaved = false;
  let reportRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/report"))
      reportRequests++;
  });
  await page.route("**/api/simulations/*/step", async (route) => {
    const response = await route.fetch();
    roundSaved = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Run simulation", exact: true })
      .click();
    await expect.poll(() => roundSaved).toBe(true);
    await page
      .getByRole("button", {
        name: "Pause simulation after current round",
        exact: true,
      })
      .click();
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Generate report", exact: true }),
  ).toBeVisible();
  expect(reportRequests).toBe(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Generate report", exact: true }),
  ).toBeVisible();
  expect(reportRequests).toBe(0);
  await page
    .getByRole("button", { name: "Generate report", exact: true })
    .click();
  await expect(
    page.locator(".conversation-report .research-report"),
  ).toBeVisible();
  expect(reportRequests).toBe(1);
});

test("advancing after a lost partial report creates a fresh final report identity", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page
    .getByLabel("What do you want to explore?")
    .fill("How could a town adapt to a shared library of household tools?");
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Rounds", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  const step = page.getByRole("button", { name: "Run one round", exact: true });
  await expect(step).toBeEnabled();
  await step.click();
  await expect(
    page.getByText("1 of 2 rounds complete", { exact: true }),
  ).toBeVisible();
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/simulations/*/report", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Report", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Generate report", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry report", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".conversation-report")).not.toContainText(
    "simulation is complete",
  );
  await step.click();
  await expect(
    page.getByText("2 of 2 rounds complete", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".conversation-report .research-report"),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0].expectedRound).toBe(1);
  expect(bodies[1].expectedRound).toBe(2);
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId);
});

test("configured Gemini is the default while model changes and consent stay explicit", async ({
  page,
}) => {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.providers.find(
      (provider: { id: string }) => provider.id === "google",
    ).configured = true;
    await route.fulfill({ response, json: payload });
  });
  let submissions = 0;
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions++;
    await route.abort();
  });
  await page.reload();
  const picker = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(picker).toHaveText("Gemini 3.8 Flash");
  await picker.click();
  await expect(
    page.getByRole("option", { name: "Gemini 3.8 Flash", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () => {
      const menu = await page
        .getByRole("listbox", { name: "Models" })
        .boundingBox();
      const selected = await page
        .getByRole("option", { name: "Gemini 3.8 Flash", exact: true })
        .boundingBox();
      return Boolean(
        menu &&
        selected &&
        selected.y >= menu.y &&
        selected.y + selected.height <= menu.y + menu.height,
      );
    })
    .toBe(true);
  await page.screenshot({
    path: "test-results/model-menu-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page
    .getByRole("option", { name: "Gemini 3.5 Flash-Lite", exact: true })
    .click();
  const question = "What happens if every household receives a personal robot?";
  await page.getByLabel("Describe a scenario").fill(question);
  await page
    .getByRole("button", { name: "Start simulation", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveText("Gemini 3.5 Flash-Lite");
  await expect(dialog.getByLabel("Simulation name")).toHaveValue("");
  await expect(dialog.getByLabel("Simulation name")).not.toHaveAttribute(
    "required",
  );
  await expect(dialog.getByLabel("What do you want to explore?")).toHaveValue(
    question,
  );
  await expect(
    dialog.getByRole("button", { name: "Create simulation", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByLabel("Allow research agents to search the web"),
  ).toBeDisabled();
  await expect(
    dialog.getByText(/Web search is off for this workspace/),
  ).toBeVisible();
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Models" })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(picker).toHaveText("Gemini 3.5 Flash-Lite");
  expect(submissions).toBe(0);
});

test("model menu is compact, keyboard accessible and fits a mobile viewport", async ({
  page,
}) => {
  const picker = page.getByRole("combobox", { name: "Model", exact: true });
  await expect(picker).toHaveText("Branchlab demo");
  const label = await picker.locator("span").boundingBox();
  const chevron = await picker.locator("svg").boundingBox();
  expect(chevron!.x - label!.x - label!.width).toBeLessThan(16);
  await picker.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("listbox", { name: "Models" });
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  const unavailable = menu
    .getByRole("group", { name: "LM Studio", exact: true })
    .getByRole("option");
  await expect(unavailable).toHaveAttribute("aria-disabled", "true");
  await expect(unavailable).toHaveAccessibleDescription(/enable local models/);
  await page.keyboard.press("Enter");
  await expect(picker).toHaveText("Branchlab demo");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
  await picker.click();
  await page.keyboard.press("Tab");
  await expect(menu).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.click();
  await expect
    .poll(async () => {
      const box = await menu.boundingBox();
      return Boolean(
        box &&
        box.x >= 0 &&
        box.x + box.width <= 390 &&
        box.y >= 0 &&
        box.y + box.height <= 844,
      );
    })
    .toBe(true);
  await page.screenshot({
    path: "test-results/model-menu-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Describe a scenario").click();
  await expect(menu).toHaveCount(0);
});

test("unnamed scenarios and branches persist without copying their prompts into the title", async ({
  page,
}) => {
  const question =
    "How might a personal robot change daily life for households?";
  await page.getByLabel("Describe a scenario").fill(question);
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await expect(page.getByLabel("Simulation name")).toHaveValue("");
  await expect(page.getByLabel("What do you want to explore?")).toHaveValue(
    question,
  );
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Untitled simulation", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".conversation-user-message")).toContainText(
    question,
  );
  await page
    .getByRole("button", { name: "Branch scenario", exact: true })
    .click();
  await expect(page.getByLabel("Branch name")).toHaveValue("");
  await expect(page.getByLabel("Branch name")).not.toHaveAttribute("required");
  await page
    .getByLabel("What changes?")
    .fill(
      "Provide free maintenance to every household participating in the pilot.",
    );
  await page
    .getByRole("button", { name: "Create branch", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Untitled simulation · branch",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Untitled simulation · branch",
      exact: true,
    }),
  ).toBeVisible();
});

test("configured local models accept an installed model ID without cloud consent", async ({
  page,
}) => {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.providers.find(
      (provider: { id: string }) => provider.id === "ollama",
    ).configured = true;
    payload.data.webSearchConfigured = true;
    await route.fulfill({ response, json: payload });
  });
  const submissions: Record<string, unknown>[] = [];
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      json: {
        error: {
          code: "MODEL_UNAVAILABLE",
          message: "Test endpoint unavailable.",
          retryable: true,
        },
      },
    });
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page
    .getByLabel("What do you want to explore?")
    .fill("How could local communities adapt to personal robots?");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Model", exact: true }).click();
  await page
    .getByRole("listbox")
    .getByRole("group", { name: "Ollama", exact: true })
    .getByRole("option", { name: "Qwen3 8B", exact: true })
    .click();
  await page.getByLabel("Installed model ID").fill("namespace/custom:8b");
  await expect(
    page.getByLabel("Allow cloud model processing for this run"),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Allow research agents to search the web"),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    title: "",
    model: { provider: "ollama", model: "namespace/custom:8b" },
    privacy: { allowCloud: false, allowWebSearch: false },
  });
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

test("creation leaves the form immediately and shows recorded progress in the chat", async ({
  page,
}) => {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  let created = false;
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    created = response.ok();
    await responseGate;
    await route.fulfill({ response });
  });
  const question =
    "What if everyone had a personal robot to help with everyday work?";
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page.getByLabel("Simulation name").fill("A robot in every home");
  await page.getByLabel("What do you want to explore?").fill(question);
  try {
    await page
      .getByRole("button", { name: "Create simulation", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".conversation-user-message")).toHaveText(
      `You${question}`,
    );
    const activity = page
      .locator(".conversation-content")
      .getByRole("region", { name: "Execution activity" });
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Working on the simulation");
    await expect.poll(() => created).toBe(true);
    await expect(activity.locator(".process-event")).not.toHaveCount(0);
    await expect(activity).toContainText("Demo");
    await expect(page.locator(".simulation-artifact")).toHaveCount(0);
    await expect(page.getByLabel("Message analyst")).toBeVisible();
    await expect(page.getByLabel("Message analyst")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByText("Keep this dialog open", { exact: false }),
    ).toHaveCount(0);
    await page.screenshot({
      path: "test-results/creation-progress-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const sidebar = await page.locator(".chat-sidebar").boundingBox();
        return sidebar!.x + sidebar!.width;
      })
      .toBeLessThanOrEqual(0);
    await expect(activity).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/creation-progress-mobile.png",
      fullPage: true,
    });
  } finally {
    releaseResponse();
  }
  await expect(
    page.getByRole("heading", { name: "A robot in every home", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Run one round", exact: true }),
  ).toBeEnabled();
});

test("a lost creation response keeps the full draft and retries without duplicating the simulation", async ({
  page,
}) => {
  const bodies: Record<string, unknown>[] = [];
  let drop = true;
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bodies.push(route.request().postDataJSON());
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  const question =
    "How might households adapt when everyone has a personal robot?";
  const context =
    "Assume affordable robots, limited energy and no access to private accounts.";
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page.getByLabel("Simulation name").fill("Robots with boundaries");
  await page.getByLabel("What do you want to explore?").fill(question);
  await page.getByLabel("Context & assumptions").fill(context);
  await page.locator('input[type="file"]').setInputFiles({
    name: "robot-brief.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Fictional modeling assumptions: energy capacity stays fixed during the pilot.",
    ),
  });
  await page
    .getByLabel("Access for robot-brief.md")
    .selectOption("analyst-only");
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await page.getByLabel("Actors", { exact: true }).fill("4");
  await page.getByLabel("Rounds", { exact: true }).fill("2");
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".conversation-user-message")).toContainText(
    question,
  );
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit scenario", exact: true })
    .click();
  await expect(page.getByLabel("Simulation name")).toHaveValue(
    "Robots with boundaries",
  );
  await expect(page.getByLabel("What do you want to explore?")).toHaveValue(
    question,
  );
  await expect(page.getByLabel("Context & assumptions")).toHaveValue(context);
  await expect(page.getByLabel("Access for robot-brief.md")).toHaveValue(
    "analyst-only",
  );
  await expect(
    page.getByLabel("Allow cloud model processing for this run"),
  ).not.toBeChecked();
  await page.getByRole("button", { name: /Simulation parameters/ }).click();
  await expect(page.getByLabel("Actors", { exact: true })).toHaveValue("4");
  await expect(page.getByLabel("Rounds", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page
    .getByRole("button", { name: "Retry simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Robots with boundaries", exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0].requestId).toBeTruthy();
  expect(bodies[1]).toEqual(bodies[0]);
  const response = await page.request.get("/api/simulations");
  const runs = (await response.json()).data;
  expect(
    runs.filter(
      (run: { title: string }) => run.title === "Robots with boundaries",
    ),
  ).toHaveLength(1);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Robots with boundaries", exact: true }),
  ).toBeVisible();
});

test("a new scenario replaces the active thread while preserving saved history", async ({
  page,
}) => {
  await demo(page);
  await page
    .getByRole("heading", { name: "The four-day experiment", exact: true })
    .click();
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog")).toBeVisible();
  const question =
    "What changes when personal robots become common across a city?";
  await page.getByLabel("Simulation name").fill("A city of robots");
  await page.getByLabel("What do you want to explore?").fill(question);
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await failureGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "DATABASE_UNAVAILABLE",
          message: "Storage is temporarily unavailable.",
          retryable: true,
        },
      }),
    });
  });
  try {
    await page
      .getByRole("button", { name: "Create simulation", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".conversation-user-message")).toContainText(
      question,
    );
    await expect(page.locator(".simulation-artifact")).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Saved chats" })
        .getByRole("button", { name: "The four-day experiment", exact: true }),
    ).toBeVisible();
  } finally {
    releaseFailure();
  }
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await expect(page.getByLabel("Describe a scenario")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".conversation-user-message")).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Saved chats" })
    .getByRole("button", { name: "The four-day experiment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "The four-day experiment", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("6 of 6 rounds complete", { exact: true }),
  ).toBeVisible();
});

test("a cloud scenario keeps explicit consent before moving progress into chat", async ({
  page,
}) => {
  let cloudModel = "";
  let cloudModelName = "";
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    const provider = payload.data.providers.find(
      (item: { id: string }) => item.id === "openai",
    );
    provider.configured = true;
    cloudModel = provider.models[0].id;
    cloudModelName = provider.models[0].name;
    payload.data.webSearchConfigured = true;
    await route.fulfill({ response, json: payload });
  });
  const submissions: Record<string, unknown>[] = [];
  // Intercept every create request: this browser test never invokes a cloud model.
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "MODEL_UNAVAILABLE",
          message: "The selected model is temporarily unavailable.",
          retryable: true,
        },
      }),
    });
  });
  await page.reload();
  await expect(page.getByLabel("Describe a scenario")).toBeVisible();
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: cloudModelName, exact: true }).click();
  const question =
    "What if personal robots were available to every household worldwide?";
  await page.getByLabel("Describe a scenario").fill(question);
  await page
    .getByRole("button", { name: "Start simulation", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Simulation name")).toHaveValue("");
  await expect(page.getByLabel("What do you want to explore?")).toHaveValue(
    question,
  );
  await expect(
    page.getByLabel("Allow cloud model processing for this run"),
  ).not.toBeChecked();
  await expect(
    dialog.getByRole("button", { name: "Create simulation", exact: true }),
  ).toBeDisabled();
  expect(submissions).toHaveLength(0);
  await page.getByLabel("Allow cloud model processing for this run").check();
  await page.getByLabel("Allow research agents to search the web").check();
  await dialog
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".conversation-user-message")).toContainText(
    question,
  );
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0].model).toEqual({
    provider: "openai",
    model: cloudModel,
  });
  expect(submissions[0].privacy).toEqual({
    allowCloud: true,
    allowWebSearch: true,
  });
  await page
    .getByRole("button", { name: "Edit scenario", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveText(cloudModelName);
  await expect(
    page.getByLabel("Allow cloud model processing for this run"),
  ).toBeChecked();
  await expect(
    page.getByLabel("Allow research agents to search the web"),
  ).toBeChecked();
});

test("creation authentication failures allow unlock without discarding the draft or retry identity", async ({
  page,
}) => {
  const submissions: Record<string, unknown>[] = [];
  let expired = true;
  await page.route("**/api/simulations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(route.request().postDataJSON());
    if (expired) {
      expired = false;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "AUTH_REQUIRED",
            message: "Unlock this workspace in Settings to continue.",
            retryable: false,
          },
        }),
      });
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Add sources and configure scenario" })
    .click();
  await page.getByLabel("Simulation name").fill("Resume after unlock");
  const question =
    "How would personal robots change a small community's daily routines?";
  await page.getByLabel("What do you want to explore?").fill(question);
  await page.locator('input[type="file"]').setInputFiles({
    name: "private-assumptions.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "Fictional analyst-only context for the retry regression.",
    ),
  });
  await page
    .getByLabel("Access for private-assumptions.md")
    .selectOption("analyst-only");
  await page
    .getByRole("button", { name: "Create simulation", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry simulation", exact: true }),
  ).toBeVisible();
  await unlock(page);
  await expect(page.locator(".conversation-user-message")).toContainText(
    question,
  );
  await page
    .getByRole("button", { name: "Retry simulation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Resume after unlock", exact: true }),
  ).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[0].requestId).toBeTruthy();
  expect(submissions[1]).toEqual(submissions[0]);
  expect(submissions[1].sources).toEqual([
    {
      name: "private-assumptions.md",
      content: "Fictional analyst-only context for the retry regression.",
      access: "analyst-only",
    },
  ]);
});
