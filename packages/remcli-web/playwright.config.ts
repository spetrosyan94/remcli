import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.REMCLI_WEB_E2E_PORT ?? 5179);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: {
        timeout: 5_000
    },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
    use: {
        baseURL: BASE_URL,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    webServer: {
        command: `npm run dev -- --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `${BASE_URL}/?fixtures=1`,
        reuseExistingServer: !process.env.CI,
        timeout: 90_000
    },
    projects: [
        {
            name: 'mobile-chromium',
            use: {
                ...devices['Pixel 7'],
                browserName: 'chromium',
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true
            }
        },
        {
            name: 'desktop-chromium',
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1280, height: 800 }
            }
        }
    ]
});
