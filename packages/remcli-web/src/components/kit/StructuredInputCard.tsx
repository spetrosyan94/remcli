import * as React from "react";
import { ExternalLink, Loader2, LockKeyhole } from "lucide-react";
import { t } from "@/lib/i18n";
import type {
    CodexStructuredInputResponse,
    CodexStructuredInputResponseResult,
    CodexStructuredInputUrlResult,
    CodexStructuredRequest,
    CodexStructuredStringFormat,
    StructuredInputField,
} from "@/lib/protocol/types";

export const STRUCTURED_SUCCESS_VISIBLE_MS = 1_800;
export const STRUCTURED_ALREADY_RESOLVED_VISIBLE_MS = 2_000;

type StructuredResponseState = "idle" | "sending" | "error" | "resolved" | "expired";
type McpUrlOpenState = "idle" | "loading" | "opened" | "popup-blocked" | "error";
type FieldValue = string | number | boolean | string[];
type FieldValues = Partial<Record<string, FieldValue>>;
type OtherValues = Partial<Record<string, string>>;

export interface StructuredFieldValueState {
    isPresent: boolean;
    value?: FieldValue;
    isOtherPresent?: boolean;
    otherValue?: string;
}

export function isStructuredResponseLocked(state: StructuredResponseState): boolean {
    return state === "sending" || state === "resolved" || state === "expired";
}

interface StructuredInputCardProps {
    request: CodexStructuredRequest;
    onResponse: (response: CodexStructuredInputResponse) => Promise<CodexStructuredInputResponseResult>;
    onOpenUrl: (requestKey: string) => Promise<CodexStructuredInputUrlResult>;
    terminalState?: Extract<StructuredResponseState, "expired">;
}

function hasOwn(record: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

export function createStructuredResponseGate() {
    let acquired = false;
    return {
        tryAcquire() {
            if (acquired) return false;
            acquired = true;
            return true;
        },
        release() {
            acquired = false;
        },
    };
}

function createSubmissionId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `structured-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function isSafeHttpsUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
    } catch {
        return false;
    }
}

export function isSafeDisplayUrl(value: string): boolean {
    if (!isSafeHttpsUrl(value)) return false;
    const url = new URL(value);
    return !url.search && !url.hash;
}

function padDateTimePart(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

export function rfc3339ToDateTimeLocal(value: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return value;
    const milliseconds = date.getMilliseconds();
    return `${padDateTimePart(date.getFullYear(), 4)}-${padDateTimePart(date.getMonth() + 1)}-${padDateTimePart(date.getDate())}`
        + `T${padDateTimePart(date.getHours())}:${padDateTimePart(date.getMinutes())}:${padDateTimePart(date.getSeconds())}`
        + (milliseconds === 0 ? "" : `.${padDateTimePart(milliseconds, 3)}`);
}

function dateTimeLocalValuesMatch(first: string, second: string): boolean {
    const firstTime = new Date(first).getTime();
    const secondTime = new Date(second).getTime();
    return Number.isFinite(firstTime) && Number.isFinite(secondTime) && firstTime === secondTime;
}

export function createInitialStructuredValues(fields: StructuredInputField[]): FieldValues {
    const values: FieldValues = {};
    for (const field of fields) {
        if (field.defaultValue !== undefined) {
            if (field.type === "text" && field.format === "date-time" && typeof field.defaultValue === "string" && field.defaultValue) {
                values[field.id] = rfc3339ToDateTimeLocal(field.defaultValue);
            } else {
                values[field.id] = Array.isArray(field.defaultValue) ? [...field.defaultValue] : field.defaultValue;
            }
        }
    }
    return values;
}

function fieldState(field: StructuredInputField, values: FieldValues, otherValues: OtherValues): StructuredFieldValueState {
    return {
        isPresent: hasOwn(values, field.id),
        value: values[field.id],
        isOtherPresent: hasOwn(otherValues, field.id),
        otherValue: otherValues[field.id],
    };
}

function isValidDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidDateTimeLocal(value: string): boolean {
    const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.exec(value);
    return Boolean(match && isValidDate(match[1]));
}

function isValidStringFormat(format: CodexStructuredStringFormat | undefined, value: string): boolean {
    if (!format || value.length === 0) return true;
    if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (format === "date") return isValidDate(value);
    if (format === "date-time") return isValidDateTimeLocal(value);
    try {
        return Boolean(new URL(value).protocol);
    } catch {
        return false;
    }
}

function effectiveSelectValue(field: StructuredInputField, state: StructuredFieldValueState): string | undefined {
    if (field.allowOther && state.isOtherPresent) return state.otherValue;
    return state.isPresent && typeof state.value === "string" ? state.value : undefined;
}

function effectiveMultiselectValues(field: StructuredInputField, state: StructuredFieldValueState): string[] {
    const values = state.isPresent && Array.isArray(state.value) ? [...state.value] : [];
    if (field.allowOther && state.isOtherPresent && state.otherValue !== undefined) values.push(state.otherValue);
    return values;
}

export function structuredFieldIsValid(field: StructuredInputField, state: StructuredFieldValueState): boolean {
    if (field.type === "boolean") {
        if (!state.isPresent) return !field.required;
        return typeof state.value === "boolean";
    }

    if (field.type === "multiselect") {
        const isPresent = state.isPresent || Boolean(state.isOtherPresent);
        if (!isPresent) return !field.required;
        const values = effectiveMultiselectValues(field, state);
        if (state.isOtherPresent && !state.otherValue?.trim()) return false;
        if (field.required && values.length === 0) return false;
        if (field.minItems !== undefined && values.length < field.minItems) return false;
        if (field.maxItems !== undefined && values.length > field.maxItems) return false;
        if (new Set(values).size !== values.length) return false;
        return values.every((entry) =>
            (field.options ?? []).some((option) => option.value === entry)
            || (field.allowOther === true && state.isOtherPresent && entry === state.otherValue),
        );
    }

    if (field.type === "number" || field.type === "integer") {
        if (!state.isPresent) return !field.required;
        if (state.value === "" || (typeof state.value !== "string" && typeof state.value !== "number")) return false;
        const numberValue = typeof state.value === "number" ? state.value : Number(state.value);
        if (!Number.isFinite(numberValue)) return false;
        if (field.type === "integer" && !Number.isInteger(numberValue)) return false;
        if (field.minimum !== undefined && numberValue < field.minimum) return false;
        if (field.maximum !== undefined && numberValue > field.maximum) return false;
        return true;
    }

    if (field.type === "select") {
        const value = effectiveSelectValue(field, state);
        if (value === undefined) return !field.required;
        if (state.isOtherPresent) return field.allowOther === true && value.trim().length > 0;
        return (field.options ?? []).some((option) => option.value === value);
    }

    if (!state.isPresent) return !field.required;
    if (typeof state.value !== "string") return false;
    if (field.minLength !== undefined && state.value.length < field.minLength) return false;
    if (field.maxLength !== undefined && state.value.length > field.maxLength) return false;
    return isValidStringFormat(field.format, state.value);
}

export function structuredToolAnswers(fields: StructuredInputField[], values: FieldValues, otherValues: OtherValues): Record<string, string[]> {
    return Object.fromEntries(fields.map((field) => {
        const state = fieldState(field, values, otherValues);
        if (field.type === "select") return [field.id, [effectiveSelectValue(field, state) ?? ""]];
        if (field.type === "multiselect") return [field.id, effectiveMultiselectValues(field, state)];
        if (field.type === "boolean") return [field.id, [String(state.value)]];
        return [field.id, [state.value === undefined ? "" : String(state.value)]];
    }));
}

export function structuredFormContent(fields: StructuredInputField[], values: FieldValues, otherValues: OtherValues): Record<string, unknown> {
    const content: Record<string, unknown> = {};
    for (const field of fields) {
        const state = fieldState(field, values, otherValues);
        if (!state.isPresent && !state.isOtherPresent) continue;
        if (field.type === "multiselect") content[field.id] = effectiveMultiselectValues(field, state);
        else if (field.type === "select") content[field.id] = effectiveSelectValue(field, state);
        else if (field.type === "number" || field.type === "integer") content[field.id] = Number(state.value);
        else if (field.type === "text" && field.format === "date-time" && typeof state.value === "string" && state.value) {
            const defaultValue = typeof field.defaultValue === "string" ? field.defaultValue : undefined;
            content[field.id] = defaultValue && dateTimeLocalValuesMatch(rfc3339ToDateTimeLocal(defaultValue), state.value)
                ? new Date(defaultValue).toISOString()
                : new Date(state.value).toISOString();
        } else content[field.id] = state.value;
    }
    return content;
}

export function openStructuredUrlPlaceholder(
    openWindow: (url: string, target: string) => Window | null = (url, target) => window.open(url, target),
): Window | null {
    const popup = openWindow("about:blank", "_blank");
    if (!popup) return null;
    try {
        popup.opener = null;
    } catch {
        // Cross-origin WindowProxy may reject the assignment; opening still succeeded.
    }
    return popup;
}

export function navigateValidatedStructuredUrl(popup: Window, value: string): void {
    if (!isSafeHttpsUrl(value)) throw new Error("Unsafe structured input URL");
    popup.location.replace(value);
}

export function StructuredResponseFeedback({ state, onRetry }: { state: StructuredResponseState; onRetry: () => void }) {
    if (state === "sending") {
        return <div role="status" aria-live="polite" className="flex min-h-10 animate-in fade-in items-center gap-2 border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both] motion-reduce:transform-none"><Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /><span>{t("structured.sending")}</span></div>;
    }
    if (state === "error") {
        return <div role="alert" aria-live="assertive" className="flex min-h-11 animate-in fade-in items-center gap-2 border-t border-status-error/25 px-3 py-2 font-mono text-[11px] text-status-error duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both] motion-reduce:transform-none"><span className="min-w-0 flex-1 break-words">{t("structured.responseFailed")}</span><button type="button" onClick={onRetry} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-status-error/45 px-2.5 font-mono text-[10.5px] font-semibold transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:bg-status-error/10 active:scale-[0.96] motion-reduce:active:scale-100">{t("structured.retry")}</button></div>;
    }
    if (state === "resolved") {
        return <div role="status" aria-live="polite" data-min-visible-ms={STRUCTURED_SUCCESS_VISIBLE_MS} className="border-t border-border px-3 py-2 font-mono text-[11px] text-status-success animate-in fade-in duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both] motion-reduce:transform-none">{t("structured.responseSent")}</div>;
    }
    if (state === "expired") {
        return <div role="status" aria-live="polite" aria-atomic="true" data-min-visible-ms={STRUCTURED_ALREADY_RESOLVED_VISIBLE_MS} className="animate-in fade-in border-t border-status-permission/25 px-3 py-2 font-mono text-[11px] text-status-permission duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both] motion-reduce:transform-none">{t("structured.alreadyResolved")}</div>;
    }
    return null;
}

function ActionRow({ submitLabel, isLocked, isSubmitDisabled, onSubmit, onDecline, onCancel }: { submitLabel: string; isLocked: boolean; isSubmitDisabled: boolean; onSubmit: () => void; onDecline: () => void; onCancel: () => void }) {
    return <div className="flex flex-wrap gap-2 border-t border-border px-3 py-3">
        <button type="button" onClick={onSubmit} disabled={isLocked || isSubmitDisabled} className="min-h-11 min-w-[8rem] flex-1 rounded-[9px] bg-accent px-3 text-[13px] font-semibold text-accent-foreground transition-[background-color,opacity,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100">{submitLabel}</button>
        <button type="button" onClick={onDecline} disabled={isLocked} className="min-h-11 rounded-[9px] border border-border px-3 text-[12px] font-medium text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:bg-muted hover:text-foreground active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100">{t("structured.decline")}</button>
        <button type="button" onClick={onCancel} disabled={isLocked} className="min-h-11 rounded-[9px] px-3 text-[12px] font-medium text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:bg-muted hover:text-foreground active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100">{t("structured.cancel")}</button>
    </div>;
}

function inputTypeForField(field: StructuredInputField): React.HTMLInputTypeAttribute {
    if (field.isSecret) return "password";
    if (field.type === "number" || field.type === "integer") return "number";
    if (field.format === "email") return "email";
    if (field.format === "uri") return "url";
    if (field.format === "date") return "date";
    if (field.format === "date-time") return "datetime-local";
    return "text";
}

function FieldControl({ requestKey, field, state, disabled, onChange, onOtherChange }: { requestKey: string; field: StructuredInputField; state: StructuredFieldValueState; disabled: boolean; onChange: (value: FieldValue | undefined) => void; onOtherChange: (value: string | undefined) => void }) {
    const fieldId = `structured-${requestKey}-${field.id}`;
    const descriptionId = field.description ? `${fieldId}-description` : undefined;
    const isValid = structuredFieldIsValid(field, state);
    const inputClass = "min-h-11 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-[12px] outline-none transition-[border-color,box-shadow] duration-[var(--dur-micro)] ease-[var(--ease-out)] placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-status-error";
    const currentValues = field.type === "multiselect" && Array.isArray(state.value) ? state.value : [];
    const isSelected = (optionValue: string) => field.type === "multiselect" ? currentValues.includes(optionValue) : !state.isOtherPresent && state.value === optionValue;
    const toggleOption = (optionValue: string) => {
        if (field.type === "multiselect") onChange(currentValues.includes(optionValue) ? currentValues.filter((entry) => entry !== optionValue) : [...currentValues, optionValue]);
        else { onOtherChange(undefined); onChange(optionValue); }
    };

    return <fieldset data-structured-field={field.id} data-field-type={field.type} aria-invalid={!isValid} disabled={disabled} className="min-w-0 space-y-2">
        <legend className="max-w-full break-words text-[13px] font-medium text-foreground">{field.label}{field.required && <span className="ml-1 text-status-error" aria-hidden="true">*</span>}</legend>
        {field.description && <p id={descriptionId} className="break-words text-[11px] leading-relaxed text-muted-foreground">{field.description}</p>}

        {field.type === "boolean" && <>
            <p data-boolean-state className="font-mono text-[10px] text-muted-foreground">{state.isPresent ? t(state.value === true ? "structured.yes" : "structured.no") : t("structured.notSelected")}</p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
                {[true, false].map((option) => <label key={String(option)} className="flex min-h-11 min-w-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12px] transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease-out)] has-[:focus-visible]:border-accent has-[:checked]:border-status-thinking/55 has-[:checked]:bg-status-thinking/[0.08]">
                    <input type="radio" name={fieldId} value={String(option)} checked={state.isPresent && state.value === option} onChange={() => onChange(option)} required={field.required} aria-describedby={descriptionId} className="size-4 shrink-0 accent-[hsl(var(--status-thinking))]" />
                    <span>{t(option ? "structured.yes" : "structured.no")}</span>
                </label>)}
            </div>
        </>}

        {(field.type === "select" || field.type === "multiselect") && <div className="space-y-1" role={field.type === "select" ? "radiogroup" : undefined} aria-label={field.label} aria-invalid={!isValid}>
            {(field.options ?? []).map((option) => <label key={option.value} className="flex min-h-11 min-w-0 cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease-out)] has-[:focus-visible]:border-accent has-[:checked]:border-status-thinking/55 has-[:checked]:bg-status-thinking/[0.08]">
                <input type={field.type === "select" ? "radio" : "checkbox"} name={field.type === "select" ? fieldId : `${fieldId}-${option.value}`} value={option.value} checked={isSelected(option.value)} onChange={() => toggleOption(option.value)} required={field.type === "select" && field.required} aria-describedby={descriptionId} className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--status-thinking))]" />
                <span className="min-w-0 flex-1"><span className="block break-words text-[12px] text-foreground">{option.label}</span>{option.description && <span className="mt-0.5 block break-words text-[10px] text-muted-foreground">{option.description}</span>}</span>
            </label>)}
            {field.allowOther && <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12px] transition-[background-color,border-color] duration-[var(--dur-micro)] ease-[var(--ease-out)] has-[:focus-visible]:border-accent has-[:checked]:border-status-thinking/55 has-[:checked]:bg-status-thinking/[0.08]">
                <input type={field.type === "select" ? "radio" : "checkbox"} name={field.type === "select" ? fieldId : `${fieldId}-other-choice`} checked={Boolean(state.isOtherPresent)} onChange={(event) => { if (field.type === "select") onChange(undefined); onOtherChange(event.target.checked ? "" : undefined); }} required={field.type === "select" && field.required} className="size-4 shrink-0 accent-[hsl(var(--status-thinking))]" />
                <span>{t("structured.other")}</span>
            </label>}
        </div>}

        {(field.type === "select" || field.type === "multiselect") && field.allowOther && state.isOtherPresent && <label className="block min-w-0"><span className="sr-only">{t("structured.other")}</span><input id={`${fieldId}-other`} type="text" value={state.otherValue ?? ""} onChange={(event) => onOtherChange(event.target.value)} placeholder={t("structured.otherPlaceholder")} required aria-invalid={!state.otherValue?.trim()} aria-describedby={descriptionId} className={inputClass} /></label>}

        {field.type !== "boolean" && field.type !== "select" && field.type !== "multiselect" && <label className="relative block min-w-0">
            <span className="sr-only">{field.label}</span>
            <input id={fieldId} type={inputTypeForField(field)} value={state.isPresent && (typeof state.value === "string" || typeof state.value === "number") ? String(state.value) : ""} onChange={(event) => onChange((field.type === "number" || field.type === "integer") && event.target.value === "" ? undefined : event.target.value)} autoComplete={field.isSecret ? "off" : field.format === "email" ? "email" : undefined} min={field.minimum} max={field.maximum} minLength={field.minLength} maxLength={field.maxLength} step={field.type === "integer" ? 1 : field.type === "number" ? "any" : undefined} required={field.required && (field.minLength ?? 0) > 0} aria-required={field.required} aria-invalid={!isValid} aria-describedby={descriptionId} className={`${inputClass}${field.isSecret ? " pr-9" : ""}`} />
            {field.isSecret && <LockKeyhole className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />}
        </label>}
    </fieldset>;
}

function StructuredFieldsCard({ request, onResponse, terminalState }: Pick<StructuredInputCardProps, "request" | "onResponse" | "terminalState">) {
    const [values, setValues] = React.useState<FieldValues>(() => createInitialStructuredValues(request.fields));
    const [otherValues, setOtherValues] = React.useState<OtherValues>({});
    const [state, setState] = React.useState<StructuredResponseState>("idle");
    const submissionIdRef = React.useRef(createSubmissionId());
    const submitGateRef = React.useRef(createStructuredResponseGate());
    const lastActionRef = React.useRef<CodexStructuredInputResponse["action"]>("submit");
    const responseState = terminalState ?? state;
    const isLocked = isStructuredResponseLocked(responseState);
    const canSubmit = request.fields.every((field) => structuredFieldIsValid(field, fieldState(field, values, otherValues)));

    const respond = React.useCallback(async (action: CodexStructuredInputResponse["action"]) => {
        if (isLocked || (action === "submit" && !canSubmit) || !submitGateRef.current.tryAcquire()) return;
        lastActionRef.current = action;
        setState("sending");
        const response: CodexStructuredInputResponse = {
            requestKey: request.requestKey,
            submissionId: submissionIdRef.current,
            action,
            ...(action === "submit" && request.kind === "tool-input" ? { answers: structuredToolAnswers(request.fields, values, otherValues) } : {}),
            ...(action === "submit" && request.kind === "mcp-form" ? { content: structuredFormContent(request.fields, values, otherValues) } : {}),
        };
        try {
            const result = await onResponse(response);
            setValues({});
            setOtherValues({});
            setState(result.status === "already-resolved" ? "expired" : "resolved");
        } catch {
            setState("error");
        } finally {
            submitGateRef.current.release();
        }
    }, [canSubmit, isLocked, onResponse, otherValues, request, values]);

    const updateValue = (fieldId: string, value: FieldValue | undefined) => setValues((current) => { const next = { ...current }; if (value === undefined) delete next[fieldId]; else next[fieldId] = value; return next; });
    const updateOther = (fieldId: string, value: string | undefined) => setOtherValues((current) => { const next = { ...current }; if (value === undefined) delete next[fieldId]; else next[fieldId] = value; return next; });

    return <section aria-busy={responseState === "sending" || undefined} data-structured-input-card data-structured-request-key={request.requestKey} data-structured-kind={request.kind} data-structured-response-state={responseState} className={`overflow-hidden rounded-xl border shadow-lg shadow-black/5 transition-[background-color,border-color,box-shadow] duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:transition-opacity motion-reduce:duration-[var(--dur-micro)] ${responseState === "expired" ? "border-status-permission/40 bg-status-permission/[0.06]" : "border-status-thinking/35 bg-status-thinking/[0.05]"}`}>
        <div className="flex items-start gap-2 border-b border-status-thinking/20 px-3 py-2.5"><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-status-thinking" aria-hidden="true" /><div className="min-w-0 flex-1"><h2 className="break-words font-mono text-[11px] font-semibold text-status-thinking">{request.kind === "mcp-form" ? t("structured.formTitle") : t("structured.userInputTitle")}</h2><p className="mt-1 break-words text-[12px] leading-relaxed text-foreground/85">{request.message}</p></div>{request.isBlocking && <span className="shrink-0 font-mono text-[9px] text-status-thinking">{t("structured.blocking")}</span>}</div>
        <form onSubmit={(event) => { event.preventDefault(); void respond("submit"); }} className="space-y-3 px-3 py-3">
            {request.fields.map((field) => <FieldControl key={field.id} requestKey={request.requestKey} field={field} state={fieldState(field, values, otherValues)} disabled={isLocked} onChange={(value) => updateValue(field.id, value)} onOtherChange={(value) => updateOther(field.id, value)} />)}
            {!canSubmit && <p className="font-mono text-[10px] text-muted-foreground">{t("structured.questionRequired")}</p>}
        </form>
        <ActionRow submitLabel={t("structured.submit")} isLocked={isLocked} isSubmitDisabled={!canSubmit} onSubmit={() => void respond("submit")} onDecline={() => void respond("decline")} onCancel={() => void respond("cancel")} />
        <StructuredResponseFeedback state={responseState} onRetry={() => void respond(lastActionRef.current)} />
    </section>;
}

function McpUrlCard({ request, onResponse, onOpenUrl, terminalState }: StructuredInputCardProps) {
    const [state, setState] = React.useState<StructuredResponseState>("idle");
    const [urlOpenState, setUrlOpenState] = React.useState<McpUrlOpenState>("idle");
    const submissionIdRef = React.useRef(createSubmissionId());
    const submitGateRef = React.useRef(createStructuredResponseGate());
    const openGateRef = React.useRef(createStructuredResponseGate());
    const lastActionRef = React.useRef<CodexStructuredInputResponse["action"]>("submit");
    const responseState = terminalState ?? state;
    const isLocked = isStructuredResponseLocked(responseState);
    const canOpen = typeof request.displayUrl === "string" && isSafeDisplayUrl(request.displayUrl);

    const openUrl = () => {
        if (!canOpen || isLocked || !openGateRef.current.tryAcquire()) return;
        const popup = openStructuredUrlPlaceholder();
        if (!popup) {
            setUrlOpenState("popup-blocked");
            openGateRef.current.release();
            return;
        }
        setUrlOpenState("loading");
        void onOpenUrl(request.requestKey)
            .then((result) => {
                navigateValidatedStructuredUrl(popup, result.url);
                setUrlOpenState("opened");
            })
            .catch(() => {
                try { popup.close(); } catch { /* WindowProxy may already be unavailable. */ }
                setUrlOpenState("error");
            })
            .finally(() => openGateRef.current.release());
    };

    const respond = React.useCallback(async (action: CodexStructuredInputResponse["action"]) => {
        if (isLocked || (action === "submit" && urlOpenState !== "opened") || !submitGateRef.current.tryAcquire()) return;
        lastActionRef.current = action;
        setState("sending");
        try {
            const result = await onResponse({ requestKey: request.requestKey, submissionId: submissionIdRef.current, action });
            setState(result.status === "already-resolved" ? "expired" : "resolved");
        } catch {
            setState("error");
        } finally {
            submitGateRef.current.release();
        }
    }, [isLocked, onResponse, request.requestKey, urlOpenState]);

    const openStatus = urlOpenState === "opened" ? t("structured.urlOpened") : urlOpenState === "popup-blocked" ? t("structured.urlPopupBlocked") : urlOpenState === "error" ? t("structured.urlOpenFailed") : urlOpenState === "loading" ? t("structured.urlLoading") : null;

    return <section aria-busy={responseState === "sending" || urlOpenState === "loading" || undefined} data-structured-input-card data-structured-request-key={request.requestKey} data-structured-kind="mcp-url" data-structured-response-state={responseState} className="overflow-hidden rounded-xl border border-status-permission/35 bg-status-permission/[0.05] shadow-lg shadow-black/5 transition-[background-color,border-color,box-shadow] duration-[var(--dur-std)] ease-[var(--ease-out)] motion-reduce:transition-opacity motion-reduce:duration-[var(--dur-micro)]">
        <div className="flex items-start gap-2 border-b border-status-permission/20 px-3 py-2.5"><ExternalLink className="mt-0.5 size-4 shrink-0 text-status-permission" aria-hidden="true" /><div className="min-w-0 flex-1"><h2 className="break-words font-mono text-[11px] font-semibold text-status-permission">{request.serverName ?? t("structured.urlTitle")}</h2><p className="mt-1 break-words text-[12px] leading-relaxed text-foreground/85">{request.message || t("structured.urlHint")}</p></div>{request.isBlocking && <span className="shrink-0 font-mono text-[9px] text-status-permission">{t("structured.blocking")}</span>}</div>
        <div className="space-y-2 px-3 py-3">
            <p className="text-[11px] text-muted-foreground">{t("structured.urlDestination")}</p>
            <code className="block min-w-0 break-all rounded-lg border border-border bg-background px-2.5 py-2 text-[11px] text-foreground">{request.displayUrl}</code>
            <button type="button" onClick={openUrl} disabled={!canOpen || isLocked || urlOpenState === "loading"} className="inline-flex min-h-11 w-full min-w-0 items-center justify-center gap-2 rounded-[9px] border border-status-permission/40 px-3 text-[12px] font-medium text-status-permission transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:bg-status-permission/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100">{urlOpenState === "loading" ? <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />}{urlOpenState === "popup-blocked" || urlOpenState === "error" ? t("structured.urlRetry") : t("structured.urlOpen")}</button>
            {openStatus && <p role={urlOpenState === "popup-blocked" || urlOpenState === "error" ? "alert" : "status"} aria-live={urlOpenState === "popup-blocked" || urlOpenState === "error" ? "assertive" : "polite"} data-mcp-url-open-state={urlOpenState} className="animate-in fade-in break-words font-mono text-[10px] text-muted-foreground duration-[var(--dur-micro)] ease-[var(--ease-out)] motion-reduce:animate-[remcli-reduced-fade-in_var(--dur-micro)_var(--ease-out)_both] motion-reduce:transform-none">{openStatus}</p>}
        </div>
        <ActionRow submitLabel={t("structured.accept")} isLocked={isLocked} isSubmitDisabled={urlOpenState !== "opened"} onSubmit={() => void respond("submit")} onDecline={() => void respond("decline")} onCancel={() => void respond("cancel")} />
        <StructuredResponseFeedback state={responseState} onRetry={() => void respond(lastActionRef.current)} />
    </section>;
}

export function StructuredInputCard({ request, onResponse, onOpenUrl, terminalState }: StructuredInputCardProps) {
    if (request.kind === "mcp-url") return <McpUrlCard request={request} onResponse={onResponse} onOpenUrl={onOpenUrl} terminalState={terminalState} />;
    return <StructuredFieldsCard request={request} onResponse={onResponse} terminalState={terminalState} />;
}

export type { FieldValue, FieldValues, McpUrlOpenState, StructuredInputCardProps, StructuredResponseState };
