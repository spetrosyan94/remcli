import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListenButton } from "@/components/kit/ListenButton";
import { PermissionCard } from "@/components/kit/PermissionCard";
import { Segmented } from "@/components/kit/Segmented";

const sourceRoot = resolve(import.meta.dirname, "../..");
const readSource = (file: string) => readFileSync(resolve(sourceRoot, file), "utf8");

describe("canonical motion contract", () => {
    it("keeps drawer and dialog timing, opacity fallback, and dialog scale in CSS", () => {
        const drawer = readSource("components/ui/drawer.tsx");
        const dialog = readSource("components/ui/dialog.tsx");
        const css = readSource("index.css");

        expect(drawer).toContain("data-[state=closed]:duration-[var(--dur-sheet)]");
        expect(drawer).toContain("data-[state=open]:duration-[var(--dur-sheet)]");
        expect(drawer).toContain("bg-black/55");
        expect(dialog).toContain("bg-black/55");
        expect(dialog).toContain("data-[state=open]:zoom-in-[0.98]");
        expect(dialog).toContain("data-[state=closed]:zoom-out-[0.98]");
        expect(css).toContain("[data-slot=\"dialog-content\"][data-state=\"open\"]");
        expect(css).toContain("transform: none !important");
    });

    it("keeps segmented controls to color/background/transform transitions", () => {
        const markup = renderToStaticMarkup(React.createElement(Segmented, { options: ["one", "two"], value: "one" }));
        expect(markup).toContain("transition-[background-color,color,transform]");
        expect(markup).toContain("duration-[var(--dur-micro)]");
        expect(markup).not.toContain("transition-[background-color,box-shadow");
    });

    it("keeps ListenButton geometry fixed and disables looping motion for reduced motion", () => {
        const markup = renderToStaticMarkup(React.createElement(ListenButton, { state: "playing" }));
        expect(markup).toContain("w-[104px]");
        expect(markup).toContain("duration-[150ms]");
        expect(markup).toContain("motion-reduce:animate-none");
    });

    it("keeps permission actions at the mobile target size without changing desktop classes", () => {
        const markup = renderToStaticMarkup(React.createElement(PermissionCard, { tool: "bash", command: "echo ok", alwaysLabel: "Always allow" }));
        expect((markup.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect((markup.match(/h-\[34px\]/g) ?? []).length).toBe(2);
    });
});
