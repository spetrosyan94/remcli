import { describe, expect, it } from "vitest";
import {
    collectTranslationCallsFromSource,
    validateTranslationCallParameters,
} from "./check-translations.mjs";

const base = new Map([
    ["session.start", "Запустить {agent} в {dir}"],
    ["session.ready", "Готово"],
]);

describe("check-translations", () => {
    it("accepts the exact literal interpolation parameters", () => {
        const calls = collectTranslationCallsFromSource(
            't("session.start", { agent: "Codex", dir: "~/work" });',
            "valid.tsx",
        );

        expect(validateTranslationCallParameters(calls.literalCalls, base)).toEqual([]);
    });

    it("rejects missing and unexpected interpolation parameters", () => {
        const calls = collectTranslationCallsFromSource(
            't("session.start", { agent: "Codex", wrongName: "~/work" });',
            "invalid.tsx",
        );

        expect(validateTranslationCallParameters(calls.literalCalls, base)).toEqual([
            'invalid.tsx:1: t("session.start") parameters must match {agent, dir} (missing {dir}, unexpected {wrongName})',
        ]);
    });

    it("rejects dynamic parameter objects when interpolation requires static verification", () => {
        const calls = collectTranslationCallsFromSource(
            't("session.start", params); t("session.ready", params);',
            "dynamic.tsx",
        );

        expect(validateTranslationCallParameters(calls.literalCalls, base)).toEqual([
            'dynamic.tsx:1: t("session.start") must use a literal parameter object matching {agent, dir}',
        ]);
    });
});
