import { expect, test } from "@playwright/test";

test("New Session modal drawer exposes semantics and restores focus after Escape", async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto("/new?fixtures=1", { waitUntil: "domcontentloaded" });

    const trigger = page.getByRole("button", { name: /choose directory/i });
    await trigger.click();

    const drawer = page.locator('[data-slot="drawer-content"]');
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
});

test("Chat modal drawer exposes semantics and restores focus after Escape", async ({ page }) => {
    await page.addInitScript(() => {
        window.localStorage.setItem("remcli-fixtures", "1");
        window.localStorage.setItem("remcli-locale", "en");
        window.localStorage.setItem("remcli-theme", "dark");
    });
    await page.goto("/session/fx-chat?fixtures=1", { waitUntil: "domcontentloaded" });

    const trigger = page.getByRole("button", { name: /next message settings/i });
    await trigger.click();

    const drawer = page.locator("#chat-next-message-drawer");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(trigger).toBeFocused();
});
