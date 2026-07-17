import { expect, test, type ConsoleMessage, type Locator, type Page, type TestInfo } from "@playwright/test";

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

interface ChatHeaderReport {
    clientWidth: number;
    scrollWidth: number;
    metadataWidth: number;
    statusHeight: number;
}

const FIXTURE_ROUTES: FixtureRoute[] = [
    { name: "home", path: "/?fixtures=1" },
    { name: "new-session", path: "/new?fixtures=1" },
    { name: "chat", path: "/session/fx-chat?fixtures=1" },
    { name: "terminal", path: "/session/fx-running/terminal?fixtures=1" },
    { name: "zen", path: "/zen?fixtures=1" },
    { name: "settings", path: "/settings?fixtures=1" },
    { name: "concierge", path: "/concierge?fixtures=1" },
    { name: "connect", path: "/connect?fixtures=1" },
];

const MOBILE_TOUCH_TARGET_MIN_PX = 44;
const BOTTOM_SAFE_AREA_PX = 96;
const CHAT_HEADER_METADATA_MIN_WIDTH_PX = 200;
const CHAT_HEADER_STATUS_MAX_HEIGHT_PX = 20;
const CLAUDE_PERMISSION_LABELS = ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
const CODEX_PERMISSION_LABELS = ["read-only", "workspace-write", "danger-full-access"] as const;

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

async function openFixtureRoute(page: Page, path: string, theme: "dark" | "light" = "dark"): Promise<void> {
    await page.addInitScript((selectedTheme: "dark" | "light") => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", selectedTheme);
    }, theme);
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);
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

async function assertChatHeaderHasSpace(page: Page, minimumMetadataWidth = CHAT_HEADER_METADATA_MIN_WIDTH_PX): Promise<void> {
    const report = await page.locator("header").evaluate<ChatHeaderReport>((header) => {
        const metadata = header.querySelector<HTMLElement>(":scope > div.flex.min-w-0.flex-1.flex-col");
        const status = metadata?.querySelector<HTMLElement>("span:last-child");

        return {
            clientWidth: header.clientWidth,
            scrollWidth: header.scrollWidth,
            metadataWidth: metadata?.getBoundingClientRect().width ?? 0,
            statusHeight: status?.getBoundingClientRect().height ?? 0,
        };
    });

    expect(report.scrollWidth, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(report.clientWidth + 1);
    expect(report.metadataWidth, JSON.stringify(report, null, 2)).toBeGreaterThanOrEqual(minimumMetadataWidth);
    expect(report.statusHeight, JSON.stringify(report, null, 2)).toBeLessThanOrEqual(CHAT_HEADER_STATUS_MAX_HEIGHT_PX);
}

async function assertPermissionLabelsAreFullyVisible(scope: Locator, labels: readonly string[]): Promise<void> {
    const reports = await Promise.all(labels.map(async (label) => {
        const button = scope.getByRole("button", { name: label, exact: true });
        await expect(button).toBeVisible();

        const labelElement = button.locator("span").first();
        const metrics = await labelElement.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
        }));

        return { label, ...metrics };
    }));

    for (const report of reports) {
        expect(report.clientWidth, JSON.stringify(report)).toBeGreaterThan(0);
        expect(report.scrollWidth, JSON.stringify(report)).toBeLessThanOrEqual(report.clientWidth + 1);
    }
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

async function assertRequiredViewport(page: Page, testInfo: TestInfo): Promise<void> {
    const expectedViewport = isMobileProject(testInfo)
        ? { width: 390, height: 844 }
        : { width: 1280, height: 800 };

    expect(page.viewportSize()).toEqual(expectedViewport);
}

async function assertChatMessageContentDoesNotOverflow(page: Page): Promise<void> {
    const overflow = await page.locator("main").evaluate((main) => {
        const candidates = Array.from(main.querySelectorAll<HTMLElement>(":scope > div > div, pre, code, a"));

        return candidates
            .filter((element) => {
                const style = window.getComputedStyle(element);
                return style.display !== "none" && element.clientWidth > 0 && element.clientHeight > 0;
            })
            .map((element) => ({
                tag: element.tagName.toLowerCase(),
                text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
            }))
            .filter((element) => element.scrollWidth > element.clientWidth + 1);
    });

    expect(overflow, JSON.stringify(overflow, null, 2)).toEqual([]);
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

test("command palette opens above the current fixture route without layout regressions", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/?fixtures=1");
    await page.getByRole("button", { name: "Search (⌘K)" }).click();

    const palette = page.getByRole("dialog");
    await expect(palette).toBeVisible();
    await expect(palette.getByPlaceholder("Search sessions and actions…")).toBeFocused();
    await expect(palette.getByText("sessions", { exact: true })).toBeVisible();
    await expect(palette.getByText("actions", { exact: true })).toBeVisible();
    await expect(palette.getByText(/webapp/i)).toBeVisible();
    await expect(palette.getByText("New session…", { exact: true })).toBeVisible();
    await expect(palette.getByText("Open settings", { exact: true })).toBeVisible();
    await expect(palette.getByText("Disconnect", { exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await page.keyboard.press("Meta+k");
    await expect(page.getByRole("dialog")).toBeVisible();

    expect(pageIssues).toEqual([]);
});

test("Connect fixture states preserve usable controls and labelled manual inputs", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), "Mobile connection-state regression.");
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/connect?fixtures=1&connectFixture=scanning");
    await expect(page.getByRole("button", { name: "Close scanner" })).toBeVisible();
    await assertMobileTouchTargets(page);
    await assertNoHorizontalOverflow(page);

    await openFixtureRoute(page, "/connect?fixtures=1&connectFixture=manual");
    await expect(page.getByRole("textbox", { name: "address:port" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "connection key" })).toBeVisible();
    await assertMobileTouchTargets(page);
    await assertNoHorizontalOverflow(page);

    await openFixtureRoute(page, "/connect?fixtures=1&connectFixture=error");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Scan again" })).toBeVisible();
    await assertMobileTouchTargets(page);
    await assertNoHorizontalOverflow(page);

    expect(pageIssues).toEqual([]);
});

test("connect fixture state cannot change the production connection flow", async ({ page }) => {
    const pageIssues = collectPageIssues(page);

    await page.addInitScript(() => {
        window.localStorage.removeItem("remcli-fixtures");
    });
    await page.goto("/connect?connectFixture=error", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("button", { name: "Scan QR code" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enter address manually" })).toBeVisible();
    await expect(page.getByText("Failed to connect", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "address:port" })).toHaveCount(0);

    expect(pageIssues).toEqual([]);
});

test("new session keeps its primary action fully visible", async ({ page }) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/new?fixtures=1");
    await assertPrimaryActionIsFullyVisible(page);
    await assertNoHorizontalOverflow(page);

    expect(pageIssues).toEqual([]);
});

test("Claude 1024 keeps metadata readable with a compact permission picker", async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), "Desktop breakpoint regression.");
    const pageIssues = collectPageIssues(page);

    await page.setViewportSize({ width: 1024, height: 800 });
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1");

    const header = page.locator("header");
    const picker = header.getByRole("button", { name: "manual", exact: true });
    await expect(picker).toHaveCount(1);
    await expect(picker).toBeVisible();
    for (const label of CLAUDE_PERMISSION_LABELS.slice(1)) {
        await expect(header.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    }
    await expect(header.getByRole("link", { name: /terminal/i })).toBeVisible();
    await assertChatHeaderHasSpace(page);

    await picker.click();
    const drawer = page.locator('[data-slot="drawer-content"]');
    await expect(drawer).toBeVisible();
    await assertPermissionLabelsAreFullyVisible(drawer, CLAUDE_PERMISSION_LABELS);

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("Codex 1280 keeps every desktop permission segment fully visible", async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), "Desktop breakpoint regression.");
    const pageIssues = collectPageIssues(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openFixtureRoute(page, "/session/fx-running?fixtures=1");

    await assertPermissionLabelsAreFullyVisible(page.locator("header"), CODEX_PERMISSION_LABELS);
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("typed execution outcome renders a visible error session card", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/?fixtures=1");
    const errorCard = page.getByRole("button", { name: /mobile error/i });

    await expect(errorCard).toBeVisible();
    await expect(errorCard).toHaveClass(/border-status-error/);
    await expect(errorCard).toContainText("error");
    await errorCard.click();
    await expect(page).toHaveURL(/\/session\/fx-error$/);
    await expect(page.locator("header")).toContainText("error");
    await expect(page.getByText("the last operation ended with an error", { exact: true })).toBeVisible();
    await assertChatHeaderHasSpace(page, isMobileProject(testInfo) ? 160 : CHAT_HEADER_METADATA_MIN_WIDTH_PX);

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

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

test("long Markdown paths, links, inline code, and fenced code stay within the chat", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1&chatFixture=long");

    const commonMarkLink = page.getByRole("link", { name: "CommonMark destination", exact: true });
    await expect(commonMarkLink).toBeVisible();
    const href = await commonMarkLink.getAttribute("href");
    expect(href).toContain("Function_(mathematics)");
    expect(href?.length).toBeGreaterThan(400);

    await expect(page.getByText(/calculate\.js:195/).last()).toBeVisible();
    await expect(page.locator("pre").last()).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertChatMessageContentDoesNotOverflow(page);

    expect(pageIssues).toEqual([]);
});

test("expanded tool output remains readable in the light theme", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await page.emulateMedia({ colorScheme: "light" });
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1", "light");
    const toolOutput = page.locator(".select-text").filter({ hasText: /src\/parser\.ts/i }).first();
    await expect(toolOutput).toBeVisible();

    const colors = await toolOutput.evaluate((element) => {
        const style = window.getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color };
    });
    expect(colors).toEqual({
        backgroundColor: "oklch(0.141 0.005 285.823)",
        color: "oklch(0.92 0.004 286.32)",
    });

    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("tool output can be expanded and collapsed with the keyboard", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1");

    const toolToggle = page.getByRole("button", { name: /Read src\/parser\.ts/i });
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    const outputId = await toolToggle.getAttribute("aria-controls");
    expect(outputId).toBeTruthy();

    await toolToggle.focus();
    await page.keyboard.press("Enter");
    await expect(toolToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[id="${outputId}"]`)).toContainText("export function parse");

    await page.keyboard.press("Space");
    await expect(toolToggle).toHaveAttribute("aria-expanded", "false");
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("Zen keeps a linked session compact on mobile", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), "Mobile overflow regression.");
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/zen?fixtures=1");
    const linkedSession = page.getByRole("button", { name: /webapp.*codex/i });
    const sessionPath = linkedSession.locator("span.min-w-0.truncate");
    await sessionPath.evaluate((element) => {
        element.textContent = `/remote/${"nested-directory/".repeat(42)}session`;
    });

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("resume history keeps loading and error visible, retries, and reaches the final long row internally", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/new?fixtures=1&resumeFixture=retry-long");
    await page.getByRole("button", { name: /codex cli/i }).click();
    await page.getByRole("button", { name: /resume a previous codex session/i }).click();

    const resumeRegion = page.getByRole("region", { name: "Resume session", exact: true });
    await expect(resumeRegion).toHaveAttribute("aria-busy", "true");
    await expect(resumeRegion.getByRole("status")).toContainText("loading sessions");
    await expect(resumeRegion.getByRole("alert")).toContainText("Fixture resume list rejected");
    await expect(resumeRegion).toHaveAttribute("aria-busy", "false");

    await resumeRegion.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(resumeRegion).toHaveAttribute("aria-busy", "true");
    await expect(resumeRegion.getByRole("status")).toContainText("loading sessions");

    const lastRow = resumeRegion.getByRole("button", { name: /Long resume session 24/i });
    await expect(lastRow).toBeAttached();
    const scrollMetrics = await resumeRegion.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
    }));
    expect(scrollMetrics.scrollHeight, JSON.stringify(scrollMetrics)).toBeGreaterThan(scrollMetrics.clientHeight);

    await resumeRegion.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastRowPosition = await lastRow.evaluate((element) => {
        const region = element.closest<HTMLElement>("[role='region']");
        const rowRect = element.getBoundingClientRect();
        const regionRect = region?.getBoundingClientRect();
        return {
            rowTop: rowRect.top,
            rowBottom: rowRect.bottom,
            regionTop: regionRect?.top ?? 0,
            regionBottom: regionRect?.bottom ?? 0,
        };
    });
    expect(lastRowPosition.rowTop, JSON.stringify(lastRowPosition)).toBeGreaterThanOrEqual(lastRowPosition.regionTop - 1);
    expect(lastRowPosition.rowBottom, JSON.stringify(lastRowPosition)).toBeLessThanOrEqual(lastRowPosition.regionBottom + 1);

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    expect(pageIssues).toEqual([]);
});

test("directory keeps its content region stable and reduces motion to the design token", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixtureRoute(page, "/new?fixtures=1");
    await page.getByRole("button", { name: /choose directory/i }).click();

    const drawer = page.locator('[data-slot="drawer-content"]');
    const directoryRegion = drawer.getByRole("region", { name: "Choose directory", exact: true });
    await expect(directoryRegion.getByRole("button", { name: "packages", exact: true })).toBeVisible();
    const initialHeight = await directoryRegion.evaluate((element) => element.getBoundingClientRect().height);

    expect(await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const reducedMotion = await drawer.evaluate((element) => {
        const drawerStyle = window.getComputedStyle(element);
        const overlayStyle = window.getComputedStyle(document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]')!);
        const region = element.querySelector<HTMLElement>('[role="region"]')!;
        const regionStyle = window.getComputedStyle(region);
        return {
            drawerDuration: drawerStyle.animationDuration,
            overlayDuration: overlayStyle.animationDuration,
            regionDuration: regionStyle.transitionDuration,
            regionProperty: regionStyle.transitionProperty,
        };
    });
    expect(reducedMotion).toEqual({
        drawerDuration: "0.12s",
        overlayDuration: "0.12s",
        regionDuration: "0.12s",
        regionProperty: "opacity, transform",
    });

    await directoryRegion.getByRole("button", { name: "packages", exact: true }).click();
    await expect(directoryRegion.getByRole("button", { name: "remcli-web", exact: true })).toBeVisible();
    const nextHeight = await directoryRegion.evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(nextHeight - initialHeight)).toBeLessThanOrEqual(1);

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("directory drawer follows the design-system motion tokens", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openFixtureRoute(page, "/new?fixtures=1");
    await page.getByRole("button", { name: /choose directory/i }).click();

    const drawer = page.locator('[data-slot="drawer-content"]');
    const overlay = page.locator('[data-slot="drawer-overlay"]');
    await expect(drawer).toBeVisible();
    await expect(overlay).toBeVisible();

    const motion = await drawer.evaluate((element) => {
        const drawerStyle = window.getComputedStyle(element);
        const overlayElement = document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]');
        const overlayStyle = overlayElement ? window.getComputedStyle(overlayElement) : null;
        return {
            drawerDuration: drawerStyle.animationDuration,
            drawerTiming: drawerStyle.animationTimingFunction,
            overlayDuration: overlayStyle?.animationDuration ?? null,
            overlayTiming: overlayStyle?.animationTimingFunction ?? null,
        };
    });

    expect(motion).toEqual({
        drawerDuration: "0.32s",
        drawerTiming: "cubic-bezier(0.32, 0.72, 0, 1)",
        overlayDuration: "0.2s",
        overlayTiming: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
    expect(pageIssues).toEqual([]);
});
