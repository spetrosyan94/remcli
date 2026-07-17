import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.REMCLI_WEB_E2E_PORT ?? 5180);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: "./e2e",
    testMatch: /design-(visual|contract)\.spec\.ts/,
    timeout: 30_000,
    expect: {
        timeout: 5_000,
    },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    outputDir: "test-results/visual",
    preserveOutput: "failures-only",
    snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}",
    reporter: process.env.CI
        ? [["github"], ["html", { outputFolder: "playwright-report/visual", open: "never" }]]
        : [["list"], ["html", { outputFolder: "playwright-report/visual", open: "never" }]],
    use: {
        baseURL: BASE_URL,
        browserName: "chromium",
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "retain-on-failure",
    },
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `${BASE_URL}/?fixtures=1`,
        reuseExistingServer: !process.env.CI,
        timeout: 90_000,
    },
    projects: [
        {
            name: "mobile-dark",
            use: {
                ...devices["Pixel 7"],
                browserName: "chromium",
                viewport: { width: 390, height: 844 },
                colorScheme: "dark",
                locale: "en-US",
                timezoneId: "UTC",
                reducedMotion: "reduce",
                isMobile: true,
                hasTouch: true,
            },
        },
        {
            name: "mobile-light",
            use: {
                ...devices["Pixel 7"],
                browserName: "chromium",
                viewport: { width: 390, height: 844 },
                colorScheme: "light",
                locale: "en-US",
                timezoneId: "UTC",
                reducedMotion: "reduce",
                isMobile: true,
                hasTouch: true,
            },
        },
        {
            name: "desktop-dark",
            use: {
                ...devices["Desktop Chrome"],
                browserName: "chromium",
                viewport: { width: 1280, height: 800 },
                colorScheme: "dark",
                locale: "en-US",
                timezoneId: "UTC",
                reducedMotion: "reduce",
            },
        },
        {
            name: "desktop-light",
            use: {
                ...devices["Desktop Chrome"],
                browserName: "chromium",
                viewport: { width: 1280, height: 800 },
                colorScheme: "light",
                locale: "en-US",
                timezoneId: "UTC",
                reducedMotion: "reduce",
            },
        },
    ],
});
