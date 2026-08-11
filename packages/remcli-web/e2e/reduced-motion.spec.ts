import { expect, test, type Page } from "@playwright/test";

interface AnimationReport {
    duration: number;
    keyframes: Array<{ opacity: string | null; transform: string | null }>;
}

async function openReducedMotionFixture(page: Page, path: string): Promise<void> {
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
}

async function readAnimationReport(page: Page, selector: string): Promise<AnimationReport[]> {
    return page.locator(selector).evaluate((element) => element
        .getAnimations({ subtree: false })
        .map((animation) => {
            const effect = animation.effect;
            const keyframes = effect instanceof KeyframeEffect ? effect.getKeyframes() : [];
            return {
                duration: Number(effect?.getComputedTiming().duration ?? 0),
                keyframes: keyframes.map((frame) => ({
                    opacity: typeof frame.opacity === "string" ? frame.opacity : null,
                    transform: typeof frame.transform === "string" ? frame.transform : null,
                })),
            };
        }),
    );
}

function expectOpacityOnly(report: AnimationReport[]): void {
    expect(report).not.toEqual([]);
    expect(report.every((animation) => animation.duration === 120)).toBe(true);
    expect(report.flatMap((animation) => animation.keyframes)
        .every((frame) => frame.transform === null || frame.transform === "none")).toBe(true);
}

test("reduced motion keeps Command Palette and Zen menu animations opacity-only", async ({ page }) => {
    await openReducedMotionFixture(page, "/?fixtures=1");
    await page.getByRole("button", { name: "Search (⌘K)" }).click();
    await expect(page.locator('[data-command-palette-content]')).toBeVisible();
    expectOpacityOnly(await readAnimationReport(page, '[data-command-palette-content]'));

    await page.goto("/zen?fixtures=1", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Actions for Показать латентность/i }).click();
    await expect(page.locator('[data-slot="dropdown-menu-content"]')).toBeVisible();
    expectOpacityOnly(await readAnimationReport(page, '[data-slot="dropdown-menu-content"]'));
});
