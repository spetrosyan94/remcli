import { expect, test, type Page } from "@playwright/test";

const FIXTURE_TIME = new Date("2026-06-15T10:00:00.000Z");
const CHILD_SESSION_ID = "fx-lineage-child";
type LineageFixtureScenario = "recovery" | "reconnect-callback" | "stable-parent" | "unavailable" | "foreign-parent";

interface LineageMetrics {
    refreshSessionsCalls: number;
    reconnects: number;
    parentHistoryLoads: number;
    sentSessionIds: string[];
}

async function openLineageFixture(page: Page, scenario: LineageFixtureScenario): Promise<void> {
    await page.clock.setFixedTime(FIXTURE_TIME);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });

    await page.goto(`/session/${CHILD_SESSION_ID}?fixtures=1&lineageFixture=${scenario}`, {
        waitUntil: "domcontentloaded",
    });
    await expect(page.locator("header")).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
}

async function readMetrics(page: Page): Promise<LineageMetrics> {
    return page.evaluate(async () => {
        const { fixtureLineageMetrics } = await import("/src/lib/fixtures/index.ts");
        return fixtureLineageMetrics();
    });
}

async function triggerFixtureProtocolReconnect(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const { runFixtureProtocolReconnect } = await import("/src/lib/protocol/client.ts");
        await runFixtureProtocolReconnect();
    });
    await expect.poll(async () => (await readMetrics(page)).reconnects).toBe(1);
}

type NumericLineageMetric = "refreshSessionsCalls" | "reconnects" | "parentHistoryLoads";

async function expectStableLineageMetric(
    page: Page,
    metric: NumericLineageMetric,
    expected: number,
): Promise<void> {
    let consecutiveMatches = 0;
    await expect.poll(async () => {
        const actual = (await readMetrics(page))[metric];
        consecutiveMatches = actual === expected ? consecutiveMatches + 1 : 0;
        return consecutiveMatches;
    }, { intervals: [50, 100, 250], timeout: 5_000 }).toBeGreaterThanOrEqual(3);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const report = await page.evaluate(() => ({
        viewportWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
    }));

    expect(report.documentScrollWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.viewportWidth + 1);
    expect(report.bodyScrollWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.viewportWidth + 1);
}

test("fixture reconnect runner rejects outside fixture mode", async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.removeItem("remcli-fixtures");
    });

    await page.goto("/?fixtures=0&lineageFixture=recovery", { waitUntil: "domcontentloaded" });
    const errorMessage = await page.evaluate(async () => {
        const { runFixtureProtocolReconnect } = await import("/src/lib/protocol/client.ts");
        try {
            await runFixtureProtocolReconnect();
            return null;
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    });

    expect(errorMessage).toBe("Fixture protocol reconnect is available only in fixture mode");
});

test("mounted ChatPage recovers a missing trusted parent from the central reconnect snapshot", async ({ page }) => {
    await openLineageFixture(page, "reconnect-callback");

    await expect(page.locator("header")).toContainText("cursor");
    const missingNotice = page.locator('[data-lineage-notice="missing-parent"]');
    await expect(missingNotice).toBeVisible();
    await expectStableLineageMetric(page, "refreshSessionsCalls", 1);
    const metricsBeforeReconnect = await readMetrics(page);
    expect(metricsBeforeReconnect).toEqual({
        refreshSessionsCalls: 1,
        reconnects: 0,
        parentHistoryLoads: 0,
        sentSessionIds: [],
    });

    await triggerFixtureProtocolReconnect(page);
    await expectStableLineageMetric(page, "reconnects", 1);
    await expectStableLineageMetric(page, "refreshSessionsCalls", 2);
    await expectStableLineageMetric(page, "parentHistoryLoads", 1);
    await expect(missingNotice).toHaveCount(0);
    await expect(page.getByText("Parent prompt", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Parent answer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Child prompt", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Child answer", { exact: true })).toHaveCount(1);
    const metricsAfterReconnect = await readMetrics(page);
    expect(metricsAfterReconnect).toEqual({
        refreshSessionsCalls: 2,
        reconnects: 1,
        parentHistoryLoads: 1,
        sentSessionIds: [],
    });
    expect(metricsAfterReconnect.reconnects - metricsBeforeReconnect.reconnects).toBe(1);
    expect(metricsAfterReconnect.refreshSessionsCalls - metricsBeforeReconnect.refreshSessionsCalls).toBe(1);
    expect(metricsAfterReconnect.parentHistoryLoads - metricsBeforeReconnect.parentHistoryLoads).toBe(1);

    const feedText = await page.locator("main").innerText();
    expect(feedText.indexOf("Parent prompt")).toBeLessThan(feedText.indexOf("Child prompt"));
    expect(feedText.indexOf("Parent answer")).toBeLessThan(feedText.indexOf("Child answer"));

    const input = page.getByPlaceholder("Message the agent…");
    await input.fill("Child outbound");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Child outbound", { exact: true })).toBeVisible();
    await expect.poll(async () => (await readMetrics(page)).sentSessionIds).toEqual([CHILD_SESSION_ID]);
    expect((await readMetrics(page)).parentHistoryLoads).toBe(1);

    await assertNoHorizontalOverflow(page);
});

test("mounted ChatPage keeps the missing-parent state when reconnect removes a stale parent", async ({ page }) => {
    await openLineageFixture(page, "recovery");

    await expect(page.locator("header")).toContainText("cursor");
    const missingNotice = page.locator('[data-lineage-notice="missing-parent"]');
    await expect(page.getByText("Parent prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Parent answer", { exact: true })).toBeVisible();
    await expect(page.getByText("Child answer", { exact: true })).toBeVisible();
    await expectStableLineageMetric(page, "parentHistoryLoads", 1);
    const initialMetrics = await readMetrics(page);
    expect(initialMetrics.parentHistoryLoads).toBe(1);
    expect(initialMetrics.refreshSessionsCalls).toBe(0);
    expect(initialMetrics.reconnects).toBe(0);

    await triggerFixtureProtocolReconnect(page);
    await expect(missingNotice).toBeVisible();
    await expectStableLineageMetric(page, "refreshSessionsCalls", 1);
    await expectStableLineageMetric(page, "parentHistoryLoads", 1);
    const missingLineageSegment = page.locator('[data-lineage-status="missing-parent"]');
    await expect(missingLineageSegment.getByText("Parent prompt", { exact: true })).toHaveCount(0);
    await expect(missingLineageSegment.getByText("Parent answer", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Child prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Child answer", { exact: true })).toBeVisible();
    const metricsAfterReconnect = await readMetrics(page);
    expect(metricsAfterReconnect.reconnects).toBe(1);
    expect(metricsAfterReconnect.refreshSessionsCalls).toBe(1);

    expect(metricsAfterReconnect.parentHistoryLoads).toBe(initialMetrics.parentHistoryLoads);
    expect(metricsAfterReconnect.parentHistoryLoads - initialMetrics.parentHistoryLoads).toBe(0);

    await assertNoHorizontalOverflow(page);
});

test("mounted ChatPage performs one explicit parent refresh after a later reconnect", async ({ page }) => {
    await openLineageFixture(page, "stable-parent");

    await expectStableLineageMetric(page, "parentHistoryLoads", 1);
    await expect(page.getByText("Parent prompt", { exact: true })).toHaveCount(1);
    const metricsBeforeReconnect = await readMetrics(page);
    expect(metricsBeforeReconnect).toEqual({
        refreshSessionsCalls: 0,
        reconnects: 0,
        parentHistoryLoads: 1,
        sentSessionIds: [],
    });

    await triggerFixtureProtocolReconnect(page);
    await expectStableLineageMetric(page, "reconnects", 1);
    await expectStableLineageMetric(page, "refreshSessionsCalls", 1);
    await expectStableLineageMetric(page, "parentHistoryLoads", 2);
    await expect(page.getByText("Parent prompt", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Parent answer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Child prompt", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Child answer", { exact: true })).toHaveCount(1);
    const metricsAfterReconnect = await readMetrics(page);
    expect(metricsAfterReconnect.reconnects - metricsBeforeReconnect.reconnects).toBe(1);
    expect(metricsAfterReconnect.refreshSessionsCalls - metricsBeforeReconnect.refreshSessionsCalls).toBe(1);
    expect(metricsAfterReconnect.parentHistoryLoads - metricsBeforeReconnect.parentHistoryLoads).toBe(1);

    await assertNoHorizontalOverflow(page);
});

test("mounted ChatPage rejects a foreign Cursor parent at the trust boundary", async ({ page }) => {
    await openLineageFixture(page, "foreign-parent");

    await expect(page.locator('[data-lineage-notice="missing-parent"]')).toBeVisible();
    await expect(page.getByText("Child prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Child answer", { exact: true })).toBeVisible();
    await expect(page.getByText("Foreign parent prompt", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Foreign parent answer", { exact: true })).toHaveCount(0);
    await expectStableLineageMetric(page, "parentHistoryLoads", 0);
    expect((await readMetrics(page)).parentHistoryLoads).toBe(0);

    await assertNoHorizontalOverflow(page);
});

test("mounted ChatPage shows a visible degraded notice when trusted parent history is unavailable", async ({ page }) => {
    await openLineageFixture(page, "unavailable");

    await expectStableLineageMetric(page, "parentHistoryLoads", 1);
    const unavailableNotice = page.locator('[data-lineage-notice="unavailable"]');
    await expect(unavailableNotice).toBeVisible();
    await expect(unavailableNotice).toContainText("previous history unavailable");
    const unavailableLineageSegment = page.locator('[data-lineage-status="unavailable"]');
    await expect(unavailableLineageSegment.getByText("Parent prompt", { exact: true })).toHaveCount(0);
    await expect(unavailableLineageSegment.getByText("Parent answer", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Parent answer", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Child prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Child answer", { exact: true })).toBeVisible();

    await assertNoHorizontalOverflow(page);
});
