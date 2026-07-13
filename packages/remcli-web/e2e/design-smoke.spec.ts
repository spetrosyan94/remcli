import { expect, test, type ConsoleMessage, type Page, type TestInfo } from "@playwright/test";

interface FixtureRoute {
    name: string;
    path: string;
}

interface PageIssue {
    source: "console" | "pageerror" | "response";
    type: string;
    text: string;
}

interface ElementReport {
    selector: string;
    text: string;
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
}

interface OverflowReport {
    viewportWidth: number;
    scrollWidth: number;
    offenders: ElementReport[];
}

const FIXTURE_ROUTES: FixtureRoute[] = [
    { name: "home", path: "/?fixtures=1" },
    { name: "new-session", path: "/new?fixtures=1" },
    { name: "chat", path: "/session/fx-chat?fixtures=1" },
    { name: "settings", path: "/settings?fixtures=1" },
    { name: "concierge", path: "/concierge?fixtures=1" },
];

const MOBILE_TOUCH_TARGET_MIN_PX = 44;
const BOTTOM_SAFE_AREA_PX = 96;

function collectPageIssues(page: Page): PageIssue[] {
    const issues: PageIssue[] = [];
    page.on("console", (message: ConsoleMessage) => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        issues.push({
            source: "console",
            type: message.type(),
            text: message.text(),
        });
    });
    page.on("pageerror", (error) => {
        issues.push({
            source: "pageerror",
            type: error.name,
            text: error.message,
        });
    });
    page.on("response", (response) => {
        if (response.status() < 400) return;
        issues.push({
            source: "response",
            type: String(response.status()),
            text: response.url(),
        });
    });
    return issues;
}

async function openFixtureRoute(page: Page, path: string): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const report = await page.evaluate<OverflowReport>(() => {
        function describeElement(element: Element): string {
            const tag = element.tagName.toLowerCase();
            const id = element.id ? `#${element.id}` : "";
            const classes = typeof element.className === "string"
                ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 4).map((name) => `.${name}`).join("")
                : "";
            return `${tag}${id}${classes}`;
        }

        function isVisibleElement(element: HTMLElement): boolean {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 1 &&
                rect.height > 1 &&
                rect.bottom >= 0 &&
                rect.top <= window.innerHeight
            );
        }

        const viewportWidth = document.documentElement.clientWidth;
        const scrollWidth = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
        const offenders = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
            .filter(isVisibleElement)
            .map((element): ElementReport => {
                const rect = element.getBoundingClientRect();
                return {
                    selector: describeElement(element),
                    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
                    width: Math.round(rect.width * 100) / 100,
                    height: Math.round(rect.height * 100) / 100,
                    left: Math.round(rect.left * 100) / 100,
                    right: Math.round(rect.right * 100) / 100,
                    top: Math.round(rect.top * 100) / 100,
                    bottom: Math.round(rect.bottom * 100) / 100,
                };
            })
            .filter((item) => item.left < -1 || item.right > viewportWidth + 1)
            .slice(0, 10);

        return { viewportWidth, scrollWidth, offenders };
    });

    expect(report.scrollWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.viewportWidth + 1);
    expect(report.offenders, JSON.stringify(report.offenders, null, 2)).toEqual([]);
}

async function assertNoBottomToastOverlap(page: Page): Promise<void> {
    const overlappingToasts = await page.evaluate<ElementReport[]>((bottomSafeAreaPx: number) => {
        function describeElement(element: Element): string {
            const tag = element.tagName.toLowerCase();
            const dataTitle = element.getAttribute("data-title") ? `[data-title="${element.getAttribute("data-title")}"]` : "";
            return `${tag}${dataTitle}`;
        }

        return Array.from(document.querySelectorAll<HTMLElement>("[data-sonner-toast]"))
            .filter((element) => {
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
            })
            .map((element): ElementReport => {
                const rect = element.getBoundingClientRect();
                return {
                    selector: describeElement(element),
                    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
                    width: Math.round(rect.width * 100) / 100,
                    height: Math.round(rect.height * 100) / 100,
                    left: Math.round(rect.left * 100) / 100,
                    right: Math.round(rect.right * 100) / 100,
                    top: Math.round(rect.top * 100) / 100,
                    bottom: Math.round(rect.bottom * 100) / 100,
                };
            })
            .filter((toast) => toast.bottom > window.innerHeight - bottomSafeAreaPx);
    }, BOTTOM_SAFE_AREA_PX);

    expect(overlappingToasts, JSON.stringify(overlappingToasts, null, 2)).toEqual([]);
}

async function assertMobileTouchTargets(page: Page): Promise<void> {
    const violations = await page.evaluate<ElementReport[]>((minimumSizePx: number) => {
        function describeElement(element: Element): string {
            const tag = element.tagName.toLowerCase();
            const aria = element.getAttribute("aria-label");
            const role = element.getAttribute("role");
            const id = element.id ? `#${element.id}` : "";
            return `${tag}${id}${role ? `[role="${role}"]` : ""}${aria ? `[aria-label="${aria}"]` : ""}`;
        }

        function isInteractive(element: HTMLElement): boolean {
            if (element.matches(":disabled,[aria-disabled='true'],[aria-hidden='true']")) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                style.pointerEvents !== "none" &&
                rect.width > 1 &&
                rect.height > 1 &&
                rect.bottom >= 0 &&
                rect.top <= window.innerHeight &&
                rect.right >= 0 &&
                rect.left <= window.innerWidth
            );
        }

        const selector = [
            "button",
            "a[href]",
            "input:not([type='hidden'])",
            "textarea",
            "select",
            "[role='button']",
            "[role='switch']",
            "[role='menuitem']",
            "[tabindex]:not([tabindex='-1'])",
        ].join(",");

        return Array.from(document.querySelectorAll<HTMLElement>(selector))
            .filter(isInteractive)
            .map((element): ElementReport => {
                const rect = element.getBoundingClientRect();
                return {
                    selector: describeElement(element),
                    text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
                    width: Math.round(rect.width * 100) / 100,
                    height: Math.round(rect.height * 100) / 100,
                    left: Math.round(rect.left * 100) / 100,
                    right: Math.round(rect.right * 100) / 100,
                    top: Math.round(rect.top * 100) / 100,
                    bottom: Math.round(rect.bottom * 100) / 100,
                };
            })
            .filter((item) => item.width < minimumSizePx || item.height < minimumSizePx)
            .slice(0, 20);
    }, MOBILE_TOUCH_TARGET_MIN_PX);

    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
}

async function assertPrimaryActionIsFullyVisible(page: Page): Promise<void> {
    const primaryAction = page.getByRole("button", { name: /^start claude in /i });
    await expect(primaryAction).toBeVisible();

    const report = await primaryAction.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            viewportHeight: window.innerHeight,
        };
    });

    expect(report.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
    expect(report.top, JSON.stringify(report)).toBeGreaterThanOrEqual(0);
    expect(report.bottom, JSON.stringify(report)).toBeLessThanOrEqual(report.viewportHeight);
}

function isMobileProject(testInfo: TestInfo): boolean {
    return testInfo.project.name.includes("mobile");
}

for (const route of FIXTURE_ROUTES) {
    test(`${route.name} fixture route keeps layout invariants`, async ({ page }) => {
        const pageIssues = collectPageIssues(page);

        await openFixtureRoute(page, route.path);
        await assertNoHorizontalOverflow(page);
        await assertNoBottomToastOverlap(page);

        expect(pageIssues).toEqual([]);
    });

    test(`${route.name} mobile touch targets are practical`, async ({ page }, testInfo) => {
        test.skip(!isMobileProject(testInfo), "Mobile touch-target gate only runs on the mobile project.");
        const pageIssues = collectPageIssues(page);

        await openFixtureRoute(page, route.path);
        await assertMobileTouchTargets(page);

        expect(pageIssues).toEqual([]);
    });
}

test("new session keeps its primary action fully visible", async ({ page }) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/new?fixtures=1");
    await assertPrimaryActionIsFullyVisible(page);
    await assertNoHorizontalOverflow(page);

    expect(pageIssues).toEqual([]);
});

test("triggered toast stays out of bottom chrome", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/?fixtures=1");
    const stopButton = page.getByRole("button", { name: /stop session/i }).first();
    if (await stopButton.count() === 0) {
        test.skip(true, "Fixture home route has no visible stop-session control to trigger a toast.");
    }

    await stopButton.hover();
    await stopButton.click();
    await page.getByRole("button", { name: /^stop$/i }).click();
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

    expect(pageIssues).toEqual([]);
});

test("daemon fixture chat stop and resume keeps seeded history visible", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/session/fx-chat?fixtures=1");
    await page.getByRole("button", { name: "Menu" }).click();

    await expect(page.getByRole("menuitem", { name: /terminal/i })).toBeVisible();
    const stopMenuItem = page.getByRole("menuitem", { name: /^stop$/i });
    await expect(stopMenuItem).toBeVisible();
    await stopMenuItem.click();

    await expect(page.getByRole("dialog", { name: "Stop this session?" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog", { name: "Stop this session?" })).toHaveCount(0);

    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("menuitem", { name: /^stop$/i }).click();
    await page.getByRole("button", { name: /^stop$/i }).click();
    await expect(page.getByText("session stopped")).toBeVisible();
    await expect(page.getByText("— session ended —")).toBeVisible();
    await expect(page.getByRole("button", { name: /resume/i })).toBeVisible();

    await Promise.all([
        page.waitForURL(/\/session\/fx-resume-claude-\d+$/),
        page.getByRole("button", { name: /resume/i }).click(),
    ]);
    await expect(page.getByText("Проверь тесты и почини баг с балансом скобок в parser.ts", { exact: true })).toBeVisible();
    await expect(page.getByText("Смотрю parser.ts и прогоняю линтер, чтобы найти место с дисбалансом скобок.", { exact: true })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

    expect(pageIssues).toEqual([]);
});

test("terminal fixture hides Stop across chat, Home, and sidebar", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/session/fx-running?fixtures=1");
    await page.getByRole("button", { name: "Menu" }).click();

    await expect(page.getByRole("menuitem", { name: /terminal/i })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^stop$/i })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openFixtureRoute(page, "/?fixtures=1");
    const terminalSessionRow = page.locator("button:visible").filter({ hasText: /webapp/i }).first().locator("..");
    await expect(terminalSessionRow).toBeVisible();
    await expect(terminalSessionRow.getByRole("button", { name: /stop session/i })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

    expect(pageIssues).toEqual([]);
});
