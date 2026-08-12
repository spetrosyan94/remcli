import { expect, test } from "@playwright/test";
import { openFixtureRoute } from "./support/fixtureRoute";

const SETTINGS_ROUTE = { name: "settings", path: "/settings" } as const;
const LONG_SETTINGS_ROUTE = { name: "settings", path: "/settings?longValues=1" } as const;
const THEMES = ["dark", "light"] as const;
const MOBILE_VIEWPORT_WIDTH = 390;
const MOBILE_INPUT_MIN_HEIGHT_PX = 44;
const DESKTOP_INPUT_HEIGHT_PX = 32;

test.describe("Settings", () => {
    test.describe.configure({ mode: "serial" });

    for (const theme of THEMES) {
        test(`settings rename input fits the ${theme} touch and desktop size contract`, async ({ page }) => {
            await openFixtureRoute(page, SETTINGS_ROUTE, theme);
            await page.getByRole("button", { name: "macbook-pro.local", exact: true }).click();
            await page.getByRole("menuitem", { name: "Rename", exact: true }).click();

            const input = page.getByPlaceholder("machine name");
            await expect(input).toBeVisible();
            const inputHeight = await input.evaluate((element) => element.getBoundingClientRect().height);

            if (page.viewportSize()?.width === MOBILE_VIEWPORT_WIDTH) {
                expect(inputHeight).toBeGreaterThanOrEqual(MOBILE_INPUT_MIN_HEIGHT_PX);
                return;
            }

            expect(inputHeight).toBe(DESKTOP_INPUT_HEIGHT_PX);
        });

        test(`settings ${theme} TTS provider row has no selection affordance`, async ({ page }) => {
            await openFixtureRoute(page, SETTINGS_ROUTE, theme);

            const providerRow = page.getByText("TTS provider", { exact: true }).locator("..");
            await expect(providerRow).toBeVisible();
            await expect(providerRow.locator("button")).toHaveCount(0);
            await expect(providerRow.locator("svg")).toHaveCount(0);
        });
    }

    test("settings keeps a long machine name inside the mobile viewport", async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile-chromium", "Long machine-name overflow is a mobile-only contract.");

        await openFixtureRoute(page, LONG_SETTINGS_ROUTE, "dark");

        const longMachineName = page.getByText("macbook-pro-engineering-workstation-with-an-intentionally-long-hostname.local", { exact: true });
        await expect(longMachineName).toBeVisible();
        await expect(longMachineName).toHaveCSS("text-overflow", "ellipsis");
        await expect(longMachineName).toHaveCSS("white-space", "nowrap");

        const viewport = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
    });
});
