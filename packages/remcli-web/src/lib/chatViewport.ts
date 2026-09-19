import * as React from "react";

export type ChatViewportMode = "follow-bottom" | "detached" | "structured-anchor";

export interface ChatViewportMetrics {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    threshold?: number;
}

export interface StructuredAnchorGeometry {
    feedTop: number;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    cardTop: number;
    cardHeight: number;
    inset?: number;
}

export interface StructuredAnchorTarget {
    top: number;
    extraBottom: number;
}

export interface StructuredAnchorSessionGuard {
    sessionId: string | null;
    structuredAnchorKey: string | null;
    contentVersion: string;
}

export function chatViewportModeForScroll({ scrollTop, scrollHeight, clientHeight, threshold = 120 }: ChatViewportMetrics): ChatViewportMode {
    return scrollHeight - scrollTop - clientHeight < threshold ? "follow-bottom" : "detached";
}

export function chatViewportModeAfterScroll(
    mode: ChatViewportMode,
    metrics: ChatViewportMetrics,
    userScrollProduced: boolean,
    structuredAnchorTop: number | null = null,
): ChatViewportMode {
    if (
        mode === "structured-anchor"
        && !userScrollProduced
        && (structuredAnchorTop === null || isScrollNearTarget(metrics.scrollTop, structuredAnchorTop))
    ) return mode;
    return chatViewportModeForScroll(metrics);
}

export function chatViewportModeAfterAnchorMeasurement(
    mode: ChatViewportMode,
    metrics: ChatViewportMetrics,
    target: StructuredAnchorTarget | null,
): ChatViewportMode {
    if (mode === "structured-anchor" && target === null) return chatViewportModeForScroll(metrics);
    return mode;
}

export function shouldBlockStructuredAnchor(
    guard: StructuredAnchorSessionGuard | null,
    current: StructuredAnchorSessionGuard,
): boolean {
    return guard !== null
        && guard.sessionId === current.sessionId
        && guard.structuredAnchorKey === current.structuredAnchorKey
        && guard.contentVersion === current.contentVersion;
}

export function preserveScrollPositionAfterPrepend(beforeHeight: number, beforeTop: number, afterHeight: number): number {
    return afterHeight - beforeHeight + beforeTop;
}

export function scrollBehaviorForMotion(prefersReducedMotion: boolean): ScrollBehavior {
    return prefersReducedMotion ? "auto" : "smooth";
}

export function contentRevisionOf(value: unknown): string {
    return JSON.stringify(value);
}

export function isScrollNearTarget(scrollTop: number, target: number, tolerance = 2): boolean {
    return Math.abs(scrollTop - target) <= tolerance;
}

export function viewportAnchorIdentity(sessionId: string, requestKey: string): string {
    return `${sessionId}:${requestKey}`;
}

export function structuredAnchorTarget({
    feedTop,
    scrollTop,
    scrollHeight,
    clientHeight,
    cardTop,
    cardHeight,
    inset = 14,
}: StructuredAnchorGeometry): StructuredAnchorTarget | null {
    if (cardHeight * 2 <= clientHeight) return null;

    const desiredTop = Math.max(0, scrollTop + cardTop - feedTop - inset);
    const currentMaxScrollTop = Math.max(0, scrollHeight - clientHeight);
    const extraBottom = Math.max(0, desiredTop - currentMaxScrollTop);
    return { top: desiredTop, extraBottom };
}

interface ChatViewportOptions {
    sessionId: string | null;
    contentVersion: string;
    structuredAnchorKey: string | null;
    onNearTop?: () => void;
}

interface ProgrammaticScroll {
    mode: ChatViewportMode;
    target: number;
}

interface PendingUserScroll {
    startTop: number;
    direction?: number;
}

const EXTRA_BOTTOM_VARIABLE = "--chat-viewport-extra-bottom";

function isEditableTarget(target: EventTarget | null): boolean {
    return typeof HTMLElement !== "undefined" && target instanceof HTMLElement && (
        target.isContentEditable
        || (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement)
        || (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement)
        || (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement)
    );
}

function isFormControlTarget(target: EventTarget | null): boolean {
    if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
    return isEditableTarget(target)
        || (typeof HTMLButtonElement !== "undefined" && target instanceof HTMLButtonElement)
        || (typeof HTMLOptionElement !== "undefined" && target instanceof HTMLOptionElement);
}

function isScrollbarPointerDown(event: Event, node: HTMLElement): boolean {
    if (event.target !== node || !("clientX" in event)) return false;
    const clientX = (event as PointerEvent).clientX;
    const rect = node.getBoundingClientRect();
    const scrollbarWidth = Math.max(12, node.offsetWidth - node.clientWidth);
    return clientX >= rect.right - scrollbarWidth;
}

export function isUserScrollIntent(event: Event): boolean {
    if (event.type === "wheel" || event.type === "touchstart") return true;
    if (event.type === "pointerdown") return !isFormControlTarget(event.target);
    if (event.type !== "keydown" || isEditableTarget(event.target)) return false;
    const key = (event as KeyboardEvent).key;
    return [
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "End",
        "Home",
        "PageDown",
        "PageUp",
        " ",
    ].includes(key);
}

export function useChatViewport(
    feedRef: React.RefObject<HTMLElement | null>,
    { sessionId, contentVersion, structuredAnchorKey, onNearTop }: ChatViewportOptions,
) {
    const [mode, setMode] = React.useState<ChatViewportMode>("follow-bottom");
    const modeRef = React.useRef<ChatViewportMode>("follow-bottom");
    const previousSessionIdRef = React.useRef(sessionId);
    const sessionAnchorGuardRef = React.useRef<StructuredAnchorSessionGuard | null>(null);
    const anchorIdentityRef = React.useRef<string | null>(null);
    const structuredAnchorTopRef = React.useRef<number | null>(null);
    const programmaticScrollRef = React.useRef<ProgrammaticScroll | null>(null);
    const pendingUserScrollRef = React.useRef<PendingUserScroll | null>(null);

    const setViewportMode = React.useCallback((nextMode: ChatViewportMode) => {
        modeRef.current = nextMode;
        setMode(nextMode);
    }, []);

    const prefersReducedMotion = React.useCallback(() => (
        typeof window !== "undefined"
            && typeof window.matchMedia === "function"
            && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ), []);

    const clearTemporarySpace = React.useCallback(() => {
        feedRef.current?.style.removeProperty(EXTRA_BOTTOM_VARIABLE);
    }, [feedRef]);

    const finishProgrammaticScroll = React.useCallback(() => {
        const node = feedRef.current;
        const transition = programmaticScrollRef.current;
        if (!node || !transition || !isScrollNearTarget(node.scrollTop, transition.target)) return;
        programmaticScrollRef.current = null;
        setViewportMode(transition.mode);
    }, [feedRef, setViewportMode]);

    const handleScrollEnd = React.useCallback(() => {
        const node = feedRef.current;
        const transition = programmaticScrollRef.current;
        if (!node || !transition) return;
        if (isScrollNearTarget(node.scrollTop, transition.target)) {
            finishProgrammaticScroll();
            return;
        }
        programmaticScrollRef.current = null;
        if (transition.mode === "structured-anchor") {
            structuredAnchorTopRef.current = null;
            clearTemporarySpace();
        }
        setViewportMode(chatViewportModeAfterScroll(
            transition.mode,
            node,
            false,
            transition.mode === "structured-anchor" ? transition.target : null,
        ));
    }, [clearTemporarySpace, feedRef, finishProgrammaticScroll, setViewportMode]);

    const cancelProgrammaticScroll = React.useCallback(() => {
        const node = feedRef.current;
        if (!node) return;
        programmaticScrollRef.current = null;
        clearTemporarySpace();
        setViewportMode(chatViewportModeForScroll(node));
    }, [clearTemporarySpace, feedRef, setViewportMode]);

    const exitStructuredAnchor = React.useCallback(() => {
        const node = feedRef.current;
        if (!node || modeRef.current !== "structured-anchor") return;
        pendingUserScrollRef.current = null;
        programmaticScrollRef.current = null;
        structuredAnchorTopRef.current = null;
        clearTemporarySpace();
        setViewportMode(chatViewportModeForScroll(node));
    }, [clearTemporarySpace, feedRef, setViewportMode]);

    const startProgrammaticScroll = React.useCallback((target: number, nextMode: ChatViewportMode) => {
        const node = feedRef.current;
        if (!node) return;
        const behavior = scrollBehaviorForMotion(prefersReducedMotion());
        // Keep the transition marker through the synchronous auto-scroll event too;
        // otherwise the structured-anchor mode is immediately classified as bottom-follow.
        programmaticScrollRef.current = { mode: nextMode, target };
        setViewportMode(nextMode);
        node.scrollTo({ top: target, behavior });
        if (behavior === "auto") finishProgrammaticScroll();
    }, [finishProgrammaticScroll, feedRef, prefersReducedMotion, setViewportMode]);

    const scrollToEnd = React.useCallback(() => {
        const node = feedRef.current;
        if (!node) return;
        pendingUserScrollRef.current = null;
        structuredAnchorTopRef.current = null;
        clearTemporarySpace();
        startProgrammaticScroll(Math.max(0, node.scrollHeight - node.clientHeight), "follow-bottom");
    }, [clearTemporarySpace, feedRef, startProgrammaticScroll]);

    const handleScroll = React.useCallback(() => {
        const node = feedRef.current;
        if (!node) return;
        const pendingUserScroll = pendingUserScrollRef.current;
        const didUserScroll = pendingUserScroll !== null
            && Math.abs(node.scrollTop - pendingUserScroll.startTop) > 0.5
            && (pendingUserScroll.direction === undefined
                || Math.sign(node.scrollTop - pendingUserScroll.startTop) === Math.sign(pendingUserScroll.direction));
        if (didUserScroll) {
            pendingUserScrollRef.current = null;
            if (modeRef.current === "structured-anchor") {
                exitStructuredAnchor();
                return;
            }
            cancelProgrammaticScroll();
        }
        if (programmaticScrollRef.current) {
            finishProgrammaticScroll();
            // Do not reclassify the same programmatic commit as bottom-follow after
            // it reaches its target; intermediate events remain attached as well.
            return;
        }
        if (modeRef.current === "structured-anchor") {
            const nextMode = chatViewportModeAfterScroll(
                modeRef.current,
                node,
                false,
                structuredAnchorTopRef.current,
            );
            if (nextMode !== "structured-anchor") {
                exitStructuredAnchor();
                return;
            }
            if (node.scrollTop < 60) onNearTop?.();
            return;
        }
        const nextMode = chatViewportModeAfterScroll(modeRef.current, node, false);
        setViewportMode(nextMode);
        if (node.scrollTop < 60) onNearTop?.();
    }, [cancelProgrammaticScroll, exitStructuredAnchor, feedRef, finishProgrammaticScroll, onNearTop, setViewportMode]);

    React.useEffect(() => {
        const node = feedRef.current;
        if (!node) return;
        const onScrollEnd = () => handleScrollEnd();
        node.addEventListener("scrollend", onScrollEnd);
        return () => node.removeEventListener("scrollend", onScrollEnd);
    }, [feedRef, handleScrollEnd]);

    React.useEffect(() => {
        const node = feedRef.current;
        if (!node) return;
        const onUserScrollIntent = (event: Event) => {
            if (event.type === "pointerdown" && !isScrollbarPointerDown(event, node)) return;
            if (!isUserScrollIntent(event)) return;
            const direction = event.type === "wheel" ? (event as WheelEvent).deltaY : undefined;
            pendingUserScrollRef.current = { startTop: node.scrollTop, direction };
        };
        const options: AddEventListenerOptions = { passive: true };
        node.addEventListener("wheel", onUserScrollIntent, options);
        node.addEventListener("touchstart", onUserScrollIntent, options);
        node.addEventListener("pointerdown", onUserScrollIntent, options);
        node.addEventListener("keydown", onUserScrollIntent);
        return () => {
            node.removeEventListener("wheel", onUserScrollIntent);
            node.removeEventListener("touchstart", onUserScrollIntent);
            node.removeEventListener("pointerdown", onUserScrollIntent);
            node.removeEventListener("keydown", onUserScrollIntent);
        };
    }, [feedRef]);

    React.useLayoutEffect(() => {
        const previousSessionId = previousSessionIdRef.current;
        if (previousSessionId !== sessionId && previousSessionId !== null) {
            sessionAnchorGuardRef.current = { sessionId, structuredAnchorKey, contentVersion };
        }
        previousSessionIdRef.current = sessionId;
        programmaticScrollRef.current = null;
        pendingUserScrollRef.current = null;
        anchorIdentityRef.current = null;
        structuredAnchorTopRef.current = null;
        clearTemporarySpace();
        setViewportMode("follow-bottom");
    }, [clearTemporarySpace, sessionId, setViewportMode]);

    React.useLayoutEffect(() => {
        if (!structuredAnchorKey || !sessionId) {
            sessionAnchorGuardRef.current = null;
            anchorIdentityRef.current = null;
            structuredAnchorTopRef.current = null;
            clearTemporarySpace();
            if (modeRef.current === "structured-anchor") {
                const node = feedRef.current;
                if (node) setViewportMode(chatViewportModeForScroll(node));
            }
            return;
        }

        const currentSessionAnchor = { sessionId, structuredAnchorKey, contentVersion };
        if (shouldBlockStructuredAnchor(sessionAnchorGuardRef.current, currentSessionAnchor)) return;
        sessionAnchorGuardRef.current = null;

        const identity = viewportAnchorIdentity(sessionId, structuredAnchorKey);
        if (anchorIdentityRef.current === identity) return;
        clearTemporarySpace();
        const node = feedRef.current;
        const anchor = node
            ? [...node.querySelectorAll<HTMLElement>("[data-structured-request-key]")]
                .find((candidate) => candidate.dataset.structuredRequestKey === structuredAnchorKey)
            : undefined;
        if (!node || !anchor) return;

        const geometry = structuredAnchorTarget({
            feedTop: node.getBoundingClientRect().top,
            scrollTop: node.scrollTop,
            scrollHeight: node.scrollHeight,
            clientHeight: node.clientHeight,
            cardTop: anchor.getBoundingClientRect().top,
            cardHeight: anchor.offsetHeight,
        });
        if (!geometry) {
            anchorIdentityRef.current = identity;
            structuredAnchorTopRef.current = null;
            const nextMode = chatViewportModeAfterAnchorMeasurement(modeRef.current, node, geometry);
            if (nextMode !== modeRef.current) {
                pendingUserScrollRef.current = null;
                programmaticScrollRef.current = null;
                setViewportMode(nextMode);
            }
            return;
        }

        anchorIdentityRef.current = identity;
        structuredAnchorTopRef.current = geometry.top;
        node.style.setProperty(EXTRA_BOTTOM_VARIABLE, `${geometry.extraBottom}px`);
        startProgrammaticScroll(geometry.top, "structured-anchor");
    }, [clearTemporarySpace, contentVersion, feedRef, sessionId, startProgrammaticScroll, structuredAnchorKey]);

    React.useLayoutEffect(() => {
        if (!sessionId) return;
        const node = feedRef.current;
        if (!node || modeRef.current !== "follow-bottom") return;
        startProgrammaticScroll(Math.max(0, node.scrollHeight - node.clientHeight), "follow-bottom");
    }, [contentVersion, feedRef, sessionId, startProgrammaticScroll]);

    return {
        mode,
        isDetached: mode !== "follow-bottom",
        handleScroll,
        scrollToEnd,
    };
}
