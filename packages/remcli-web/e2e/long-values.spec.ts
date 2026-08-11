import { expect, test, type Page } from "@playwright/test";
import { openFixtureRoute } from "./support/fixtureRoute";

const LONG_MACHINE_HOST = "macbook-pro-engineering-workstation-with-an-intentionally-long-hostname.local";
const LONG_CODEX_MODEL_LABEL = "GPT-5.6-Luna extended-context engineering profile with a deliberately long display name";

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));

    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test("New Session keeps long machine and model values within the available control width", async ({ page }) => {
    await openFixtureRoute(
        page,
        { name: "new-session-long-values", path: "/new?longValues=1" },
        "dark",
    );

    const machineControl = page.getByRole("button", { name: new RegExp(LONG_MACHINE_HOST) });
    const modelControl = page.locator('[data-capability-control="model"]').getByRole("button");
    await expect(machineControl).toBeVisible();
    await expect(modelControl).toHaveAccessibleName(new RegExp(LONG_CODEX_MODEL_LABEL));

    for (const control of [machineControl, modelControl]) {
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect((box?.x ?? -1) + (box?.width ?? 0)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
    await assertNoHorizontalOverflow(page);
});
