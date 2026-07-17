import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
    FIXTURE_ROUTES,
    fixtureThemeFromProjectName,
    openFixtureRoute,
    type FixtureTheme,
} from "./support/fixtureRoute";

const EXPECTED_THEME_TOKENS: Record<FixtureTheme, Record<string, string>> = {
    light: {
        "--background": "0 0% 98%",
        "--foreground": "240 6% 10%",
        "--card": "0 0% 100%",
        "--card-foreground": "240 6% 10%",
        "--popover": "0 0% 100%",
        "--popover-foreground": "240 6% 10%",
        "--primary": "240 6% 10%",
        "--primary-foreground": "0 0% 98%",
        "--secondary": "240 5% 96%",
        "--secondary-foreground": "240 6% 10%",
        "--muted": "240 5% 96%",
        "--muted-foreground": "240 5% 34%",
        "--accent": "159 90% 23%",
        "--accent-foreground": "0 0% 100%",
        "--destructive": "0 74% 42%",
        "--destructive-foreground": "0 0% 100%",
        "--border": "240 6% 90%",
        "--input": "240 6% 90%",
        "--ring": "159 90% 23%",
        "--status-running": "159 90% 23%",
        "--status-thinking": "193 83% 27%",
        "--status-permission": "23 83% 31%",
        "--status-idle": "240 4% 46%",
        "--status-offline": "240 5% 65%",
        "--status-error": "0 72% 42%",
        "--radius": "0.5rem",
        "--dur-micro": "120ms",
        "--dur-std": "200ms",
        "--dur-enter": "240ms",
        "--dur-sheet": "320ms",
        "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
        "--ease-sheet": "cubic-bezier(0.32, 0.72, 0, 1)",
        "--font-sans": '"Geist", system-ui, sans-serif',
        "--font-mono": '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
    },
    dark: {
        "--background": "240 10% 4%",
        "--foreground": "0 0% 98%",
        "--card": "240 7% 8%",
        "--card-foreground": "0 0% 98%",
        "--popover": "240 7% 8%",
        "--popover-foreground": "0 0% 98%",
        "--primary": "0 0% 98%",
        "--primary-foreground": "240 10% 4%",
        "--secondary": "240 6% 13%",
        "--secondary-foreground": "0 0% 98%",
        "--muted": "240 6% 11%",
        "--muted-foreground": "240 5% 65%",
        "--accent": "158 64% 52%",
        "--accent-foreground": "158 84% 10%",
        "--destructive": "0 91% 71%",
        "--destructive-foreground": "0 63% 11%",
        "--border": "240 6% 16%",
        "--input": "240 6% 16%",
        "--ring": "158 64% 52%",
        "--status-running": "158 64% 52%",
        "--status-thinking": "187 86% 53%",
        "--status-permission": "43 96% 56%",
        "--status-idle": "240 4% 46%",
        "--status-offline": "240 4% 33%",
        "--status-error": "0 91% 71%",
        "--radius": "0.5rem",
        "--dur-micro": "120ms",
        "--dur-std": "200ms",
        "--dur-enter": "240ms",
        "--dur-sheet": "320ms",
        "--ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
        "--ease-sheet": "cubic-bezier(0.32, 0.72, 0, 1)",
        "--font-sans": '"Geist", system-ui, sans-serif',
        "--font-mono": '"Geist Mono", "JetBrains Mono", ui-monospace, monospace',
    },
};

function extractThemeTokens(stylesheet: string, selector: ":root" | ".dark"): Record<string, string> {
    const escapedSelector = selector.replace(".", "\\.");
    const blockMatch = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`));
    if (!blockMatch) {
        throw new Error(`Missing ${selector} block in token stylesheet.`);
    }

    return Object.fromEntries(
        [...blockMatch[1].matchAll(/(?<name>--[\w-]+):\s*(?<value>[^;]+);/g)].map((match) => [
            match.groups?.name,
            match.groups?.value.trim(),
        ]),
    );
}

function extractEffectiveThemeTokens(stylesheet: string, theme: FixtureTheme): Record<string, string> {
    const rootTokens = extractThemeTokens(stylesheet, ":root");
    return theme === "dark"
        ? { ...rootTokens, ...extractThemeTokens(stylesheet, ".dark") }
        : rootTokens;
}

const appTokenStylesheet = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const localDesignTokenUrl = new URL("../../../design/tokens.css", import.meta.url);
const localDesignTokenStylesheet = existsSync(localDesignTokenUrl)
    ? readFileSync(localDesignTokenUrl, "utf8")
    : null;

const APP_THEME_TOKENS: Record<FixtureTheme, Record<string, string>> = {
    light: extractEffectiveThemeTokens(appTokenStylesheet, "light"),
    dark: extractEffectiveThemeTokens(appTokenStylesheet, "dark"),
};

test("tracked runtime tokens implement the complete design contract", () => {
    expect(APP_THEME_TOKENS).toEqual(EXPECTED_THEME_TOKENS);
});

if (localDesignTokenStylesheet) {
    const LOCAL_DESIGN_THEME_TOKENS: Record<FixtureTheme, Record<string, string>> = {
        light: extractEffectiveThemeTokens(localDesignTokenStylesheet, "light"),
        dark: extractEffectiveThemeTokens(localDesignTokenStylesheet, "dark"),
    };

    test("local design tokens stay synchronized with the tracked runtime stylesheet", () => {
        expect(LOCAL_DESIGN_THEME_TOKENS).toEqual(APP_THEME_TOKENS);
    });
}

test("runtime exposes the complete design token contract", async ({ page }, testInfo) => {
    const theme = fixtureThemeFromProjectName(testInfo.project.name);
    await openFixtureRoute(page, FIXTURE_ROUTES[0], theme);

    const tokenValues = await page.evaluate((tokenNames) => {
        const styles = getComputedStyle(document.documentElement);
        return Object.fromEntries(
            tokenNames.map((tokenName) => [tokenName, styles.getPropertyValue(tokenName).trim()]),
        );
    }, Object.keys(EXPECTED_THEME_TOKENS.light));

    expect(tokenValues).toEqual(EXPECTED_THEME_TOKENS[theme]);
});

test("page chrome binds to semantic background and foreground tokens", async ({ page }, testInfo) => {
    const theme = fixtureThemeFromProjectName(testInfo.project.name);
    await openFixtureRoute(page, FIXTURE_ROUTES[0], theme);

    const semanticColors = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.cssText = [
            "position: fixed",
            "left: -9999px",
            "width: 1px",
            "height: 1px",
            "color: hsl(var(--foreground))",
            "background-color: hsl(var(--background))",
        ].join(";");
        document.body.append(probe);

        const probeStyles = getComputedStyle(probe);
        const bodyStyles = getComputedStyle(document.body);
        const result = {
            bodyBackground: bodyStyles.backgroundColor,
            bodyForeground: bodyStyles.color,
            tokenBackground: probeStyles.backgroundColor,
            tokenForeground: probeStyles.color,
            bodyFont: bodyStyles.fontFamily,
        };
        probe.remove();
        return result;
    });

    expect(semanticColors.bodyBackground).toBe(semanticColors.tokenBackground);
    expect(semanticColors.bodyForeground).toBe(semanticColors.tokenForeground);
    expect(semanticColors.bodyFont).toContain("Geist");
});
