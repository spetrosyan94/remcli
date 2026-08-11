import { expect, test, type Page } from "@playwright/test";

async function openFixtureChat(page: Page, responseMode: "delayed" | "error-once"): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto(`/session/fx-chat?fixtures=1&permissionResponse=${responseMode}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
}

function normalPermissionCard(page: Page) {
    return page.locator('[data-permission-response-state]').filter({ hasText: "npm install left-pad" });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));

    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test("permission response remains visible and blocks duplicate actions until the daemon update", async ({ page }) => {
    await openFixtureChat(page, "delayed");

    const card = normalPermissionCard(page);
    const allow = card.getByRole("button", { name: "Allow", exact: true });
    await allow.click();

    await expect(card).toHaveAttribute("aria-busy", "true");
    await expect(card.getByRole("status")).toHaveText("sending response…");
    await expect(allow).toBeDisabled();
    await expect(card.getByRole("button", { name: "Deny", exact: true })).toBeDisabled();
    await assertNoHorizontalOverflow(page);

    await expect(card).toHaveCount(0);
});

test("permission response failure preserves the request and retries the original action", async ({ page }) => {
    await openFixtureChat(page, "error-once");

    const card = normalPermissionCard(page);
    const allow = card.getByRole("button", { name: "Allow", exact: true });
    await allow.click();

    await expect(card.getByRole("alert")).toHaveText("could not send responseRetry");
    await expect(allow).toBeEnabled();
    await card.getByRole("button", { name: "Retry", exact: true }).click();

    await expect(card).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
});
