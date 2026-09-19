import { expect, test, type Page } from "@playwright/test";

async function openHomeTriage(page: Page, path = "/?fixtures=1&homeTriage=full"): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
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

    const jarvisCard = page.locator('[data-home-system-card="jarvis"]:visible');
    await expect(jarvisCard).toHaveCount(1);
    await expect(jarvisCard).toHaveAttribute("aria-label", "concierge");
    await expect(jarvisCard).toHaveAttribute("data-home-system-card-state", "available");
    await expect(jarvisCard.locator("svg")).toHaveCount(2);
    const jarvisBox = await jarvisCard.boundingBox();
    expect(jarvisBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    const active = page.getByRole("radio", { name: "Active", exact: true });
    const attention = page.getByRole("radio", { name: "Attention", exact: true });
    const completed = page.getByRole("radio", { name: "Completed", exact: true });

    await expect(active).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: /webapp/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /mobile/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await attention.focus();
    await attention.press("Enter");
    await expect(attention).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("button", { name: /mobile/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /webapp/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await completed.click();
    await expect(completed).toHaveAttribute("aria-checked", "true");
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

test("Home crossfades loading without hidden content reserving layout", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "The loading surface exists only in MobileHome.");
    await openHomeTriage(page);

    await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        const state = useProtocolStore.getState();
        state.replaceSessions([]);
        state.replaceMachines([]);
        state.setConnectionStatus("connecting");
    });

    const loading = page.locator("[data-home-loading]:visible");
    const content = page.locator("[data-home-content]");
    await expect(loading).toBeVisible();
    await expect(content).toHaveAttribute("aria-hidden", "true");
    await expect(content).toHaveAttribute("inert", "");
    const hiddenLogoMotion = await content.locator(".empty-state-logo path").first().evaluate((element) => ({
        playState: getComputedStyle(element).animationPlayState,
        duration: getComputedStyle(element).animationDuration,
    }));
    expect(hiddenLogoMotion.playState).toBe("paused");
    expect(hiddenLogoMotion.duration).toBe("1.4s");

    const loadingLayout = await page.locator("[data-home-loading]").evaluate((element) => ({
        position: getComputedStyle(element).position,
        parentHeight: element.parentElement?.getBoundingClientRect().height ?? 0,
        height: element.getBoundingClientRect().height,
        duration: getComputedStyle(element).transitionDuration,
    }));
    expect(loadingLayout.position).toBe("relative");
    expect(loadingLayout.parentHeight).toBeCloseTo(loadingLayout.height, 0);
    expect(loadingLayout.duration).toContain("0.2s");

    await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        useProtocolStore.getState().setConnectionStatus("connected");
    });
    await expect(content).toHaveAttribute("aria-hidden", "false", { timeout: 2_000 });

    const resolvedLayout = await content.evaluate((element) => ({
        position: getComputedStyle(element).position,
    }));
    expect(resolvedLayout.position).toBe("relative");
    await expect(page.locator("[data-home-loading]")).toHaveCSS("position", "absolute");
    await expect(content.locator(".empty-state-logo path").first()).toHaveCSS("animation-play-state", "running");
    await expectNoHorizontalOverflow(page);
});

test("Home keeps the top anchor stable when loading reveals populated sessions", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.includes("mobile"), "The loading surface exists only in MobileHome.");
    await openHomeTriage(page);

    const fixtureSnapshot = await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        const state = useProtocolStore.getState();
        return {
            machines: Object.values(state.machines),
            sessions: Object.values(state.sessions),
        };
    });

    await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        const state = useProtocolStore.getState();
        state.replaceSessions([]);
        state.replaceMachines([]);
        state.setConnectionStatus("connecting");
    });

    const loading = page.locator("[data-home-loading]:visible");
    const content = page.locator("[data-home-content]");
    const main = page.locator("main");
    const loadingTop = await loading.evaluate((element) => element.getBoundingClientRect().top);
    const initialScrollTop = await main.evaluate((element) => element.scrollTop);

    await page.evaluate(async (snapshot) => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        const state = useProtocolStore.getState();
        state.replaceMachines(snapshot.machines);
        state.replaceSessions(snapshot.sessions);
        state.setConnectionStatus("connected");
    }, fixtureSnapshot);

    await expect(content).toHaveAttribute("aria-hidden", "false", { timeout: 2_000 });
    await expect(page.locator("[data-home-loading]")).toHaveCSS("position", "absolute");
    await expect(page.getByRole("button", { name: /webapp/ })).toHaveCount(1);

    const revealed = await content.evaluate((element) => ({
        top: element.getBoundingClientRect().top,
        position: getComputedStyle(element).position,
    }));
    expect(revealed.position).toBe("relative");
    expect(revealed.top).toBeCloseTo(loadingTop, 0);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(initialScrollTop);
    await expectNoHorizontalOverflow(page);
});

test("Home keeps Jarvis visible as an explicit unavailable system state and opens concierge", async ({ page }) => {
    for (const scenario of ["disabled", "unavailable"] as const) {
        await openHomeTriage(page, `/?fixtures=1&conciergeStatus=${scenario}`);

        const jarvisCard = page.locator('[data-home-system-card="jarvis"]:visible');
        await expect(jarvisCard).toHaveCount(1);
        await expect(jarvisCard).toHaveAttribute("data-home-system-card-state", "unavailable");
        await expect(jarvisCard).toContainText("concierge unavailable");

        await jarvisCard.click();
        await expect(page).toHaveURL(/\/concierge$/);
    }
});

test("Home Jarvis state does not retain available after connection loss", async ({ page }) => {
    await openHomeTriage(page);

    const jarvisCard = page.locator('[data-home-system-card="jarvis"]:visible');
    await expect(jarvisCard).toHaveAttribute("data-home-system-card-state", "available");

    await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        useProtocolStore.getState().setConnectionStatus("connecting");
    });
    await expect(jarvisCard).toHaveAttribute("data-home-system-card-state", "checking");

    await page.evaluate(async () => {
        const { useProtocolStore } = await import("/src/lib/protocol/store.ts");
        useProtocolStore.getState().setConnectionStatus("disconnected");
    });
    await expect(jarvisCard).toHaveAttribute("data-home-system-card-state", "unavailable");
});
