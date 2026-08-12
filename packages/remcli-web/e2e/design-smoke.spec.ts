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

async function readFixtureSpawnNewSessionCallCount(page: Page): Promise<number> {
    return page.evaluate(async () => {
        const { fixtureSpawnNewSessionCallCount } = await import("/src/lib/fixtures/index.ts");
        return fixtureSpawnNewSessionCallCount();
    });
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
    const primaryAction = page.getByRole("button", { name: /^start codex in /i });
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

test("pairing rekey closes its approval dialog before it presents the replacement QR", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/settings?fixtures=1");
    await page.evaluate(() => {
        const dialogCounts: number[] = [document.querySelectorAll('[role="dialog"]').length];
        const observer = new MutationObserver(() => {
            dialogCounts.push(document.querySelectorAll('[role="dialog"]').length);
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
        (globalThis as typeof globalThis & { rekeyDialogObserver?: MutationObserver; rekeyDialogCounts?: number[] }).rekeyDialogObserver = observer;
        (globalThis as typeof globalThis & { rekeyDialogObserver?: MutationObserver; rekeyDialogCounts?: number[] }).rekeyDialogCounts = dialogCounts;
    });

    await page.getByRole("button", { name: "Rotate pairing key", exact: true }).click();
    const approvalDialog = page.getByRole("dialog", { name: "Rotate pairing key", exact: true });
    const qrDialog = page.getByRole("dialog", { name: "Show connection QR", exact: true });

    await expect(approvalDialog).toBeVisible();
    await expect(approvalDialog).toContainText("remcli daemon rekey approve fixture-pairing-request-0001 F1A2B3C4");
    await expect(qrDialog).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(qrDialog).toBeVisible();
    await expect(approvalDialog).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1);

    const maximumDialogCount = await page.evaluate(() => {
        const state = globalThis as typeof globalThis & { rekeyDialogObserver?: MutationObserver; rekeyDialogCounts?: number[] };
        state.rekeyDialogObserver?.disconnect();
        return Math.max(...(state.rekeyDialogCounts ?? [0]));
    });
    expect(maximumDialogCount).toBeLessThanOrEqual(1);
    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }

    expect(pageIssues).toEqual([]);
});

test("dialog controls keep their full mobile hit area", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), "Dialog motion touch-target gate only runs on the mobile project.");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await openFixtureRoute(page, "/settings?fixtures=1");
    await page.getByRole("button", { name: "Rotate pairing key", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Rotate pairing key", exact: true });
    await expect(dialog).toBeVisible();

    const measureControls = async (scope: Locator) => scope.evaluate((element) => {
        const controls = [
            element.querySelector<HTMLElement>('[data-slot="dialog-close"]'),
            ...Array.from(element.querySelectorAll<HTMLElement>('[data-slot="dialog-footer"] button')),
        ];

        return controls.map((control) => {
            const rect = control?.getBoundingClientRect();
            return {
                width: rect?.width ?? 0,
                height: rect?.height ?? 0,
            };
        });
    });

    const assertFullHitAreas = (controls: Array<{ width: number; height: number }>) => {
        expect(controls).toHaveLength(2);
        for (const control of controls) {
            expect(control.width).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
            expect(control.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
        }
    };

    assertFullHitAreas(await measureControls(dialog));

    await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(dialog).toHaveCount(0);
});

test("Connect fixture states preserve usable controls and one labelled connection-link input", async ({ page }, testInfo) => {
    test.skip(!isMobileProject(testInfo), "Mobile connection-state regression.");
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/connect?fixtures=1&connectFixture=scanning");
    await expect(page.getByRole("button", { name: "Close scanner" })).toBeVisible();
    await assertMobileTouchTargets(page);
    await assertNoHorizontalOverflow(page);

    await openFixtureRoute(page, "/connect?fixtures=1&connectFixture=manual");
    await expect(page.getByRole("textbox", { name: "https://…/terminal/connect#…" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(1);
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
    await expect(page.getByRole("button", { name: "Paste connection link" })).toBeVisible();
    await expect(page.getByText("Failed to connect", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "https://…/terminal/connect#…" })).toHaveCount(0);

    expect(pageIssues).toEqual([]);
});

test("new session keeps its primary action fully visible", async ({ page }) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/new?fixtures=1");
    await assertPrimaryActionIsFullyVisible(page);
    await assertNoHorizontalOverflow(page);

    expect(pageIssues).toEqual([]);
});

test("disabled Jarvis renders the shared unavailable state instead of a blank chat", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/concierge?fixtures=1&conciergeStatus=disabled");

    const statusNotice = page.getByRole("status");
    await expect(statusNotice.getByText("concierge unavailable", { exact: true })).toBeVisible();
    await expect(statusNotice.getByText("enable conciergeEnabled in ~/.remcli/setup.json and start LM Studio", { exact: true })).toBeVisible();
    await expect(statusNotice.locator("svg[viewBox='0 0 32 32']")).toBeVisible();
    await expect(page.getByText("Fixture daemon is available", { exact: false })).toHaveCount(0);

    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) await assertMobileTouchTargets(page);
    expect(pageIssues).toEqual([]);
});

test("new session groups pinned projects and keeps their controls overflow-safe", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/new?fixtures=1");

    await expect(page.getByText("directory · projects", { exact: true })).toBeVisible();
    await expect(page.getByText("pinned", { exact: true })).toBeVisible();
    const projectRow = page.getByRole("button", { name: /~\/projects\/webapp.*Cursor.*feature\/mobile-nav/i });
    await expect(projectRow).toBeVisible();
    await expect(projectRow).not.toHaveAttribute("aria-current", "true");

    const pinButton = page.getByRole("button", { name: "Pin project", exact: true }).first();
    await expect(pinButton).toBeVisible();
    const pinBox = await pinButton.boundingBox();
    expect(pinBox?.width).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
    expect(pinBox?.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
    await pinButton.click();

    await expect(page.getByRole("button", { name: /~\/projects\/webapp.*Cursor.*feature\/mobile-nav/i })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpin project", exact: true })).toHaveCount(3);
    await projectRow.click();
    await expect(projectRow).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("button", { name: /Start codex in ~\/projects\/webapp/i })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("new session keeps deferred providers visible but non-interactive", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/new?fixtures=1");

    const codex = page.getByRole("button", { name: /codex cli/i });
    const cursor = page.getByRole("button", { name: /cursor agent/i });
    const claude = page.getByRole("button", { name: /claude code/i });
    const gemini = page.getByRole("button", { name: /gemini cli/i });

    await expect(codex).toHaveAttribute("aria-pressed", "true");
    await expect(claude).toBeDisabled();
    await expect(claude).toHaveAttribute("data-provider-availability", "deferred");
    await expect(claude).toHaveAttribute("aria-describedby", "deferred-provider-note");
    await expect(gemini).toBeDisabled();
    await expect(gemini).toHaveAttribute("data-provider-availability", "deferred");
    await expect(gemini).toHaveAttribute("aria-describedby", "deferred-provider-note");
    await expect(page.locator("#deferred-provider-note")).toHaveText("Claude and Gemini will be added in a separate integration.");

    await cursor.click();
    await expect(cursor).toHaveAttribute("aria-pressed", "true");
    await expect(claude).toBeDisabled();
    await expect(gemini).toBeDisabled();

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("Codex 1024 keeps metadata readable with a compact permission picker", async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), "Desktop breakpoint regression.");
    const pageIssues = collectPageIssues(page);

    await page.setViewportSize({ width: 1024, height: 800 });
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1");

    const header = page.locator("header");
    const picker = header.getByRole("button", { name: "access level: workspace-write", exact: true });
    await expect(picker).toHaveCount(1);
    await expect(picker).toBeVisible();
    for (const label of CODEX_PERMISSION_LABELS.slice(1)) {
        await expect(header.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    }
    await expect(header.getByRole("link", { name: /terminal/i })).toHaveCount(0);
    await assertChatHeaderHasSpace(page);

    await picker.click();
    const drawer = page.locator('[data-slot="drawer-content"]');
    await expect(drawer).toBeVisible();
    await assertPermissionLabelsAreFullyVisible(drawer, CODEX_PERMISSION_LABELS);

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("Codex 1280 keeps every desktop permission segment fully visible", async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), "Desktop breakpoint regression.");
    const pageIssues = collectPageIssues(page);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openFixtureRoute(page, "/session/fx-running?fixtures=1");

    const header = page.locator("header");
    await assertPermissionLabelsAreFullyVisible(header, CODEX_PERMISSION_LABELS);
    await expect(header.getByTitle(/^Session on Mac/)).toBeVisible();
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("chat stages Codex model and reasoning for the next message", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fx-chat?fixtures=1");

    const executionTrigger = page.getByRole("button", { name: /next message settings/i });
    await expect(executionTrigger).toBeVisible();
    await executionTrigger.click();

    const drawer = page.locator("#chat-next-message-drawer");
    await expect(drawer.getByRole("heading", { name: "Next message" })).toBeVisible();
    const terra = drawer.getByRole("radio", { name: "GPT-5.6-Terra", exact: true });
    await terra.click();
    await drawer.getByRole("radio", { name: "high", exact: true }).click();
    await drawer.getByRole("button", { name: "Apply to next message", exact: true }).click();

    await expect(executionTrigger).toContainText("GPT-5.6-Terra");
    await expect(executionTrigger).toContainText("next");

    const input = page.getByPlaceholder("Message the agent…");
    await input.fill("Continue with the selected model");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(executionTrigger).not.toContainText("next");

    await executionTrigger.click();
    await expect(drawer).toContainText("current: GPT-5.6-Terra · high");
    await page.keyboard.press("Escape");
    await expect(executionTrigger).toBeFocused();

    await executionTrigger.click();
    await drawer.getByRole("radio", { name: "GPT-5.6-Luna", exact: true }).click();
    await drawer.getByRole("radio", { name: "medium", exact: true }).click();
    await drawer.getByRole("button", { name: "Apply to next message", exact: true }).click();
    await input.fill("Continue again without a stale revision");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(executionTrigger).not.toContainText("next");
    await executionTrigger.click();
    await expect(drawer).toContainText("current: GPT-5.6-Luna · medium");
    await page.keyboard.press("Escape");

    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) await assertMobileTouchTargets(page);
    expect(pageIssues).toEqual([]);
});

test("typed execution outcome renders a visible error session card", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/?fixtures=1");
    await page.getByRole("button", { name: "Attention", exact: true }).first().click();
    const errorCard = page.getByRole("button", { name: /mobile error/i });

    await expect(errorCard).toBeVisible();
    await expect(errorCard).toHaveClass(/border-status-error/);
    await expect(errorCard).toContainText("error");
    await errorCard.click();
    await expect(page).toHaveURL(/\/session\/fx-error$/);
    await expect(page.locator("header")).toContainText("cursor");
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

test("daemon fixture Codex chat stop and resume keeps seeded history visible", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/session/fixture-codex-lifecycle-chat?fixtures=1&chatLifecycle=codex");
    await page.getByRole("button", { name: "Menu" }).click();

    await expect(page.getByRole("menuitem", { name: /terminal/i })).toHaveCount(0);
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
        page.waitForURL(/\/session\/fx-resume-codex-\d+$/),
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

test("Codex lifecycle fixture rejects incomplete or stale capability selections", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fixture-codex-lifecycle-chat?fixtures=1&chatLifecycle=codex");

    const rejectedResults = await page.evaluate(async () => {
        const { fixtureSpawnNewSession } = await import("/src/lib/fixtures/index.ts");
        const baseOptions = {
            machineId: "fx-machine-online",
            directory: "/Users/dev/projects/remcli",
            agent: "codex",
            permissionMode: "workspace-write",
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                catalogVersion: "fixture-codex-v1",
            },
        } as const;
        const invalidOptions = [
            { ...baseOptions, codexExecution: undefined },
            { ...baseOptions, permissionMode: undefined },
            {
                ...baseOptions,
                codexExecution: { ...baseOptions.codexExecution, catalogVersion: "fixture-codex-stale-v0" },
            },
            {
                ...baseOptions,
                codexExecution: { ...baseOptions.codexExecution, model: "gpt-5.6-unknown" },
            },
            {
                ...baseOptions,
                codexExecution: { ...baseOptions.codexExecution, reasoningEffort: undefined },
            },
            { ...baseOptions, permissionMode: "manual" },
        ];

        return await Promise.all(invalidOptions.map((options) => fixtureSpawnNewSession(options)));
    });

    expect(rejectedResults).toEqual(Array.from({ length: 6 }, () => ({
        type: "error",
        errorMessage: "Codex capability selection rejected: unsupported_selection.",
    })));
    expect(pageIssues).toEqual([]);
});

test("terminal-origin fixture hides Stop across chat, Home, and sidebar", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await openFixtureRoute(page, "/session/fx-running?fixtures=1");
    await page.getByRole("button", { name: "Menu" }).click();

    await expect(page.getByRole("menuitem", { name: /terminal/i })).toHaveCount(0);
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

test("terminal handoff reports the session platform and returns to chat", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fx-running/terminal?fixtures=1");

    await expect(page.getByText("Session on Mac", { exact: true })).toBeVisible();
    await expect(page.getByText("Continue in chat", { exact: true })).toBeVisible();
    await expect(page.getByText("Terminal is only available on the host", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "To chat", exact: true }).click();
    await expect(page).toHaveURL(/\/session\/fx-running(?:\?|$)/);

    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("terminal handoff never claims a terminal for unavailable or missing sessions", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fx-host-unavailable/terminal?fixtures=1");
    await expect(page.getByText("Computer is unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("Session on Linux", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "To chat", exact: true })).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "To chat", exact: true }).click();
    await expect(page).toHaveURL(/\/session\/fx-host-unavailable(?:\?|$)/);

    await openFixtureRoute(page, "/session/fx-offline/terminal?fixtures=1");
    await expect(page.getByText("Session is not active", { exact: true })).toBeVisible();
    await expect(page.getByText(/Session on /)).toHaveCount(0);

    await openFixtureRoute(page, "/session/does-not-exist/terminal?fixtures=1");
    await expect(page.locator("main").getByText("session not found", { exact: true })).toBeVisible();
    await expect(page.getByText(/Session on /)).toHaveCount(0);
    await page.getByRole("button", { name: "Back to list", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);

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

test("Zen adds a task through an explicit touch control and keeps keyboard submit", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/zen?fixtures=1");

    const input = page.getByRole("textbox", { name: "new task…", exact: true });
    const submit = page.getByRole("button", { name: "Add task", exact: true });
    await expect(submit).toBeDisabled();

    await input.fill("Review the terminal handoff copy");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText("Review the terminal handoff copy", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(submit).toBeDisabled();

    await input.fill("Keep Enter as a shortcut");
    await input.press("Enter");
    await expect(page.getByText("Keep Enter as a shortcut", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");

    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) await assertMobileTouchTargets(page);
    expect(pageIssues).toEqual([]);
});

test("Zen confirms deletion, preserves the linked session, and restores focus", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/zen?fixtures=1");

    const firstTask = page.getByText("Показать латентность в пилюле соединения", { exact: true });
    const firstTaskToggle = page.getByRole("button", { name: /toggle task: Показать латентность/i });
    const firstTrigger = page.getByRole("button", { name: /Actions for Показать латентность/i });
    await expect(firstTaskToggle).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(() => {
        let didObserveOverlap = false;
        const observer = new MutationObserver(() => {
            didObserveOverlap ||= Boolean(document.querySelector('[role="menu"]') && document.querySelector('[role="dialog"]'));
        });
        observer.observe(document.body, { attributes: true, childList: true, subtree: true });
        (window as Window & { remcliZenMenuDialogOverlap?: () => boolean }).remcliZenMenuDialogOverlap = () => didObserveOverlap;
    });
    await firstTrigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Delete task?", exact: true });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { remcliZenMenuDialogOverlap?: () => boolean }).remcliZenMenuDialogOverlap?.())).toBe(false);
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(firstTrigger).toBeFocused();
    await expect(firstTask).toBeVisible();

    await firstTrigger.click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(firstTask).toHaveCount(0);
    await expect(page.getByText("1 open", { exact: true })).toBeVisible();
    const nextTrigger = page.getByRole("button", { name: /Actions for Показать ошибку выполнения/i });
    await expect(nextTrigger).toBeFocused();

    const linkedSession = page.locator("button:visible").filter({ hasText: /webapp/i }).first();
    if (isMobileProject(testInfo)) {
        await page.getByRole("link", { name: "Sessions", exact: true }).click();
        await expect(linkedSession).toBeVisible();
        await page.getByRole("link", { name: "Tasks", exact: true }).click();
    } else {
        await page.evaluate(() => {
            window.history.pushState(null, "", "/session/fx-running?fixtures=1");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(page).toHaveURL(/\/session\/fx-running/);
        await expect(page.getByText("webapp", { exact: true }).first()).toBeVisible();
        await page.evaluate(() => {
            window.history.pushState(null, "", "/zen?fixtures=1");
            window.dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(page).toHaveURL(/\/zen/);
    }
    await expect(firstTask).toHaveCount(0);

    const longTitle = "continuous-path-segment-".repeat(24);
    await page.getByText("Показать ошибку выполнения в связанной сессии", { exact: true }).evaluate((element, value) => {
        element.textContent = value;
    }, longTitle);
    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) await assertMobileTouchTargets(page);
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
    await expect(resumeRegion).toBeFocused();
    await expect(resumeRegion.getByRole("status")).toContainText("loading sessions");
    await expect(resumeRegion.getByRole("alert")).toContainText("Fixture resume list rejected");
    await expect(resumeRegion).toHaveAttribute("aria-busy", "false");

    await resumeRegion.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(resumeRegion).toHaveAttribute("aria-busy", "true");
    await expect(resumeRegion.getByRole("status")).toContainText("loading sessions");

    const lastRow = resumeRegion.getByRole("button", { name: /Long resume session 20/i });
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

test("Cursor native resume keeps its binding error and retry inside the same sheet", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/new?fixtures=1&resumeFixture=cursor-lifecycle");
    await page.getByRole("button", { name: /cursor agent/i }).click();
    await page.getByRole("button", { name: /resume a previous cursor session/i }).click();

    const resumeRegion = page.getByRole("region", { name: "Resume session", exact: true });
    const lifecycleSession = resumeRegion.getByRole("button", { name: /^Cursor lifecycle review/ });
    await expect(lifecycleSession).toBeVisible();
    await lifecycleSession.click();

    await expect(resumeRegion.getByRole("alert")).toContainText("Cursor could not bind this native session");
    await expect(resumeRegion.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(resumeRegion).toHaveAttribute("aria-busy", "false");

    await resumeRegion.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(resumeRegion).toHaveAttribute("aria-busy", "true");
    await page.waitForURL(/\/session\/fx-resume-cursor-/);
    await expect(page.locator("header")).toContainText("cursor");

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("ended Cursor Chat Resume uses a non-URL typed New Session handoff", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fixture-cursor-ended-chat?fixtures=1&chatResume=cursor");
    await page.getByRole("button", { name: /Resume$/ }).click();

    await page.waitForURL(/\/new$/);
    expect(new URL(page.url()).search).toBe("");
    await expect(page.getByText("Cursor chat resume", { exact: true })).toBeVisible();
    await expect(page.getByText("fixture-cursor-chat-native", { exact: true })).toHaveCount(0);

    const resumeButton = page.getByRole("button", { name: /Resume session.*Cursor chat resume/i });
    await expect(resumeButton).toBeEnabled();
    await resumeButton.click();
    await page.waitForURL(/\/session\/fx-resume-cursor-/);

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("ended deferred Chat Resume stays visible and does not spawn", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, "/session/fixture-deferred-ended-chat?fixtures=1&chatResume=deferred");

    const resumeButton = page.getByRole("button", { name: /Resume$/ });
    await expect(resumeButton).toBeVisible();
    await expect(resumeButton).toBeDisabled();
    await expect(resumeButton).toHaveAttribute("data-resume-availability", "deferred");
    await expect(resumeButton).toHaveAttribute("aria-describedby", "chat-deferred-resume-note");
    await expect(page.getByText("Продолжи deferred-сессию без запуска нового провайдера.", { exact: true })).toBeVisible();
    await expect(page.getByText("История сохранена. Resume отключён, поэтому этот чат остаётся доступным только для чтения.", { exact: true })).toBeVisible();

    const chatUrl = page.url();
    const spawnCallsBeforeForceClick = await readFixtureSpawnNewSessionCallCount(page);
    await resumeButton.click({ force: true });
    const spawnCallsAfterForceClick = await readFixtureSpawnNewSessionCallCount(page);
    await expect(page).toHaveURL(chatUrl);
    await expect(resumeButton).toBeDisabled();
    expect(spawnCallsAfterForceClick).toBe(spawnCallsBeforeForceClick);

    await assertNoHorizontalOverflow(page);
    await assertNoBottomToastOverlap(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("directory keeps its content region stable and reduces motion to the design token", async ({ page }, testInfo) => {
    const pageIssues = collectPageIssues(page);

    await assertRequiredViewport(page, testInfo);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixtureRoute(page, "/new?fixtures=1");
    const directoryTrigger = page.getByRole("button", { name: /choose directory/i });
    await directoryTrigger.click();

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
            drawerAnimationName: drawerStyle.animationName,
            drawerAnimationDuration: drawerStyle.animationDuration,
            drawerTransitionDuration: drawerStyle.transitionDuration,
            drawerTransitionProperty: drawerStyle.transitionProperty,
            drawerTransitionTiming: drawerStyle.transitionTimingFunction,
            drawerTransform: drawerStyle.transform,
            overlayAnimationName: overlayStyle.animationName,
            overlayAnimationDuration: overlayStyle.animationDuration,
            overlayTransitionDuration: overlayStyle.transitionDuration,
            overlayTransitionProperty: overlayStyle.transitionProperty,
            overlayTransitionTiming: overlayStyle.transitionTimingFunction,
            regionDuration: regionStyle.transitionDuration,
            regionProperty: regionStyle.transitionProperty,
        };
    });
    expect(reducedMotion).toEqual({
        drawerAnimationName: "remcli-reduced-fade-in",
        drawerAnimationDuration: "0.12s",
        drawerTransitionDuration: "0.12s",
        drawerTransitionProperty: "opacity",
        drawerTransitionTiming: "cubic-bezier(0.22, 1, 0.36, 1)",
        drawerTransform: "matrix(1, 0, 0, 1, 0, 0)",
        overlayAnimationName: "remcli-reduced-fade-in",
        overlayAnimationDuration: "0.12s",
        overlayTransitionDuration: "0.12s",
        overlayTransitionProperty: "opacity",
        overlayTransitionTiming: "cubic-bezier(0.22, 1, 0.36, 1)",
        regionDuration: "0.12s",
        regionProperty: "opacity, transform",
    });

    await directoryRegion.getByRole("button", { name: "packages", exact: true }).click();
    await expect(directoryRegion.getByRole("button", { name: "remcli-web", exact: true })).toBeVisible();
    const nextHeight = await directoryRegion.evaluate((element) => element.getBoundingClientRect().height);
    expect(Math.abs(nextHeight - initialHeight)).toBeLessThanOrEqual(1);

    await page.keyboard.press("Escape");
    const closingDrawer = page.locator('[data-slot="drawer-content"][data-state="closed"]');
    const closingOverlay = page.locator('[data-slot="drawer-overlay"][data-state="closed"]');
    await expect(closingDrawer).toHaveCount(1);
    await expect(closingOverlay).toHaveCount(1);
    const closingMotion = await closingDrawer.evaluate((element) => {
        const drawerStyle = window.getComputedStyle(element);
        const overlayStyle = window.getComputedStyle(document.querySelector<HTMLElement>('[data-slot="drawer-overlay"][data-state="closed"]')!);
        return {
            drawerAnimationName: drawerStyle.animationName,
            drawerAnimationDuration: drawerStyle.animationDuration,
            drawerTransitionProperty: drawerStyle.transitionProperty,
            drawerTransitionDuration: drawerStyle.transitionDuration,
            drawerTransform: drawerStyle.transform,
            overlayAnimationName: overlayStyle.animationName,
            overlayAnimationDuration: overlayStyle.animationDuration,
            overlayTransitionProperty: overlayStyle.transitionProperty,
            overlayTransitionDuration: overlayStyle.transitionDuration,
        };
    });
    expect(closingMotion).toEqual({
        drawerAnimationName: "remcli-reduced-fade-out",
        drawerAnimationDuration: "0.12s",
        drawerTransitionProperty: "opacity",
        drawerTransitionDuration: "0.12s",
        drawerTransform: "matrix(1, 0, 0, 1, 0, 0)",
        overlayAnimationName: "remcli-reduced-fade-out",
        overlayAnimationDuration: "0.12s",
        overlayTransitionProperty: "opacity",
        overlayTransitionDuration: "0.12s",
    });
    await expect(closingDrawer).toHaveCount(0);
    await expect(directoryTrigger).toBeFocused();

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

type CapabilityControlName = "model" | "permission" | "reasoning";

function capabilityControl(page: Page, name: CapabilityControlName): Locator {
    return page.locator(`[data-capability-control="${name}"]`);
}

async function openCodexCapabilityFixture(page: Page, testInfo: TestInfo, path: string, expectedModel: string | null = "GPT-5.6-Luna"): Promise<PageIssue[]> {
    const pageIssues = collectPageIssues(page);
    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, path);
    await expect(page.locator('[data-capability-layout="two-row"]')).toBeVisible();

    const codex = page.getByRole("button", { name: /codex cli/i });
    await codex.click();
    await expect(codex).toHaveClass(/border-accent/);
    if (expectedModel) {
        await expect(capabilityControl(page, "model").locator("button")).toContainText(expectedModel);
    } else {
        await expect(capabilityControl(page, "model").getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    }
    return pageIssues;
}

async function openCursorCapabilityFixture(page: Page, testInfo: TestInfo, path: string, expectedModel: string | null = "Auto"): Promise<PageIssue[]> {
    const pageIssues = collectPageIssues(page);
    await assertRequiredViewport(page, testInfo);
    await openFixtureRoute(page, path);
    await expect(page.locator('[data-capability-layout="two-row"]')).toBeVisible();

    const cursor = page.getByRole("button", { name: /cursor agent/i });
    await cursor.click();
    await expect(cursor).toHaveClass(/border-accent/);
    if (expectedModel) {
        await expect(capabilityControl(page, "model").locator("button")).toContainText(expectedModel);
    } else {
        await expect(capabilityControl(page, "model").getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    }
    return pageIssues;
}

test("runtime new-session capability controls keep the accepted two-row contract", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(page, testInfo, "/new?fixtures=1");
    const boxes = await Promise.all((["model", "permission", "reasoning"] as const).map(async (name) => {
        const box = await capabilityControl(page, name).boundingBox();
        expect(box, `${name} control box`).not.toBeNull();
        return box!;
    }));

    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[0].x - boxes[2].x)).toBeLessThanOrEqual(1);
    expect(Math.abs(boxes[0].width - boxes[2].width)).toBeLessThanOrEqual(1);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);

    for (const name of ["model", "permission", "reasoning"] as const) {
        const button = capabilityControl(page, name).locator("button");
        await expect(button).toBeVisible();
        const box = await button.boundingBox();
        expect(box, `${name} interactive control box`).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(MOBILE_TOUCH_TARGET_MIN_PX);
    }

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime capability dialogs restore focus to their trigger after Escape", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(page, testInfo, "/new?fixtures=1");

    for (const name of ["model", "permission", "reasoning"] as const) {
        const trigger = capabilityControl(page, name).locator("button");
        await trigger.click();
        await expect(page.locator('[data-slot="drawer-content"]')).toHaveCount(1);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-slot="drawer-content"]')).toHaveCount(0);
        await expect(trigger).toBeFocused();
    }

    expect(pageIssues).toEqual([]);
});

test("runtime Codex model switch preserves advertised efforts through the reasoning sheet", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(page, testInfo, "/new?fixtures=1");
    await capabilityControl(page, "model").locator("button").click();
    await expect(page.getByRole("button", { name: "GPT-5.6-Terra", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "GPT-5.6-Terra", exact: true }).click();
    await expect(capabilityControl(page, "model").locator("button")).toContainText("GPT-5.6-Terra");
    await expect(page.locator('[data-slot="drawer-overlay"]')).toHaveCount(0);

    await capabilityControl(page, "reasoning").locator("button").click();
    await expect(page.getByRole("button", { name: "ultra", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "ultra", exact: true }).click();
    await expect(capabilityControl(page, "reasoning").locator("button")).toContainText("ultra");
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime reopened model drawer ignores a late close from its previous Vaul instance", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(page, testInfo, "/new?fixtures=1");
    const modelControl = capabilityControl(page, "model").locator("button");
    const terraOption = page.getByRole("button", { name: "GPT-5.6-Terra", exact: true });

    await modelControl.click();
    await expect(terraOption).toBeVisible();
    await terraOption.click();
    await expect(page.locator('[data-slot="drawer-overlay"]')).toHaveCount(0);

    await modelControl.click();
    await expect(terraOption).toBeVisible();
    // Vaul emits its close callback after its fixed 500ms transition. Keep the
    // reopened drawer alive past that point to catch a stale callback.
    await page.waitForTimeout(600);
    await expect(terraOption).toBeVisible();
    const reopenedDrawer = page.locator('[data-slot="drawer-content"][data-state="open"]');
    expect(await reopenedDrawer.evaluate((drawer) => drawer.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="drawer-content"]')).toHaveCount(0);
    await expect(modelControl).toBeFocused();
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime no-reasoning Codex fixture keeps start executable", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&codexCapabilities=no-reasoning",
        "GPT-5.6 No Reasoning",
    );
    await expect(capabilityControl(page, "reasoning")).toContainText("no configurable reasoning for this model");
    await expect(page.getByRole("button", { name: /Start codex/i })).toBeEnabled();
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime Codex choose-required fixture enables start only after an explicit effort choice", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&codexCapabilities=choose-required",
        "GPT-5.6 Choose Required",
    );
    const startButton = page.getByRole("button", { name: /Start codex/i });
    await expect(capabilityControl(page, "reasoning")).toContainText("choose a reasoning level");
    await expect(startButton).toBeDisabled();

    await capabilityControl(page, "reasoning").locator("button").click();
    await expect(page.getByRole("button", { name: "ultra", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "ultra", exact: true }).click();
    await expect(capabilityControl(page, "reasoning").locator("button")).toContainText("ultra");
    await expect(startButton).toBeEnabled();

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime Cursor catalog renders account-visible models, native controls, and unsupported reasoning", async ({ page }, testInfo) => {
    const pageIssues = await openCursorCapabilityFixture(page, testInfo, "/new?fixtures=1");

    await capabilityControl(page, "model").locator("button").click();
    const alternateModel = page.getByRole("button", { name: "GPT-5.6 Luna 1M Extra High", exact: true });
    await expect(alternateModel).toBeVisible();
    await alternateModel.click();
    await expect(capabilityControl(page, "model").locator("button")).toContainText("GPT-5.6 Luna 1M Extra High");

    const modeControl = capabilityControl(page, "permission").locator("button");
    await modeControl.click();
    const modeSheet = page.locator('[data-slot="drawer-content"]');
    await expect(modeSheet.getByRole("button", { name: /^Agent\b/i })).toBeVisible();
    await expect(modeSheet.getByRole("button", { name: /^Plan\b/i })).toBeVisible();
    await expect(modeSheet.getByRole("button", { name: /^Ask\b/i })).toBeVisible();
    for (const permission of CODEX_PERMISSION_LABELS) {
        await expect(modeSheet.getByText(permission, { exact: true })).toHaveCount(0);
    }
    for (const launchControl of ["Force", "Auto-review", "Approve all MCP servers"]) {
        await expect(modeSheet.getByText(launchControl, { exact: true })).toHaveCount(0);
    }
    await modeSheet.getByRole("button", { name: /^Plan\b/i }).click();
    await expect(page.locator('[data-slot="drawer-overlay"]')).toHaveCount(0);
    await expect(modeControl).toContainText("Plan");

    const launchControl = page.getByRole("button", { name: /^Advanced/i });
    await launchControl.click();
    const launchSheet = page.locator('[data-slot="drawer-content"]');
    await expect(launchSheet).toContainText("Advanced");
    await expect(launchSheet.getByRole("button", { name: "host-controlled", exact: true })).toBeVisible();
    await expect(launchSheet.getByRole("button", { name: "enabled", exact: true })).toBeVisible();
    await expect(launchSheet.getByRole("button", { name: "disabled", exact: true })).toBeVisible();

    const forceSwitch = launchSheet.getByRole("switch", { name: /^Force\b/i });
    const autoReviewSwitch = launchSheet.getByRole("switch", { name: /^Auto-review\b/i });
    const approveMcpsSwitch = launchSheet.getByRole("switch", { name: /^Approve all MCP servers\b/i });
    await expect(launchSheet.getByRole("switch")).toHaveCount(3);
    await expect(forceSwitch).toHaveAttribute("aria-checked", "false");
    await expect(autoReviewSwitch).toHaveAttribute("aria-checked", "false");
    await expect(approveMcpsSwitch).toHaveAttribute("aria-checked", "false");

    await forceSwitch.click();
    await expect(forceSwitch).toHaveAttribute("aria-checked", "true");
    await expect(autoReviewSwitch).toHaveAttribute("aria-checked", "false");
    await expect(approveMcpsSwitch).toHaveAttribute("aria-checked", "false");

    await autoReviewSwitch.click();
    await expect(forceSwitch).toHaveAttribute("aria-checked", "true");
    await expect(autoReviewSwitch).toHaveAttribute("aria-checked", "true");
    await expect(approveMcpsSwitch).toHaveAttribute("aria-checked", "false");

    await approveMcpsSwitch.click();
    await expect(forceSwitch).toHaveAttribute("aria-checked", "true");
    await expect(autoReviewSwitch).toHaveAttribute("aria-checked", "true");
    await expect(approveMcpsSwitch).toHaveAttribute("aria-checked", "true");

    const disabledSandbox = launchSheet.getByRole("button", { name: "disabled", exact: true });
    await disabledSandbox.click();
    await expect(disabledSandbox).toHaveAttribute("aria-pressed", "true");
    await expect(disabledSandbox).toHaveClass(/bg-accent\/10/);
    await expect(disabledSandbox.locator("svg")).toHaveCount(1);
    if (isMobileProject(testInfo)) {
        await assertNoHorizontalOverflow(page);
        await assertMobileTouchTargets(page);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-slot="drawer-content"]')).toHaveCount(0);
    await expect(capabilityControl(page, "reasoning")).toContainText("reasoning not configured separately");
    await expect(page.getByRole("button", { name: /Start cursor/i })).toBeEnabled();
    await assertNoHorizontalOverflow(page);
    if (isMobileProject(testInfo)) {
        await assertMobileTouchTargets(page);
    }
    expect(pageIssues).toEqual([]);
});

test("runtime Cursor keeps the full account catalog in a scrollable overflow-safe drawer", async ({ page }, testInfo) => {
    const pageIssues = await openCursorCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&cursorCapabilities=full",
        "Cursor account model · fixture 01",
    );
    const modelControl = capabilityControl(page, "model").locator("button");

    await modelControl.click();
    const modelDrawer = page.locator('[data-slot="drawer-content"]');
    const modelList = modelDrawer.getByRole("region", { name: /model.*cursor/i });
    await expect(modelList).toBeVisible();
    await expect(modelList).toHaveAttribute("aria-describedby", "model-sheet-note");
    await expect(modelList.getByRole("button")).toHaveCount(8);

    const scrollMetrics = await modelList.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
    }));
    expect(scrollMetrics.clientHeight).toBe(176);
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(scrollMetrics.clientWidth + 1);

    await modelList.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(modelList.getByRole("button", { name: "Cursor account model · fixture 08", exact: true })).toBeVisible();

    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime Cursor unavailable catalog blocks start and exposes retry", async ({ page }, testInfo) => {
    const pageIssues = await openCursorCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&cursorCapabilities=unavailable",
        null,
    );

    await expect(page.getByRole("button", { name: /Start cursor/i })).toBeDisabled();
    const modelRetry = capabilityControl(page, "model").getByRole("button", { name: "Retry", exact: true });
    await modelRetry.click();
    await expect(modelRetry).toBeVisible();
    await expect(capabilityControl(page, "reasoning")).toContainText("reasoning not configured separately");
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime Codex capability failure retains a retry control", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&codexCapabilities=unavailable",
        null,
    );
    const modelRetry = capabilityControl(page, "model").getByRole("button", { name: "Retry", exact: true });
    await modelRetry.click();
    await expect(modelRetry).toBeVisible();
    await expect(capabilityControl(page, "reasoning")).toContainText("Retry");
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});

test("runtime Codex capability rejection clears stale selection and recovers through refreshed catalog", async ({ page }, testInfo) => {
    const pageIssues = await openCodexCapabilityFixture(
        page,
        testInfo,
        "/new?fixtures=1&codexCapabilities=capability-rejection",
        "GPT-5.6-Stale",
    );
    const startButton = page.getByRole("button", { name: /Start codex/i });

    await expect(startButton).toBeEnabled();
    await startButton.click();
    await expect(page.getByText("Codex capability selection rejected: unsupported_selection.", { exact: true })).toBeVisible();
    await expect(startButton).toBeDisabled();
    await expect(capabilityControl(page, "model").locator("button")).toContainText("GPT-5.6-Refreshed");
    await expect(startButton).toBeEnabled();

    await capabilityControl(page, "reasoning").locator("button").click();
    await expect(page.getByRole("button", { name: "ultra", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "ultra", exact: true }).click();
    await expect(capabilityControl(page, "reasoning").locator("button")).toContainText("ultra");
    await Promise.all([
        page.waitForURL(/\/session\//),
        startButton.click(),
    ]);
    await assertNoHorizontalOverflow(page);
    expect(pageIssues).toEqual([]);
});
