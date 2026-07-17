import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { AxeResults } from "axe-core";
import {
    FIXTURE_ROUTES,
    fixtureThemeFromProjectName,
    openFixtureRoute,
} from "./support/fixtureRoute";

interface A11yViolationReport {
    id: string;
    impact: string | undefined;
    help: string;
    targets: string[][];
}

function formatA11yViolations(violations: AxeResults["violations"]): A11yViolationReport[] {
    return violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? undefined,
        help: violation.help,
        targets: violation.nodes.map((node) => node.target.map(String)),
    }));
}

for (const route of FIXTURE_ROUTES) {
    test(`${route.name} has an owner-reviewed visual baseline and no serious axe violations`, async ({ page }, testInfo) => {
        const theme = fixtureThemeFromProjectName(testInfo.project.name);
        await openFixtureRoute(page, route, theme);

        const axeResults = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
            .analyze();
        const seriousViolations = axeResults.violations.filter(
            (violation) => violation.impact === "serious" || violation.impact === "critical",
        );
        expect(
            formatA11yViolations(seriousViolations),
            "Only minor/moderate axe violations may remain in the visual gate.",
        ).toEqual([]);

        await expect(page).toHaveScreenshot(`${route.name}.png`, {
            animations: "disabled",
            caret: "hide",
            fullPage: true,
            maxDiffPixelRatio: 0.001,
        });
    });
}
