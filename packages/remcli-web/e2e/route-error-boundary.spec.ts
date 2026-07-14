import { expect, test, type Page } from "@playwright/test";

type RouteErrorHarnessKind = "chunk" | "runtime" | "success";
type RouteErrorScenario = "transient" | "permanent";

async function openFixturePage(page: Page, routeErrorScenario?: RouteErrorScenario): Promise<void> {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");

        const routeErrorScenario = new URLSearchParams(window.location.search).get("route-error-scenario");
        if (routeErrorScenario !== "transient" && routeErrorScenario !== "permanent") return;

        const scenarioAttemptKey = `remcli:e2e:route-error-scenario:${routeErrorScenario}`;
        const scenarioDocumentCountKey = `remcli:e2e:route-error-scenario-document-count:${routeErrorScenario}`;
        const hasRetried = window.sessionStorage.getItem(scenarioAttemptKey) === "1";
        const routeKind = routeErrorScenario === "transient" && hasRetried ? "success" : "chunk";
        window.sessionStorage.setItem(scenarioAttemptKey, "1");
        window.sessionStorage.setItem(
            scenarioDocumentCountKey,
            String(Number(window.sessionStorage.getItem(scenarioDocumentCountKey) ?? "0") + 1),
        );

        window.addEventListener("DOMContentLoaded", () => {
            window.setTimeout(() => {
                void import("/src/test/routeErrorBoundaryHarness.tsx").then(({ mountRouteErrorBoundaryHarness }) => {
                    mountRouteErrorBoundaryHarness(routeKind);
                });
            }, 0);
        });
    });
    const scenarioQuery = routeErrorScenario ? `&route-error-scenario=${routeErrorScenario}` : "";
    await page.goto(`/?fixtures=1${scenarioQuery}`, { waitUntil: "domcontentloaded" });
}

async function mountErrorBoundaryHarness(page: Page, kind: RouteErrorHarnessKind): Promise<string> {
    return await page.evaluate(async (requestedKind) => {
        const harness = await import("/src/test/routeErrorBoundaryHarness.tsx");
        return harness.mountRouteErrorBoundaryHarness(requestedKind);
    }, kind);
}

function harnessLocator(page: Page, id: string) {
    return page.locator(`[data-route-error-harness="${id}"]`);
}

async function getRouteErrorScenarioDocumentCount(page: Page, routeErrorScenario: RouteErrorScenario): Promise<string | null> {
    return await page.evaluate((scenario) => {
        return window.sessionStorage.getItem(`remcli:e2e:route-error-scenario-document-count:${scenario}`);
    }, routeErrorScenario);
}

test("ordinary route errors bubble to the app boundary without retry", async ({ page }) => {
    await openFixturePage(page);
    const id = await mountErrorBoundaryHarness(page, "runtime");
    const harness = harnessLocator(page, id);

    await expect(harness.getByRole("alert")).toBeVisible();
    await expect(harness).toHaveAttribute("data-runtime-error-captured", "true");
});

test("lazy-import recovery reloads once and succeeds in the new document", async ({ page }) => {
    await openFixturePage(page, "transient");

    const recoveredRoute = page.locator('[data-route-recovery="success"]');
    await expect(recoveredRoute).toBeVisible();
    await expect(recoveredRoute).toHaveText("Route recovered after reload");
    expect(await getRouteErrorScenarioDocumentCount(page, "transient")).toBe("2");
});

test("permanent lazy-import failure keeps a usable fallback after one automatic reload", async ({ page }) => {
    await openFixturePage(page, "permanent");

    const fallbackHarness = page.locator("[data-route-error-harness]");
    await expect(fallbackHarness.getByRole("alert")).toBeVisible();
    await expect(fallbackHarness).toHaveAttribute("data-route-error-kind", "chunk");
    expect(await getRouteErrorScenarioDocumentCount(page, "permanent")).toBe("2");

    const retryButton = fallbackHarness.getByRole("button", { name: "Retry" });
    await expect(retryButton).toBeEnabled();

    const manualReload = page.waitForNavigation({ waitUntil: "domcontentloaded" });
    await retryButton.click();
    await manualReload;
    await expect(page.locator("[data-route-error-harness]").getByRole("alert")).toBeVisible();
    expect(await getRouteErrorScenarioDocumentCount(page, "permanent")).toBe("3");
});
