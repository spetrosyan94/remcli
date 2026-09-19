import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
    createInitialStructuredValues,
    createStructuredResponseGate,
    isSafeDisplayUrl,
    isSafeHttpsUrl,
    isStructuredResponseLocked,
    navigateValidatedStructuredUrl,
    openStructuredUrlPlaceholder,
    rfc3339ToDateTimeLocal,
    STRUCTURED_ALREADY_RESOLVED_VISIBLE_MS,
    StructuredResponseFeedback,
    StructuredInputCard,
    structuredFieldIsValid,
    structuredFormContent,
    structuredToolAnswers,
} from "@/components/kit/StructuredInputCard";
import { FIXTURE_STRUCTURED_REQUESTS } from "@/lib/fixtures/data";
import {
    CodexStructuredRequestSchema,
    CodexStructuredInputResponseResultSchema,
    type CodexStructuredRequest,
    type StructuredInputField,
} from "@/lib/protocol/types";

const onOpenUrl = async () => ({ url: "https://docs.example.com/remcli/approval?token=test#authorize" });

function renderCard(request: CodexStructuredRequest): string {
    return renderToStaticMarkup(React.createElement(StructuredInputCard, {
        request,
        onResponse: async () => ({ status: "submitted" as const }),
        onOpenUrl,
    }));
}

describe("StructuredInputCard canonical contract", () => {
    it("accepts canonical request kinds and format metadata without an option-count UI cap", () => {
        const toolRequest = FIXTURE_STRUCTURED_REQUESTS["fx-structured-tool-input"];
        const manyOptions = Array.from({ length: 4 }, (_, index) => ({ value: `value-${index}`, label: `Option ${index}` }));

        expect(CodexStructuredRequestSchema.safeParse(toolRequest).success).toBe(true);
        expect(CodexStructuredRequestSchema.safeParse({
            ...toolRequest,
            fields: [{ ...toolRequest.fields[0], options: manyOptions }],
        }).success).toBe(true);
        expect(CodexStructuredRequestSchema.safeParse(FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-form"]).success).toBe(true);
        expect(CodexStructuredRequestSchema.safeParse(FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-url"]).success).toBe(true);
    });

    it("keeps raw URLs out of state and renders only the safe display projection", () => {
        const request = FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-url"];
        expect(isSafeHttpsUrl("https://docs.example.com/approval?token=secret#authorize")).toBe(true);
        expect(isSafeHttpsUrl("http://docs.example.com/approval")).toBe(false);
        expect(isSafeHttpsUrl("https://user:pass@docs.example.com/approval")).toBe(false);
        expect(isSafeDisplayUrl(request.displayUrl ?? "")).toBe(true);
        expect(isSafeDisplayUrl("https://docs.example.com/approval?token=secret")).toBe(false);
        expect(CodexStructuredRequestSchema.safeParse({ ...request, url: "https://docs.example.com/secret" }).success).toBe(false);
        expect(JSON.stringify(FIXTURE_STRUCTURED_REQUESTS)).not.toContain("fixture-raw-secret");

        const markup = renderCard(request);
        expect(markup).toContain('data-structured-kind="mcp-url"');
        expect(markup).toContain("https://docs.example.com/remcli/approval");
        expect(markup).not.toContain("token=");
        expect(markup).not.toContain("#authorize");
        expect(markup).not.toContain("PermissionCard");
    });

    it("opens a blank tab synchronously, clears opener, then validates and navigates it", () => {
        const replace = vi.fn();
        const proxy = { opener: { parent: true }, location: { replace } } as unknown as Window;
        const openWindow = vi.fn(() => proxy);

        expect(openStructuredUrlPlaceholder(openWindow)).toBe(proxy);
        expect(openWindow).toHaveBeenCalledWith("about:blank", "_blank");
        expect(proxy.opener).toBeNull();
        navigateValidatedStructuredUrl(proxy, "https://docs.example.com/approval?token=secret");
        expect(replace).toHaveBeenCalledWith("https://docs.example.com/approval?token=secret");
        expect(openStructuredUrlPlaceholder(() => null)).toBeNull();
        expect(() => navigateValidatedStructuredUrl(proxy, "https://user:pass@docs.example.com/approval")).toThrow();
    });

    it("preserves defaults and explicit false, empty string, and empty array while omitting untouched optional fields", () => {
        const fields: StructuredInputField[] = [
            { id: "defaultFalse", type: "boolean", label: "Default false", required: false, defaultValue: false },
            { id: "defaultEmpty", type: "text", label: "Default empty", required: false, defaultValue: "" },
            { id: "defaultList", type: "multiselect", label: "Default list", required: false, defaultValue: [] },
            { id: "untouched", type: "text", label: "Untouched", required: false },
            { id: "explicitEmpty", type: "text", label: "Explicit empty", required: false },
        ];
        const initial = createInitialStructuredValues(fields);

        expect(initial).toEqual({ defaultFalse: false, defaultEmpty: "", defaultList: [] });
        expect(Object.prototype.hasOwnProperty.call(initial, "untouched")).toBe(false);
        expect(structuredFormContent(fields, { ...initial, explicitEmpty: "" }, {})).toEqual({
            defaultFalse: false,
            defaultEmpty: "",
            defaultList: [],
            explicitEmpty: "",
        });
    });

    it("treats required text as a presence constraint and uses minLength for non-empty constraints", () => {
        const requiredText: StructuredInputField = { id: "name", type: "text", label: "Name", required: true };
        const nonEmptyText: StructuredInputField = { ...requiredText, minLength: 1 };

        expect(structuredFieldIsValid(requiredText, { isPresent: false })).toBe(false);
        expect(structuredFieldIsValid(requiredText, { isPresent: true, value: "" })).toBe(true);
        expect(structuredFieldIsValid(nonEmptyText, { isPresent: true, value: "" })).toBe(false);
    });

    it("requires an explicit Yes or No for a required boolean and renders one labelled radio group", () => {
        const request: CodexStructuredRequest = {
            requestKey: "boolean-only",
            kind: "mcp-form",
            message: "Choose a boolean value.",
            fields: [{ id: "enabled", type: "boolean", label: "Enabled", required: true }],
            isBlocking: true,
            createdAt: 1,
            deadlineAt: 2,
        };
        const markup = renderCard(request);

        expect(structuredFieldIsValid(request.fields[0], { isPresent: false })).toBe(false);
        expect(structuredFieldIsValid(request.fields[0], { isPresent: true, value: false })).toBe(true);
        expect(markup.match(/type="radio"/g)?.length).toBe(2);
        expect(markup).toContain("Not selected");
        expect(markup).toContain(">Yes<");
        expect(markup).toContain(">No<");
        expect(markup).not.toContain('type="checkbox"');
        expect(markup).toMatch(/<button type="button" disabled=""[^>]*>Submit<\/button>/);
    });

    it("renders A/B/C, free and password inputs and sends one mutually exclusive single-select answer", () => {
        const request = FIXTURE_STRUCTURED_REQUESTS["fx-structured-tool-input"];
        const markup = renderCard(request);

        expect(markup).toContain("A · current package");
        expect(markup).toContain("B · all workspaces");
        expect(markup).toContain("C · fixture only");
        expect(markup).toContain('type="password"');
        expect(markup).toContain("Anything else the agent should consider?");

        expect(structuredToolAnswers(
            request.fields,
            { target: "current-package", note: "", secret: "temporary" },
            { target: "custom-target" },
        )).toEqual({
            target: ["custom-target"],
            note: [""],
            secret: ["temporary"],
        });
    });

    it("allows multiselect Other alongside selected options and preserves an explicit empty list", () => {
        const field = FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-form"].fields.find((candidate) => candidate.id === "components")!;
        expect(structuredFormContent([field], { components: ["web"] }, { components: "worker" })).toEqual({
            components: ["web", "worker"],
        });
        expect(structuredFormContent([{ ...field, required: false, minItems: undefined }], { components: [] }, {})).toEqual({ components: [] });
    });

    it("maps MCP formats to native inputs and uses matching explicit validation", () => {
        const request = FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-form"];
        const markup = renderCard(request);
        expect(markup).toContain('type="email"');
        expect(markup).toContain('type="url"');
        expect(markup).toContain('type="date"');
        expect(markup).toContain('type="datetime-local"');

        const byId = Object.fromEntries(request.fields.map((field) => [field.id, field]));
        expect(structuredFieldIsValid(byId.contactEmail, { isPresent: true, value: "invalid" })).toBe(false);
        expect(structuredFieldIsValid(byId.contactEmail, { isPresent: true, value: "dev@example.com" })).toBe(true);
        expect(structuredFieldIsValid(byId.callbackUri, { isPresent: true, value: "https://example.com/callback" })).toBe(true);
        expect(structuredFieldIsValid(byId.releaseDate, { isPresent: true, value: "2030-02-30" })).toBe(false);
        expect(structuredFieldIsValid(byId.scheduledAt, { isPresent: true, value: "2030-05-17T14:30" })).toBe(true);
    });

    it("converts displayed datetime-local values to RFC3339 only at form serialization", () => {
        const field = FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-form"].fields.find((candidate) => candidate.id === "scheduledAt")!;
        const localValue = "2030-05-17T14:30";
        const content = structuredFormContent([field], { scheduledAt: localValue }, {});

        expect(content.scheduledAt).toBe(new Date(localValue).toISOString());
        expect(content.scheduledAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("normalizes RFC3339 defaults for datetime-local and preserves their original instant", () => {
        const defaultValue = "2030-05-17T14:30:00Z";
        const fields: StructuredInputField[] = [
            { id: "requiredAt", type: "text", format: "date-time", label: "Required at", required: true, defaultValue },
            { id: "optionalAt", type: "text", format: "date-time", label: "Optional at", required: false, defaultValue },
            { id: "untouchedAt", type: "text", format: "date-time", label: "Untouched at", required: false },
        ];
        const localValue = rfc3339ToDateTimeLocal(defaultValue);
        const initial = createInitialStructuredValues(fields);

        expect(localValue).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
        expect(localValue).not.toContain("Z");
        expect(initial).toEqual({ requiredAt: localValue, optionalAt: localValue });
        expect(structuredFieldIsValid(fields[0], { isPresent: true, value: initial.requiredAt })).toBe(true);
        expect(structuredFormContent(fields, initial, {})).toEqual({
            requiredAt: "2030-05-17T14:30:00.000Z",
            optionalAt: "2030-05-17T14:30:00.000Z",
        });
        expect(structuredFormContent([fields[0]], { requiredAt: localValue.slice(0, 16) }, {})).toEqual({
            requiredAt: "2030-05-17T14:30:00.000Z",
        });
    });

    it("serializes a required user-entered datetime-local value as an RFC3339 instant", () => {
        const field: StructuredInputField = {
            id: "requiredAt",
            type: "text",
            format: "date-time",
            label: "Required at",
            required: true,
        };
        const localValue = "2030-05-17T14:30";

        expect(structuredFieldIsValid(field, { isPresent: false })).toBe(false);
        expect(structuredFieldIsValid(field, { isPresent: true, value: localValue })).toBe(true);
        expect(structuredFormContent([field], { requiredAt: localValue }, {})).toEqual({
            requiredAt: new Date(localValue).toISOString(),
        });
    });

    it("validates submitted and already-resolved broker results", () => {
        expect(CodexStructuredInputResponseResultSchema.parse({ status: "submitted" })).toEqual({ status: "submitted" });
        expect(CodexStructuredInputResponseResultSchema.parse({ status: "already-resolved" })).toEqual({ status: "already-resolved" });
        expect(CodexStructuredInputResponseResultSchema.safeParse({ status: "ok" }).success).toBe(false);
    });

    it("renders already-resolved as a locked amber non-success status without retry", () => {
        const markup = renderToStaticMarkup(React.createElement(StructuredResponseFeedback, {
            state: "expired",
            onRetry: () => undefined,
        }));

        expect(markup).toContain('role="status"');
        expect(markup).toContain('aria-live="polite"');
        expect(markup).toContain('aria-atomic="true"');
        expect(markup).toContain(`data-min-visible-ms="${STRUCTURED_ALREADY_RESOLVED_VISIBLE_MS}"`);
        expect(markup).toContain("Request is already closed in Codex. Response was not sent.");
        expect(markup).toContain("text-status-permission");
        expect(markup).toContain("duration-[var(--dur-std)]");
        expect(markup).toContain("motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both]");
        expect(markup).not.toContain("Response sent");
        expect(markup).not.toContain("Retry");
        expect(isStructuredResponseLocked("expired")).toBe(true);
    });

    it("keeps invalid submit and terminal controls inactive", () => {
        expect(renderCard(FIXTURE_STRUCTURED_REQUESTS["fx-structured-mcp-form"]))
            .toMatch(/<button type="button" disabled=""[^>]*>Submit<\/button>/);
        expect(isStructuredResponseLocked("idle")).toBe(false);
        expect(isStructuredResponseLocked("error")).toBe(false);
        expect(isStructuredResponseLocked("sending")).toBe(true);
        expect(isStructuredResponseLocked("resolved")).toBe(true);
    });

    it("blocks duplicate taps until the in-flight response releases the gate", () => {
        const gate = createStructuredResponseGate();
        expect(gate.tryAcquire()).toBe(true);
        expect(gate.tryAcquire()).toBe(false);
        gate.release();
        expect(gate.tryAcquire()).toBe(true);
    });
});
