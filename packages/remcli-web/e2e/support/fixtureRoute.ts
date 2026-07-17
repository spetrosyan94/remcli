import { expect, type Page } from "@playwright/test";

export interface FixtureRoute {
    name: string;
    path: string;
    state?: "command-palette";
}

export type FixtureTheme = "dark" | "light";

export const FIXTURE_ROUTES: readonly FixtureRoute[] = [
    { name: "home", path: "/" },
    { name: "new-session", path: "/new" },
    { name: "chat", path: "/session/fx-chat" },
    { name: "terminal", path: "/session/fx-running/terminal" },
    { name: "zen", path: "/zen" },
    { name: "settings", path: "/settings" },
    { name: "concierge", path: "/concierge" },
    { name: "connect", path: "/connect" },
    { name: "connect-scanning", path: "/connect?connectFixture=scanning" },
    { name: "connect-error", path: "/connect?connectFixture=error" },
    { name: "connect-manual", path: "/connect?connectFixture=manual" },
    { name: "palette", path: "/", state: "command-palette" },
];

export const FIXTURE_TIME = new Date("2026-06-15T10:00:00.000Z");

const ANIMATION_FREEZE_STYLE = `
    *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
    }
`;

export function fixtureThemeFromProjectName(projectName: string): FixtureTheme {
    if (projectName.endsWith("-dark")) return "dark";
    if (projectName.endsWith("-light")) return "light";
    throw new Error(`Visual project must declare a theme: ${projectName}`);
}

function buildFixturePath(route: FixtureRoute): string {
    const url = new URL(route.path, "http://remcli-fixture.local");
    url.searchParams.set("fixtures", "1");
    return `${url.pathname}${url.search}`;
}

async function expectFixtureRouteReady(page: Page, route: FixtureRoute): Promise<void> {
    if (route.name === "connect") {
        await expect(page.getByRole("button", { name: "Scan QR code" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Enter address manually" })).toBeVisible();
        return;
    }

    if (route.name === "connect-scanning") {
        await expect(page.getByRole("button", { name: "Close scanner" })).toBeVisible();
        return;
    }

    if (route.name === "connect-error") {
        await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
        return;
    }

    if (route.name === "connect-manual") {
        await expect(page.getByRole("textbox", { name: "address:port" })).toBeVisible();
        return;
    }

    if (route.name === "terminal") {
        await expect(page.locator("main")).toBeVisible();
        await expect(page.getByText("Terminal is only available on the host", { exact: true })).toBeVisible();
        return;
    }

    if (route.state === "command-palette") {
        await expect(page.getByRole("button", { name: "Search (⌘K)" })).toBeVisible();
        return;
    }

    // Home switches between mobile header/main and a desktop section at the breakpoint.
    await expect(page.locator("header:visible, main:visible, section:visible").first()).toBeVisible();
}

export async function openFixtureRoute(page: Page, route: FixtureRoute, theme: FixtureTheme): Promise<void> {
    await page.clock.setFixedTime(FIXTURE_TIME);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((selectedTheme: FixtureTheme) => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", selectedTheme);
    }, theme);

    await page.goto(buildFixturePath(route), { waitUntil: "domcontentloaded" });
    await expectFixtureRouteReady(page, route);
    await expect(page.locator('[data-slot="skeleton"]:visible')).toHaveCount(0);

    const html = page.locator("html");
    if (theme === "dark") {
        await expect(html).toHaveClass(/dark/);
    } else {
        await expect(html).not.toHaveClass(/dark/);
    }

    await page.addStyleTag({ content: ANIMATION_FREEZE_STYLE });

    if (route.state === "command-palette") {
        await page.getByRole("button", { name: "Search (⌘K)" }).click();
        const palette = page.getByRole("dialog");
        await expect(palette).toBeVisible();
        await expect(palette.getByPlaceholder("Search sessions and actions…")).toBeFocused();
    }
}
