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

async function readAnimationReport(page: Page, selector: string, hasText?: string): Promise<AnimationReport[]> {
    const locator = hasText ? page.locator(selector).filter({ hasText }) : page.locator(selector);
    return locator.evaluate((element) => element
        .getAnimations({ subtree: false })
        .filter((animation) => animation.animationName === "remcli-reduced-fade-in")
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

function expectPermissionOpacityOnly(report: AnimationReport[]): void {
    expectOpacityOnly(report);
    expect(report.flatMap((animation) => animation.keyframes)
        .every((frame) => frame.opacity !== null)).toBe(true);
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

test("reduced motion keeps chat permission entry opacity-only", async ({ page }) => {
    await openReducedMotionFixture(page, "/session/fx-chat?fixtures=1");

    const permissionEntry = page.locator("[data-permission-entry]").filter({ hasText: "npm install left-pad" });
    await expect(permissionEntry).toHaveCount(1);
    const motion = await permissionEntry.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            animationTimingFunction: style.animationTimingFunction,
            transform: style.transform,
        };
    });
    expect(motion.animationName).toBe("remcli-reduced-fade-in");
    expect(motion.animationDuration).toBe("0.12s");
    expect(motion.animationTimingFunction).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(motion.transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expectPermissionOpacityOnly(await readAnimationReport(page, "[data-permission-entry]", "npm install left-pad"));
});

test("reduced motion keeps permission response feedback opacity-only", async ({ page }) => {
    await openReducedMotionFixture(page, "/session/fx-chat?fixtures=1&permissionResponse=error-once");

    const permissionEntry = page.locator("[data-permission-entry]").filter({ hasText: "npm install left-pad" });
    await permissionEntry.getByRole("button", { name: "Allow", exact: true }).click();

    const feedback = permissionEntry.getByRole("alert");
    await expect(feedback).toBeVisible();
    const motion = await feedback.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return {
            animationName: style.animationName,
            animationDuration: style.animationDuration,
            transform: style.transform,
            transitionProperty: style.transitionProperty,
        };
    });

    expect(motion.animationName).toBe("remcli-reduced-fade-in");
    expect(motion.animationDuration).toBe("0.12s");
    expect(motion.transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    expect(motion.transitionProperty).toBe("opacity");
    expectPermissionOpacityOnly(await readAnimationReport(page, '[data-permission-response="error"]'));
});

test("reduced motion keeps execution radio selection triggers at identity scale", async ({ page }) => {
    await openReducedMotionFixture(page, "/session/fx-chat?fixtures=1");

    const executionTrigger = page.getByRole("button", { name: /next message settings/i });
    await executionTrigger.click();

    const drawer = page.locator("#chat-next-message-drawer");
    await expect(drawer.getByRole("radio", { name: "GPT-5.6-Terra", exact: true })).toBeVisible();

    for (const name of ["GPT-5.6-Terra", "high"]) {
        const option = drawer.getByRole("radio", { name, exact: true }).locator("..");
        const box = await option.boundingBox();
        if (!box) throw new Error(`Radio option ${name} has no layout box`);

        await expect(option).toHaveClass(/motion-reduce:active:scale-100/);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        const activeState = await option.evaluate((element) => ({
            transform: window.getComputedStyle(element).transform,
        }));
        expect(activeState.transform).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
        await page.mouse.up();
    }
});
