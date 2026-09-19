import { expect, test, type Page } from "@playwright/test";

type FixtureTheme = "dark" | "light";
type FixtureMotion = "reduce" | "no-preference";
type UrlOpenResult = "opened" | "blocked";

async function openStructuredFixture(
    page: Page,
    query: string,
    options: { theme?: FixtureTheme; motion?: FixtureMotion; urlOpenResult?: UrlOpenResult } = {},
): Promise<void> {
    const theme = options.theme ?? "dark";
    const motion = options.motion ?? "reduce";
    await page.emulateMedia({ colorScheme: theme, reducedMotion: motion });
    await page.addInitScript(({ selectedTheme, urlOpenResult }) => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", selectedTheme);

        type StructuredWindowState = {
            openCalls: Array<{ url: string; target: string }>;
            navigated: string[];
            closed: number;
            popup: { opener: unknown; location: { replace: (url: string) => void }; close: () => void };
        };
        const host = window as typeof window & { __structuredWindowState?: StructuredWindowState };
        const state: StructuredWindowState = {
            openCalls: [],
            navigated: [],
            closed: 0,
            popup: {
                opener: { parent: true },
                location: { replace: (url: string) => state.navigated.push(url) },
                close: () => { state.closed += 1; },
            },
        };
        host.__structuredWindowState = state;
        if (urlOpenResult) {
            window.open = (url?: string | URL, target?: string) => {
                state.openCalls.push({ url: String(url), target: target ?? "" });
                return urlOpenResult === "opened" ? state.popup as unknown as Window : null;
            };
        }
    }, { selectedTheme: theme, urlOpenResult: options.urlOpenResult });
    await page.goto(`/session/fx-chat?fixtures=1&${query}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function assertBlockingComposer(page: Page): Promise<void> {
    await expect(page.getByPlaceholder("Answer the blocking request before sending a chat message.")).toBeDisabled();
}

for (const theme of ["light", "dark"] as const) {
    test(`structured card honors the ${theme} runtime theme without overflow`, async ({ page }) => {
        await openStructuredFixture(page, "structured=mcp-form", { theme });

        if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
        else await expect(page.locator("html")).not.toHaveClass(/dark/);
        await expect(page.locator('[data-structured-kind="mcp-form"]')).toBeVisible();
        await assertBlockingComposer(page);
        await assertNoHorizontalOverflow(page);
    });
}

for (const motion of ["no-preference", "reduce"] as const) {
    test(`structured entry uses the ${motion} motion contract`, async ({ page }) => {
        await openStructuredFixture(page, "structured=tool-input", { motion });
        const entry = page.locator("[data-structured-entry]");

        if (motion === "no-preference") {
            await expect(entry).toHaveClass(/slide-in-from-bottom-2/);
            await expect(entry).toHaveClass(/zoom-in-\[\.99\]/);
        }
        const animationDuration = await entry.evaluate((element) => getComputedStyle(element).animationDuration);
        expect(animationDuration).toBe(motion === "reduce" ? "0.12s" : "0.24s");
        await assertNoHorizontalOverflow(page);
    });
}

test("tool-input renders A/B/C, mutually exclusive Other, free input, and password semantics", async ({ page }) => {
    await openStructuredFixture(page, "structured=tool-input");

    const card = page.locator('[data-structured-kind="tool-input"]');
    const submit = card.getByRole("button", { name: "Submit", exact: true });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("radio", { name: "A · current package", exact: true })).toBeVisible();
    await expect(card.getByRole("radio", { name: "B · all workspaces", exact: true })).toBeVisible();
    await expect(card.getByRole("radio", { name: "C · fixture only", exact: true })).toBeVisible();
    await expect(card.getByRole("radio", { name: "Other", exact: true })).toBeVisible();
    await expect(card.getByLabel("Temporary verification code", { exact: true })).toHaveAttribute("type", "password");
    await expect(card.getByLabel("Anything else the agent should consider?", { exact: true })).toHaveAttribute("type", "text");
    await expect(submit).toBeDisabled();

    const optionA = card.getByRole("radio", { name: "A · current package", exact: true });
    await optionA.click();
    await card.getByRole("radio", { name: "Other", exact: true }).click();
    await expect(optionA).not.toBeChecked();
    await card.getByPlaceholder("Type another answer").fill("custom target");
    await card.getByRole("radio", { name: "B · all workspaces", exact: true }).click();
    await expect(card.getByPlaceholder("Type another answer")).toHaveCount(0);
    await card.getByLabel("Temporary verification code", { exact: true }).fill("temporary-code");
    await expect(submit).toBeEnabled();
    await assertBlockingComposer(page);
    await assertNoHorizontalOverflow(page);
});

test("mixed MCP form uses native formats, explicit boolean radios, defaults, and invalid submit gate", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-form");

    const card = page.locator('[data-structured-kind="mcp-form"]');
    const submit = card.getByRole("button", { name: "Submit", exact: true });
    await expect(card.getByLabel("Contact email", { exact: true })).toHaveAttribute("type", "email");
    await expect(card.getByLabel("Callback URI", { exact: true })).toHaveAttribute("type", "url");
    await expect(card.getByLabel("Release date", { exact: true })).toHaveAttribute("type", "date");
    await expect(card.getByLabel("Scheduled at", { exact: true })).toHaveAttribute("type", "datetime-local");
    const expectedLocalDefault = await page.evaluate(() => {
        const value = new Date("2030-05-17T14:30:00Z");
        const pad = (part: number, width = 2) => String(part).padStart(width, "0");
        return `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    });
    await expect(card.getByLabel("Scheduled at", { exact: true })).toHaveValue(expectedLocalDefault.slice(0, 16));
    expect(expectedLocalDefault).not.toContain("Z");
    await expect(card.getByRole("radio", { name: "Staging", exact: true })).toBeChecked();
    await expect(card.getByLabel("Replicas", { exact: true })).toHaveValue("2");
    await expect(card.locator('[data-structured-field="dryRun"] [data-boolean-state]')).toHaveText("Not selected");
    await expect(card.getByRole("radio", { name: "Yes", exact: true })).toBeVisible();
    await expect(card.getByRole("radio", { name: "No", exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();

    await card.getByLabel("Contact email", { exact: true }).fill("invalid");
    await card.getByRole("radio", { name: "No", exact: true }).click();
    await card.getByRole("checkbox", { name: "Web", exact: true }).check();
    await expect(submit).toBeDisabled();
    await card.getByLabel("Contact email", { exact: true }).fill("dev@example.com");
    await expect(submit).toBeEnabled();

    await card.getByRole("checkbox", { name: "Other", exact: true }).check();
    await card.getByPlaceholder("Type another answer").fill("worker");
    await expect(submit).toBeEnabled();
    await assertBlockingComposer(page);
    await assertNoHorizontalOverflow(page);
});

test("duplicate submit is gated and success remains announced after authoritative card removal", async ({ page }) => {
    await openStructuredFixture(page, "structured=tool-input&structuredResponse=delayed");
    await page.evaluate(() => {
        const lifecycle: { addedAt: number | null; removedAt: number | null } = { addedAt: null, removedAt: null };
        (window as typeof window & { __structuredToastLifecycle?: typeof lifecycle }).__structuredToastLifecycle = lifecycle;
        const observer = new MutationObserver(() => {
            const toast = document.querySelector('[data-sonner-toast]');
            if (toast && lifecycle.addedAt === null) lifecycle.addedAt = performance.now();
            if (!toast && lifecycle.addedAt !== null && lifecycle.removedAt === null) {
                lifecycle.removedAt = performance.now();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });

    const card = page.locator('[data-structured-kind="tool-input"]');
    await card.getByRole("radio", { name: "A · current package", exact: true }).click();
    await card.getByLabel("Temporary verification code", { exact: true }).fill("temporary-code");
    const submit = card.getByRole("button", { name: "Submit", exact: true });
    await submit.evaluate((button) => {
        (button as HTMLButtonElement).click();
        (button as HTMLButtonElement).click();
    });
    await expect(submit).toBeDisabled();
    await expect(card).toHaveCount(0);

    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Response sent." });
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeVisible();
    await page.waitForFunction(() => {
        const lifecycle = (window as typeof window & { __structuredToastLifecycle?: { removedAt: number | null } }).__structuredToastLifecycle;
        return lifecycle?.removedAt !== null;
    });
    const lifetime = await page.evaluate(() => {
        const lifecycle = (window as typeof window & { __structuredToastLifecycle: { addedAt: number; removedAt: number } }).__structuredToastLifecycle;
        return lifecycle.removedAt - lifecycle.addedAt;
    });
    expect(lifetime).toBeGreaterThanOrEqual(1_500);
});

test("structured submit error preserves values and retries successfully", async ({ page }) => {
    await openStructuredFixture(page, "structured=tool-input&structuredResponse=error-once");

    const card = page.locator('[data-structured-kind="tool-input"]');
    await card.getByRole("radio", { name: "A · current package", exact: true }).click();
    const secret = card.getByLabel("Temporary verification code", { exact: true });
    await secret.fill("temporary-code");
    await card.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("could not send structured response");
    await expect(secret).toHaveValue("temporary-code");
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Response sent." })).toBeVisible();
});

test("already-resolved stays truthful for 2000ms, unlocks composer, and restores focus after removal", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-form&structuredResponse=already-resolved", { motion: "no-preference" });
    await page.evaluate(() => {
        const lifecycle: { shownAt: number | null; removedAt: number | null } = { shownAt: null, removedAt: null };
        (window as typeof window & { __structuredExpiredLifecycle?: typeof lifecycle }).__structuredExpiredLifecycle = lifecycle;
        const observer = new MutationObserver(() => {
            const card = document.querySelector('[data-structured-response-state="expired"]');
            if (card && lifecycle.shownAt === null) lifecycle.shownAt = performance.now();
            if (!document.querySelector("[data-structured-input-card]") && lifecycle.shownAt !== null && lifecycle.removedAt === null) {
                lifecycle.removedAt = performance.now();
                observer.disconnect();
            }
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ["data-structured-response-state"] });
    });

    const card = page.locator('[data-structured-kind="mcp-form"]');
    await card.getByRole("radio", { name: "No", exact: true }).click();
    await card.getByRole("checkbox", { name: "Web", exact: true }).check();
    const submit = card.getByRole("button", { name: "Submit", exact: true });
    await submit.click();

    const status = card.getByRole("status").filter({ hasText: "Request is already closed in Codex. Response was not sent." });
    await expect(card).toHaveAttribute("data-structured-response-state", "expired");
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toHaveAttribute("data-min-visible-ms", "2000");
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Response sent." })).toHaveCount(0);
    const composer = page.getByPlaceholder("Message the agent…");
    await expect(composer).toBeEnabled();
    await expect(card).toHaveCount(0, { timeout: 3_500 });
    await expect(composer).toBeFocused();

    const visibleMs = await page.evaluate(() => {
        const lifecycle = (window as typeof window & { __structuredExpiredLifecycle: { shownAt: number; removedAt: number } }).__structuredExpiredLifecycle;
        return lifecycle.removedAt - lifecycle.shownAt;
    });
    expect(visibleMs).toBeGreaterThanOrEqual(1_950);
});

test("MCP URL opens a blank popup synchronously, navigates it after RPC, and uses structured resolution", async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on("console", (message) => consoleMessages.push(message.text()));
    await openStructuredFixture(page, "structured=mcp-url", { urlOpenResult: "opened" });

    const card = page.locator('[data-structured-kind="mcp-url"]');
    const open = card.getByRole("button", { name: "Open secure link", exact: true });
    const accept = card.getByRole("button", { name: "Accept", exact: true });
    await expect(card).toContainText("https://docs.example.com/remcli/approval");
    await expect(page.locator("body")).not.toContainText("fixture-raw-secret");
    await expect(page.locator("body")).not.toContainText("CodexMcpElicitation");
    await expect(accept).toBeDisabled();
    expect(await page.evaluate(() => (window as typeof window & { __structuredWindowState: { openCalls: unknown[] } }).__structuredWindowState.openCalls.length)).toBe(0);

    await open.click();
    await expect(card.locator('[data-mcp-url-open-state="opened"]')).toHaveText("Link opened in a new tab.");
    await expect(card.locator('[data-mcp-url-open-state="opened"]')).toHaveAttribute("aria-live", "polite");
    await expect(accept).toBeEnabled();
    const state = await page.evaluate(() => {
        const value = (window as typeof window & { __structuredWindowState: { openCalls: unknown[]; navigated: string[]; popup: { opener: unknown } } }).__structuredWindowState;
        return { openCalls: value.openCalls, navigated: value.navigated, opener: value.popup.opener };
    });
    expect(state).toEqual({
        openCalls: [{ url: "about:blank", target: "_blank" }],
        navigated: ["https://docs.example.com/remcli/approval?token=fixture-raw-secret#authorize"],
        opener: null,
    });
    expect(await page.content()).not.toContain("fixture-raw-secret");
    expect(consoleMessages.join("\n")).not.toContain("fixture-raw-secret");

    await accept.click();
    await expect(card).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Response sent." })).toBeVisible();
    await assertNoHorizontalOverflow(page);
});

test("MCP URL reports a blocked blank popup without fetching or navigating the raw URL", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-url", { urlOpenResult: "blocked" });

    const card = page.locator('[data-structured-kind="mcp-url"]');
    await card.getByRole("button", { name: "Open secure link", exact: true }).click();
    const blocked = card.locator('[data-mcp-url-open-state="popup-blocked"]');
    await expect(blocked).toHaveText("The browser blocked the new tab. Allow popups and try again.");
    await expect(blocked).toHaveAttribute("role", "alert");
    await expect(blocked).toHaveAttribute("aria-live", "assertive");
    await expect(card.getByRole("button", { name: "Retry opening link", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
    const state = await page.evaluate(() => (window as typeof window & { __structuredWindowState: { openCalls: unknown[]; navigated: string[] } }).__structuredWindowState);
    expect(state.openCalls).toEqual([{ url: "about:blank", target: "_blank" }]);
    expect(state.navigated).toEqual([]);
    expect(await page.content()).not.toContain("fixture-raw-secret");
    await assertBlockingComposer(page);
    await assertNoHorizontalOverflow(page);
});

test("stale MCP URL decision uses structured RPC and shows truthful expired feedback", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-url&structuredResponse=already-resolved", { urlOpenResult: "opened" });

    const card = page.locator('[data-structured-kind="mcp-url"]');
    await card.getByRole("button", { name: "Open secure link", exact: true }).click();
    await expect(card.locator('[data-mcp-url-open-state="opened"]')).toBeVisible();
    await card.getByRole("button", { name: "Accept", exact: true }).click();

    const status = card.getByRole("status").filter({ hasText: "Request is already closed in Codex. Response was not sent." });
    await expect(card).toHaveAttribute("data-structured-response-state", "expired");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Response sent." })).toHaveCount(0);
    await expect(page.getByPlaceholder("Message the agent…")).toBeEnabled();
    await expect(card).toHaveCount(0, { timeout: 3_500 });
    await expect(page.locator("body")).not.toContainText("CodexMcpElicitation");
});

test("already-resolved does not steal focus moved outside the expiring card", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-form&structuredResponse=already-resolved");

    const card = page.locator('[data-structured-kind="mcp-form"]');
    await card.getByRole("radio", { name: "No", exact: true }).click();
    await card.getByRole("checkbox", { name: "Web", exact: true }).check();
    await card.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(card).toHaveAttribute("data-structured-response-state", "expired");

    const menu = page.getByRole("button", { name: "Menu", exact: true });
    await menu.focus();
    await expect(menu).toBeFocused();
    await expect(card).toHaveCount(0, { timeout: 3_500 });
    await expect(menu).toBeFocused();
});

for (const failureMode of ["error", "unsafe"] as const) {
    test(`MCP URL closes its blank popup after ${failureMode} URL resolution`, async ({ page }) => {
        await openStructuredFixture(page, `structured=mcp-url&structuredUrl=${failureMode}`, { urlOpenResult: "opened" });

        const card = page.locator('[data-structured-kind="mcp-url"]');
        await card.getByRole("button", { name: "Open secure link", exact: true }).click();
        await expect(card.locator('[data-mcp-url-open-state="error"]')).toHaveText("The secure link could not be opened. Try again.");
        await expect(card.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
        const state = await page.evaluate(() => (window as typeof window & { __structuredWindowState: { openCalls: unknown[]; navigated: string[]; closed: number } }).__structuredWindowState);
        expect(state.openCalls).toEqual([{ url: "about:blank", target: "_blank" }]);
        expect(state.navigated).toEqual([]);
        expect(state.closed).toBe(1);
        expect(await page.content()).not.toContain("user:secret");
    });
}

test("authoritative structured state renders again after a reconnect-style page refresh", async ({ page }) => {
    await openStructuredFixture(page, "structured=mcp-form");
    await expect(page.locator('[data-structured-kind="mcp-form"]')).toHaveCount(1);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-structured-kind="mcp-form"]')).toHaveCount(1);
    await expect(page.locator('[data-structured-field="dryRun"] [data-boolean-state]')).toHaveText("Not selected");
    await assertBlockingComposer(page);
    await assertNoHorizontalOverflow(page);
});
