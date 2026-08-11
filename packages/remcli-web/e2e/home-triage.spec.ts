import { expect, test, type Page } from "@playwright/test";

async function openHomeTriage(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto("/?fixtures=1&homeTriage=full", { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
    const viewportMetrics = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));

    expect(viewportMetrics.scrollWidth, JSON.stringify(viewportMetrics)).toBeLessThanOrEqual(viewportMetrics.clientWidth + 1);
}

test("Home triage keeps mobile and desktop filters, keyboard selection, and quick Resume usable", async ({ page }) => {
    const issues: string[] = [];
    page.on("console", (message) => {
        if (message.type() === "error") issues.push(message.text());
    });
    page.on("pageerror", (error) => issues.push(error.message));

    await openHomeTriage(page);

    const active = page.getByRole("button", { name: "Active", exact: true });
    const attention = page.getByRole("button", { name: "Attention", exact: true });
    const completed = page.getByRole("button", { name: "Completed", exact: true });

    await expect(active).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /webapp/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /mobile/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await attention.focus();
    await attention.press("Enter");
    await expect(attention).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /mobile/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /webapp/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await completed.click();
    await expect(completed).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /release-notes/ })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);

    const quickResume = page.locator("[data-home-quick-resume]:visible");
    await expect(quickResume).toBeVisible();
    await quickResume.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page).toHaveURL(/\/session\/fx-resume-codex-\d+$/);
    await expect(page.getByRole("banner")).toContainText(/codex/);
    await expectNoHorizontalOverflow(page);
    expect(issues).toEqual([]);
});
