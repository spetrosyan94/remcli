import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCapabilitiesSnapshot, CursorCapabilitiesSnapshot } from '@/lib/protocol';

const componentHooks = vi.hoisted(() => {
    const values: unknown[] = [];
    const effects: Array<{
        dependencies: readonly unknown[] | undefined;
        cleanup: (() => void) | undefined;
    }> = [];
    let index = 0;
    let effectIndex = 0;
    let areEffectsEnabled = false;

    return {
        reset() {
            for (const effect of effects) effect.cleanup?.();
            values.length = 0;
            effects.length = 0;
            index = 0;
            effectIndex = 0;
            areEffectsEnabled = false;
        },
        beginRender() {
            index = 0;
            effectIndex = 0;
        },
        enableEffects() {
            areEffectsEnabled = true;
        },
        useState<T>(initialValue: T | (() => T)) {
            const currentIndex = index++;
            if (!(currentIndex in values)) {
                values[currentIndex] = typeof initialValue === 'function'
                    ? (initialValue as () => T)()
                    : initialValue;
            }
            const setValue = (nextValue: T | ((previousValue: T) => T)) => {
                const previousValue = values[currentIndex] as T;
                values[currentIndex] = typeof nextValue === 'function'
                    ? (nextValue as (value: T) => T)(previousValue)
                    : nextValue;
            };
            return [values[currentIndex] as T, setValue] as const;
        },
        useRef<T>(initialValue: T) {
            const currentIndex = index++;
            if (!(currentIndex in values)) {
                values[currentIndex] = { current: initialValue };
            }
            return values[currentIndex] as { current: T };
        },
        useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]) {
            const currentEffectIndex = effectIndex++;
            if (!areEffectsEnabled) return;

            const previousEffect = effects[currentEffectIndex];
            const hasChanged = previousEffect === undefined
                || dependencies === undefined
                || previousEffect.dependencies === undefined
                || previousEffect.dependencies.length !== dependencies.length
                || previousEffect.dependencies.some((dependency, index) => dependency !== dependencies[index]);
            if (!hasChanged) return;

            previousEffect?.cleanup?.();
            const cleanup = effect();
            effects[currentEffectIndex] = {
                dependencies: dependencies ? [...dependencies] : undefined,
                cleanup: typeof cleanup === 'function' ? cleanup : undefined,
            };
        },
    };
});

const machineSpawnNewSessionMock = vi.hoisted(() => vi.fn());
const machineGetCodexCapabilitiesMock = vi.hoisted(() => vi.fn());
const machineGetCursorCapabilitiesMock = vi.hoisted(() => vi.fn());
const machineListRecentDirectoriesMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastWarningMock = vi.hoisted(() => vi.fn());
const protocolSessions = vi.hoisted(() => ({ current: [] as unknown[] }));
const navigationState = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useEffect: componentHooks.useEffect,
        useMemo: <T>(factory: () => T) => factory(),
        useRef: componentHooks.useRef,
        useState: componentHooks.useState,
    };
});

vi.mock('react-router', () => ({
    useLocation: () => ({ state: navigationState.current }),
    useNavigate: () => navigateMock,
}));

vi.mock('sonner', () => ({
    toast: { error: toastErrorMock, warning: toastWarningMock },
}));

vi.mock('@/components/kit', () => ({
    AgentIcon: () => null,
    StatusDot: () => null,
}));

vi.mock('@/components/ui/dialog', () => ({
    Dialog: () => null,
    DialogContent: () => null,
    DialogDescription: () => null,
    DialogFooter: () => null,
    DialogHeader: () => null,
    DialogTitle: () => null,
}));

vi.mock('@/components/ui/drawer', () => ({
    Drawer: () => null,
    DrawerContent: () => null,
    DrawerTitle: () => null,
}));

vi.mock('@/lib/agentPermissions', () => ({
    getAgentPermissionLabel: (_agent: string, mode: string) => mode,
    getAgentPermissionModes: () => ['workspace-write'],
    getDefaultPermissionMode: () => 'workspace-write',
    normalizeAgentPermissionMode: (_agent: string, mode: string) => mode,
}));

vi.mock('@/lib/i18n', () => ({
    getIntlLocale: () => 'en-US',
    t: (key: string, params?: Record<string, unknown>) => key === 'new.startButton'
        ? `start:${params?.agent ?? ''}`
        : key,
}));

vi.mock('@/lib/protocol', () => ({
    machineListAgentSessions: vi.fn(),
    machineListDirectory: vi.fn(),
    machineListRecentDirectories: machineListRecentDirectoriesMock,
    machineGetCodexCapabilities: machineGetCodexCapabilitiesMock,
    machineGetCursorCapabilities: machineGetCursorCapabilitiesMock,
    machineSpawnNewSession: machineSpawnNewSessionMock,
    DEFAULT_CURSOR_LAUNCH_CONTROLS: {
        executionMode: 'agent',
        force: false,
        autoReview: false,
        sandbox: 'local-configuration',
        approveMcps: false,
    },
    refreshSessions: vi.fn(),
    sendSessionMessage: vi.fn(),
    useMachines: () => [{
        id: 'machine-1',
        active: true,
        activeAt: 1,
        metadata: { host: 'macbook-pro.local', homeDir: '/workspace' },
    }],
    useProtocolStore: {
        getState: () => ({ sessions: { 'session-1': {} } }),
    },
    useSessions: () => protocolSessions.current,
}));

vi.mock('@/lib/zenTasks', () => ({
    linkZenTaskSession: vi.fn(),
}));

interface TestElement {
    type: unknown;
    props: {
        children?: unknown;
        meta?: unknown;
        disabled?: boolean;
        label?: string;
        onClick?: () => void;
        className?: string;
        tabIndex?: number;
        role?: string;
        'aria-label'?: string;
        'aria-describedby'?: string;
        'aria-pressed'?: boolean;
        'aria-busy'?: boolean;
        'data-provider-availability'?: string;
        title?: string;
        showSelectionIndicator?: boolean;
    };
}

function isTestElement(value: unknown): value is TestElement {
    return typeof value === 'object'
        && value !== null
        && 'type' in value
        && 'props' in value
        && typeof value.props === 'object'
        && value.props !== null;
}

function elementText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(elementText).join('');
    return isTestElement(value) ? elementText(value.props.children) : '';
}

function findElement(root: unknown, predicate: (element: TestElement) => boolean): TestElement {
    const nodes: unknown[] = [root];
    while (nodes.length > 0) {
        const current = nodes.shift();
        if (current === undefined) continue;
        if (Array.isArray(current)) {
            nodes.push(...current);
            continue;
        }
        if (!isTestElement(current)) continue;
        if (predicate(current)) return current;
        nodes.push(current.props.children);
    }
    throw new Error('Expected interactive element was not rendered');
}

function renderNewSessionPage(): unknown {
    componentHooks.beginRender();
    return NewSessionPage();
}

async function flushPendingEffects(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

let agentOptions: Array<{ id: string; models: string[]; isAvailable: boolean }> = [];
let getModelOverride = (_model: string): string | null => {
    throw new Error('NewSessionPage module was not loaded');
};
let modelOverrideState = (_model: string, _hasExplicitModelSelection: boolean): { model?: string | null } => {
    throw new Error('NewSessionPage module was not loaded');
};
let getResumePrimaryLabel: typeof import('@/pages/NewSessionPage').getResumePrimaryLabel = (_item, _agent) => {
    throw new Error('NewSessionPage module was not loaded');
};
let getShortResumeId: typeof import('@/pages/NewSessionPage').getShortResumeId = (_sessionId) => {
    throw new Error('NewSessionPage module was not loaded');
};
let getResumeDirectory = (_projectPath: string | undefined, _activeDirectory: string): string => {
    throw new Error('NewSessionPage module was not loaded');
};
let getDefaultCodexExecution: typeof import('@/pages/NewSessionPage').getDefaultCodexExecution = (_capabilities) => {
    throw new Error('NewSessionPage module was not loaded');
};
let createCodexExecutionForModel: typeof import('@/pages/NewSessionPage').createCodexExecutionForModel = (
    _capabilities,
    _modelId,
) => {
    throw new Error('NewSessionPage module was not loaded');
};
let getDefaultCursorExecution: typeof import('@/pages/NewSessionPage').getDefaultCursorExecution = (_capabilities) => {
    throw new Error('NewSessionPage module was not loaded');
};
let createCursorExecutionForModel: typeof import('@/pages/NewSessionPage').createCursorExecutionForModel = (
    _capabilities,
    _modelId,
) => {
    throw new Error('NewSessionPage module was not loaded');
};
let parseNewSessionNavigationState: typeof import('@/pages/NewSessionPage').parseNewSessionNavigationState = (_state) => ({});
let isCursorResumePresetCompatible: typeof import('@/pages/NewSessionPage').isCursorResumePresetCompatible = (_preset, _machineId, _directory) => true;
let getPrimarySelectorLabelKey: typeof import('@/pages/NewSessionPage').getPrimarySelectorLabelKey = (_agent) => 'new.accessLevel';
let isNewSessionAgentAvailable: typeof import('@/pages/NewSessionPage').isNewSessionAgentAvailable = () => false;
let getReasoningControlState: typeof import('@/pages/NewSessionPage').getReasoningControlState = (_input) => {
    throw new Error('NewSessionPage module was not loaded');
};
let buildNewSessionSpawnOptions: typeof import('@/pages/NewSessionPage').buildNewSessionSpawnOptions = (_input) => {
    throw new Error('NewSessionPage module was not loaded');
};
let isCodexCapabilityRejection: typeof import('@/pages/NewSessionPage').isCodexCapabilityRejection = (_result, _agent) => false;
let isCursorCapabilityRejection: typeof import('@/pages/NewSessionPage').isCursorCapabilityRejection = (_result, _agent) => false;
let resolveSheetOpenChange: typeof import('@/pages/NewSessionPage').resolveSheetOpenChange = (_renderedSheet, currentSheet) => currentSheet;
let NewSessionPage: typeof import('@/pages/NewSessionPage').NewSessionPage;
let ResumeSheetContent: typeof import('@/pages/NewSessionPage').ResumeSheetContent;
let RecentDirectoryList: typeof import('@/pages/NewSessionPage').RecentDirectoryList;
let directorySheetContentClass = '';
let resumeSheetContentClass = '';

beforeAll(async () => {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal('navigator', {
        language: 'en-US',
        languages: ['en-US'],
    });

    const pageModule = await import('@/pages/NewSessionPage');
    agentOptions = pageModule.AGENT_OPTIONS;
    getModelOverride = pageModule.getModelOverride;
    modelOverrideState = pageModule.modelOverrideState;
    getResumePrimaryLabel = pageModule.getResumePrimaryLabel;
    getShortResumeId = pageModule.getShortResumeId;
    getResumeDirectory = pageModule.getResumeDirectory;
    getDefaultCodexExecution = pageModule.getDefaultCodexExecution;
    createCodexExecutionForModel = pageModule.createCodexExecutionForModel;
    getDefaultCursorExecution = pageModule.getDefaultCursorExecution;
    createCursorExecutionForModel = pageModule.createCursorExecutionForModel;
    parseNewSessionNavigationState = pageModule.parseNewSessionNavigationState;
    isCursorResumePresetCompatible = pageModule.isCursorResumePresetCompatible;
    getPrimarySelectorLabelKey = pageModule.getPrimarySelectorLabelKey;
    isNewSessionAgentAvailable = pageModule.isNewSessionAgentAvailable;
    getReasoningControlState = pageModule.getReasoningControlState;
    buildNewSessionSpawnOptions = pageModule.buildNewSessionSpawnOptions;
    isCodexCapabilityRejection = pageModule.isCodexCapabilityRejection;
    isCursorCapabilityRejection = pageModule.isCursorCapabilityRejection;
    resolveSheetOpenChange = pageModule.resolveSheetOpenChange;
    NewSessionPage = pageModule.NewSessionPage;
    ResumeSheetContent = pageModule.ResumeSheetContent;
    RecentDirectoryList = pageModule.RecentDirectoryList;
    directorySheetContentClass = pageModule.DIRECTORY_SHEET_CONTENT_CLASS;
    resumeSheetContentClass = pageModule.RESUME_SHEET_CONTENT_CLASS;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

beforeEach(() => {
    componentHooks.reset();
    machineGetCodexCapabilitiesMock.mockReset();
    machineGetCodexCapabilitiesMock.mockResolvedValue({
        agent: 'codex',
        status: 'unavailable',
        fetchedAt: null,
        expiresAt: null,
        catalogVersion: null,
        permissionModes: [],
        models: [],
    });
    machineGetCursorCapabilitiesMock.mockReset();
    machineListRecentDirectoriesMock.mockReset();
    machineListRecentDirectoriesMock.mockResolvedValue([]);
    machineSpawnNewSessionMock.mockReset();
    machineSpawnNewSessionMock.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    navigateMock.mockReset();
    toastErrorMock.mockReset();
    toastWarningMock.mockReset();
    protocolSessions.current = [];
    navigationState.current = null;
});

describe('NewSessionPage navigation state and shared access-level label', () => {
    it('keeps Claude and Gemini visible but unavailable until their capability contracts are accepted', () => {
        expect(isNewSessionAgentAvailable('codex')).toBe(true);
        expect(isNewSessionAgentAvailable('cursor')).toBe(true);
        expect(isNewSessionAgentAvailable('claude')).toBe(false);
        expect(isNewSessionAgentAvailable('gemini')).toBe(false);
        expect(agentOptions.find((option) => option.id === 'claude')?.isAvailable).toBe(false);
        expect(agentOptions.find((option) => option.id === 'gemini')?.isAvailable).toBe(false);
        expect(agentOptions.find((option) => option.id === 'claude')?.models).toEqual([]);
        expect(agentOptions.find((option) => option.id === 'gemini')?.models).toEqual([]);
    });

    it('restores only a strict Cursor resume preset and ignores reload or malformed state', () => {
        expect(parseNewSessionNavigationState(null)).toEqual({});
        expect(parseNewSessionNavigationState({ cursorResume: { machineId: 'machine-1' } })).toEqual({});
        expect(parseNewSessionNavigationState({ cursorResume: {
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            resumeSessionId: 'cursor-native-session-id',
            resumeSessionName: 'Cursor lifecycle review',
        } })).toEqual({
            cursorResume: {
                machineId: 'machine-1',
                directory: '/workspace/remcli',
                resumeSessionId: 'cursor-native-session-id',
                resumeSessionName: 'Cursor lifecycle review',
            },
        });
    });

    it('blocks a Cursor resume preset when machine or directory no longer matches', () => {
        const preset = parseNewSessionNavigationState({ cursorResume: {
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            resumeSessionId: 'cursor-native-session-id',
            resumeSessionName: null,
        } }).cursorResume ?? null;

        expect(isCursorResumePresetCompatible(preset, 'machine-1', '/workspace/remcli')).toBe(true);
        expect(isCursorResumePresetCompatible(preset, 'machine-2', '/workspace/remcli')).toBe(false);
        expect(isCursorResumePresetCompatible(preset, 'machine-1', '/workspace/other')).toBe(false);
        expect(isCursorResumePresetCompatible(null, 'machine-2', '/workspace/other')).toBe(true);
    });

    it('uses the common access-level heading for every provider without changing inner semantics', () => {
        expect(getPrimarySelectorLabelKey('claude')).toBe('new.accessLevel');
        expect(getPrimarySelectorLabelKey('codex')).toBe('new.accessLevel');
        expect(getPrimarySelectorLabelKey('cursor')).toBe('new.accessLevel');
        expect(getPrimarySelectorLabelKey('gemini')).toBe('new.accessLevel');
    });

    it('defaults to Codex and renders deferred providers as disabled choices', () => {
        const page = renderNewSessionPage();
        const codex = findElement(page, (element) => element.type === 'button' && elementText(element) === 'Codexcli');
        const claude = findElement(page, (element) => element.type === 'button' && elementText(element) === 'Claudecode');
        const gemini = findElement(page, (element) => element.type === 'button' && elementText(element) === 'Geminicli');

        expect(codex.props.disabled).toBe(false);
        expect(codex.props.className).toContain('border-accent');
        expect(codex.props['aria-pressed']).toBe(true);
        expect(claude.props.disabled).toBe(true);
        expect(claude.props['aria-describedby']).toBe('deferred-provider-note');
        expect(claude.props['data-provider-availability']).toBe('deferred');
        expect(gemini.props.disabled).toBe(true);
        expect(gemini.props['aria-describedby']).toBe('deferred-provider-note');
        expect(gemini.props['data-provider-availability']).toBe('deferred');
    });

    it('warns about an unavailable terminal and still navigates after creating a session', async () => {
        machineGetCodexCapabilitiesMock.mockResolvedValue({
            agent: 'codex',
            status: 'ready',
            fetchedAt: 1,
            expiresAt: 2,
            catalogVersion: 'catalog-1',
            permissionModes: ['workspace-write'],
            models: [{
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['high'],
                isDefault: true,
            }],
        } satisfies CodexCapabilitiesSnapshot);
        machineSpawnNewSessionMock.mockResolvedValue({
            type: 'success',
            sessionId: 'session-1',
            terminal: { type: 'unavailable', error: 'terminal-unavailable' },
        });
        componentHooks.enableEffects();

        renderNewSessionPage();
        await flushPendingEffects();
        const page = renderNewSessionPage();
        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'start:codex');

        startButton.props.onClick?.();
        await flushPendingEffects();

        expect(toastWarningMock).toHaveBeenCalledWith('new.terminalUnavailable');
        expect(navigateMock).toHaveBeenCalledWith('/session/session-1', expect.objectContaining({ replace: true }));
        expect(toastWarningMock.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0]);
    });

    it('does not navigate or warn when spawn transport rejects a malformed success result', async () => {
        machineGetCodexCapabilitiesMock.mockResolvedValue({
            agent: 'codex',
            status: 'ready',
            fetchedAt: 1,
            expiresAt: 2,
            catalogVersion: 'catalog-1',
            permissionModes: ['workspace-write'],
            models: [{
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['high'],
                isDefault: true,
            }],
        } satisfies CodexCapabilitiesSnapshot);
        machineSpawnNewSessionMock.mockResolvedValue({
            type: 'error',
            errorMessage: 'Spawn session RPC returned an invalid response',
        });
        componentHooks.enableEffects();

        renderNewSessionPage();
        await flushPendingEffects();
        const page = renderNewSessionPage();
        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'start:codex');

        startButton.props.onClick?.();
        await flushPendingEffects();

        expect(navigateMock).not.toHaveBeenCalled();
        expect(toastWarningMock).not.toHaveBeenCalled();
        expect(toastErrorMock).toHaveBeenCalledTimes(1);
        expect(toastErrorMock).toHaveBeenCalledWith('Spawn session RPC returned an invalid response');
    });

    it('keeps navigation when a resumed Cursor session reports an unavailable terminal', async () => {
        navigationState.current = {
            cursorResume: {
                machineId: 'machine-1',
                directory: '/workspace/remcli',
                resumeSessionId: 'cursor-native-session-id',
                resumeSessionName: 'Cursor lifecycle review',
            },
        };
        machineGetCursorCapabilitiesMock.mockResolvedValue({
            agent: 'cursor',
            status: 'ready',
            fetchedAt: 1,
            expiresAt: 2,
            catalogVersion: 'cursor-catalog-1',
            models: [{ id: 'auto', displayName: 'Auto', isDefault: true }],
        } satisfies CursorCapabilitiesSnapshot);
        machineSpawnNewSessionMock.mockResolvedValue({
            type: 'success',
            sessionId: 'session-1',
            terminal: { type: 'unavailable', error: 'terminal-unavailable' },
        });
        componentHooks.enableEffects();

        renderNewSessionPage();
        await flushPendingEffects();
        const page = renderNewSessionPage();
        const resumeButton = findElement(page, (element) => element.type === 'button'
            && elementText(element).includes('new.resumeTitle'));

        resumeButton.props.onClick?.();
        await flushPendingEffects();

        expect(toastWarningMock).toHaveBeenCalledWith('new.terminalUnavailable');
        expect(navigateMock).toHaveBeenCalledWith('/session/session-1', expect.objectContaining({ replace: true }));
        expect(toastWarningMock.mock.invocationCallOrder[0]).toBeLessThan(navigateMock.mock.invocationCallOrder[0]);
    });

});

describe('NewSessionPage Codex capability selection', () => {
    const capabilities: CodexCapabilitiesSnapshot = {
        agent: 'codex' as const,
        status: 'ready' as const,
        fetchedAt: 1,
        expiresAt: 2,
        catalogVersion: 'catalog-1',
        permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
        models: [
            {
                id: 'gpt-5.6-luna',
                displayName: 'GPT-5.6-Luna',
                defaultReasoningEffort: 'xhigh',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                isDefault: true,
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['low', 'high', 'xhigh', 'ultra'],
                isDefault: false,
            },
        ],
    };

    it('has no static Codex catalog in the web bundle', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models).toEqual([]);
    });

    it('has no static Cursor catalog in the web bundle', () => {
        const cursor = agentOptions.find((option) => option.id === 'cursor');

        expect(cursor?.models).toEqual([]);
    });

    it('uses the daemon default and preserves every provider-advertised effort', () => {
        const execution = getDefaultCodexExecution(capabilities);

        expect(execution).toEqual({
            model: 'gpt-5.6-luna',
            reasoningEffort: 'xhigh',
            catalogVersion: 'catalog-1',
        });
        expect(capabilities.models[0].supportedReasoningEfforts).toEqual([
            'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
        ]);
    });

    it('resets reasoning to the provider default on a model switch', () => {
        expect(createCodexExecutionForModel(capabilities, 'gpt-5.6-terra')).toEqual({
            model: 'gpt-5.6-terra',
            reasoningEffort: 'high',
            catalogVersion: 'catalog-1',
        });
    });

    it('does not synthesize an effort when the provider omits its default', () => {
        const chooseRequiredCapabilities: CodexCapabilitiesSnapshot = {
            ...capabilities,
            models: [{
                id: 'gpt-5.6-choose-required',
                displayName: 'GPT-5.6 Choose Required',
                supportedReasoningEfforts: ['low', 'ultra'],
                isDefault: true,
            }],
        };

        expect(getDefaultCodexExecution(chooseRequiredCapabilities)).toBeNull();
        expect(createCodexExecutionForModel(chooseRequiredCapabilities, 'gpt-5.6-choose-required')).toBeNull();
        expect(createCodexExecutionForModel(chooseRequiredCapabilities, 'gpt-5.6-choose-required', 'medium')).toBeNull();
        expect(createCodexExecutionForModel(chooseRequiredCapabilities, 'gpt-5.6-choose-required', 'ultra')).toEqual({
            model: 'gpt-5.6-choose-required',
            reasoningEffort: 'ultra',
            catalogVersion: 'catalog-1',
        });
    });

    it('keeps a provider model with no reasoning choices selectable', () => {
        const noReasoningCapabilities = {
            ...capabilities,
            models: [{
                id: 'gpt-5.6-no-reasoning',
                displayName: 'GPT-5.6 No Reasoning',
                supportedReasoningEfforts: [],
                isDefault: true,
            }],
        };

        expect(getDefaultCodexExecution(noReasoningCapabilities)).toEqual({
            model: 'gpt-5.6-no-reasoning',
            catalogVersion: 'catalog-1',
        });
    });

    it('sends the selected Codex execution atomically through spawn RPC', () => {
        const execution = getDefaultCodexExecution(capabilities);
        expect(buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: execution,
            codexReasoningEfforts: capabilities.models[0].supportedReasoningEfforts,
        })).toEqual({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            permissionMode: 'workspace-write',
            codexExecution: execution,
        });
    });

    it('does not create a Codex spawn payload without a validated capability selection', () => {
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: null,
            codexReasoningEfforts: capabilities.models[0].supportedReasoningEfforts,
        })).toThrow('Codex requires a capability-validated execution selection.');
    });

    it.each(['claude', 'gemini'] as const)('fails closed when unavailable %s is passed to the spawn boundary', (agent) => {
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent,
            permissionMode: 'workspace-write',
            codexExecution: null,
            codexReasoningEfforts: [],
        })).toThrow(`${agent} is not available in New Session.`);
    });

    it.each(['claude', 'gemini'] as const)('fails closed when unavailable %s overrides the active provider through resume', (agent) => {
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: getDefaultCodexExecution(capabilities),
            codexReasoningEfforts: capabilities.models[0].supportedReasoningEfforts,
            resume: {
                agent,
                projectPath: '/workspace/remcli',
                sessionId: `${agent}-native-session`,
                sessionName: null,
            },
        })).toThrow(`${agent} is not available in New Session.`);
    });

    it('fails closed when a reasoning selection is required and accepts zero-options execution', () => {
        const chooseRequiredModel = {
            ...capabilities.models[0],
            defaultReasoningEffort: undefined,
        };
        const chooseRequiredCapabilities = { ...capabilities, models: [chooseRequiredModel] };
        expect(getReasoningControlState({
            agent: 'codex',
            isLoading: false,
            capabilities: chooseRequiredCapabilities,
            selectedModel: chooseRequiredModel,
            hasReasoningSelection: false,
        })).toBe('choose-required');
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: createCodexExecutionForModel(capabilities, 'gpt-5.6-luna'),
            codexReasoningEfforts: ['low', 'ultra'],
        })).not.toThrow();

        const noReasoningModel = {
            ...chooseRequiredModel,
            supportedReasoningEfforts: [],
        };
        const noReasoningCapabilities = { ...capabilities, models: [noReasoningModel] };
        const noReasoningExecution = getDefaultCodexExecution(noReasoningCapabilities);
        expect(noReasoningExecution).toEqual({ model: noReasoningModel.id, catalogVersion: 'catalog-1' });
        expect(buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: noReasoningExecution,
            codexReasoningEfforts: [],
        }).codexExecution).toEqual(noReasoningExecution);
    });

    it('keeps provider status semantics distinct', () => {
        const noReasoningModel = { ...capabilities.models[0], supportedReasoningEfforts: [] };
        const noReasoningCapabilities = { ...capabilities, models: [noReasoningModel] };

        expect(getReasoningControlState({
            agent: 'cursor',
            isLoading: false,
            capabilities: null,
            selectedModel: null,
            hasReasoningSelection: false,
        })).toBe('unsupported');
        expect(getReasoningControlState({
            agent: 'codex',
            isLoading: false,
            capabilities: noReasoningCapabilities,
            selectedModel: noReasoningModel,
            hasReasoningSelection: true,
        })).toBe('no-options');
    });

    it('recognizes only canonical Codex capability rejections', () => {
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability selection rejected: unsupported_selection.',
        }, 'codex')).toBe(true);
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability selection rejected: policy_denied.',
        }, 'codex')).toBe(true);
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability selection rejected: expired.',
        }, 'codex')).toBe(true);
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability selection rejected: unknown.',
        }, 'codex')).toBe(false);
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability discovery is unavailable. Refresh and try again.',
        }, 'codex')).toBe(false);
        expect(isCodexCapabilityRejection({
            type: 'error',
            errorMessage: 'Codex capability selection rejected: unsupported_selection.',
        }, 'cursor')).toBe(false);
    });

    it('recognizes only canonical Cursor capability rejections', () => {
        expect(isCursorCapabilityRejection({
            type: 'error',
            errorMessage: 'Cursor capability selection rejected: unsupported_selection.',
        }, 'cursor')).toBe(true);
        expect(isCursorCapabilityRejection({
            type: 'error',
            errorMessage: 'Cursor capability selection rejected: unavailable.',
        }, 'cursor')).toBe(true);
        expect(isCursorCapabilityRejection({
            type: 'error',
            errorMessage: 'Cursor capability discovery is unavailable. Refresh and try again.',
        }, 'cursor')).toBe(false);
        expect(isCursorCapabilityRejection({
            type: 'error',
            errorMessage: 'Cursor capability selection rejected: expired.',
        }, 'codex')).toBe(false);
    });

    it('ignores a stale close from a previous same-kind drawer instance', () => {
        const staleSheet = { kind: 'model' as const, generation: 1 };
        const currentSheet = { kind: 'model' as const, generation: 2 };

        expect(resolveSheetOpenChange(staleSheet, currentSheet, false)).toBe(currentSheet);
    });

    it('ignores a stale close from a previous cross-kind drawer instance', () => {
        const staleSheet = { kind: 'model' as const, generation: 1 };
        const currentSheet = { kind: 'reasoning' as const, generation: 2 };

        expect(resolveSheetOpenChange(staleSheet, currentSheet, false)).toBe(currentSheet);
    });

    it('closes the exact current drawer instance', () => {
        const currentSheet = { kind: 'model' as const, generation: 1 };

        expect(resolveSheetOpenChange(currentSheet, currentSheet, false)).toBeNull();
    });

    it('keeps the current drawer state when the drawer reports open', () => {
        const renderedSheet = { kind: 'model' as const, generation: 1 };
        const currentSheet = { kind: 'model' as const, generation: 2 };

        expect(resolveSheetOpenChange(renderedSheet, currentSheet, true)).toBe(currentSheet);
    });

    it('keeps model navigation metadata only for non-Codex legacy providers', () => {
        expect(modelOverrideState('default', false)).toEqual({});
        expect(getModelOverride('sonnet')).toBe('sonnet');
    });
});

describe('NewSessionPage Cursor capability selection', () => {
    const capabilities: CursorCapabilitiesSnapshot = {
        agent: 'cursor',
        status: 'ready',
        fetchedAt: 1,
        expiresAt: 2,
        catalogVersion: 'cursor-catalog-1',
        models: [
            { id: 'auto', displayName: 'Auto', isDefault: true },
            { id: 'gpt-5.6-luna-xhigh', displayName: 'GPT-5.6 Luna 1M Extra High', isDefault: false },
        ],
    };

    it('uses the explicit Cursor provider default and preserves exact model IDs', () => {
        expect(getDefaultCursorExecution(capabilities)).toEqual({
            model: 'auto',
            catalogVersion: 'cursor-catalog-1',
        });
        expect(createCursorExecutionForModel(capabilities, 'gpt-5.6-luna-xhigh')).toEqual({
            model: 'gpt-5.6-luna-xhigh',
            catalogVersion: 'cursor-catalog-1',
        });
        expect(createCursorExecutionForModel(capabilities, 'not-account-visible')).toBeNull();
    });

    it('sends the validated Cursor execution atomically through spawn RPC', () => {
        const cursorExecution = getDefaultCursorExecution(capabilities);
        const cursorLaunchControls = {
            executionMode: 'agent' as const,
            force: true,
            autoReview: true,
            sandbox: 'disabled' as const,
            approveMcps: true,
        };

        expect(buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            permissionMode: 'workspace-write',
            codexExecution: null,
            codexReasoningEfforts: [],
            cursorExecution,
            cursorLaunchControls,
        })).toEqual({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            cursorExecution,
            cursorLaunchControls,
        });
    });

    it('forwards Cursor native execution and launch controls through the spawn transport', async () => {
        machineGetCursorCapabilitiesMock.mockResolvedValue(capabilities);
        componentHooks.enableEffects();

        let page = renderNewSessionPage();
        const cursorAgent = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'Cursoragent');
        cursorAgent.props.onClick?.();

        renderNewSessionPage();
        await flushPendingEffects();
        page = renderNewSessionPage();

        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'start:cursor');
        expect(startButton.props.disabled).toBe(false);

        await startButton.props.onClick?.();

        expect(machineSpawnNewSessionMock).toHaveBeenCalledTimes(1);
        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/workspace',
            agent: 'cursor',
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            cursorExecution: {
                model: 'auto',
                catalogVersion: 'cursor-catalog-1',
            },
            cursorLaunchControls: {
                executionMode: 'agent',
                force: false,
                autoReview: false,
                sandbox: 'local-configuration',
                approveMcps: false,
            },
        });
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('permissionMode');
    });

    it('forwards user-selected Cursor modes and launch controls through the spawn transport', async () => {
        machineGetCursorCapabilitiesMock.mockResolvedValue(capabilities);
        componentHooks.enableEffects();

        let page = renderNewSessionPage();
        const cursorAgent = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'Cursoragent');
        cursorAgent.props.onClick?.();

        renderNewSessionPage();
        await flushPendingEffects();
        page = renderNewSessionPage();

        const modeTrigger = findElement(page, (element) => element.type === 'button'
            && elementText(element).includes('new.cursorModeAgent'));
        modeTrigger.props.onClick?.();
        page = renderNewSessionPage();
        const planMode = findElement(page, (element) => element.props.label === 'new.cursorModePlan');
        planMode.props.onClick?.();

        page = renderNewSessionPage();
        const launchTrigger = findElement(page, (element) => element.type === 'button'
            && elementText(element).includes('new.cursorAdvanced'));
        launchTrigger.props.onClick?.();
        page = renderNewSessionPage();

        const forceSwitch = findElement(page, (element) => element.props.role === 'switch'
            && elementText(element).includes('new.cursorForce'));
        forceSwitch.props.onClick?.();
        page = renderNewSessionPage();
        const autoReviewSwitch = findElement(page, (element) => element.props.role === 'switch'
            && elementText(element).includes('new.cursorAutoReview'));
        autoReviewSwitch.props.onClick?.();
        page = renderNewSessionPage();
        const disabledSandbox = findElement(page, (element) => element.props.label === 'new.cursorSandboxDisabled');
        expect(disabledSandbox.props.showSelectionIndicator).toBe(true);
        disabledSandbox.props.onClick?.();
        page = renderNewSessionPage();
        const approveMcpsSwitch = findElement(page, (element) => element.props.role === 'switch'
            && elementText(element).includes('new.cursorApproveMcps'));
        approveMcpsSwitch.props.onClick?.();
        page = renderNewSessionPage();

        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element) === 'start:cursor');
        await startButton.props.onClick?.();

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/workspace',
            agent: 'cursor',
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            cursorExecution: {
                model: 'auto',
                catalogVersion: 'cursor-catalog-1',
            },
            cursorLaunchControls: {
                executionMode: 'plan',
                force: true,
                autoReview: true,
                sandbox: 'disabled',
                approveMcps: true,
            },
        });
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('permissionMode');
    });

    it('restores a Cursor resume preset and sends native identity plus controls after a fresh catalog check', async () => {
        navigationState.current = {
            cursorResume: {
                machineId: 'machine-1',
                directory: '/workspace/remcli',
                resumeSessionId: 'cursor-native-session-id',
                resumeSessionName: 'Cursor lifecycle review',
            },
        };
        machineGetCursorCapabilitiesMock.mockResolvedValue(capabilities);
        componentHooks.enableEffects();

        let page = renderNewSessionPage();
        expect(elementText(page)).toContain('Cursor lifecycle review');
        expect(elementText(page)).toContain('cursor-nativ…');

        await flushPendingEffects();
        page = renderNewSessionPage();

        expect(machineGetCursorCapabilitiesMock).toHaveBeenCalledWith('machine-1', true);
        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element).includes('new.resumeTitle'));
        expect(startButton.props.disabled).toBe(false);

        await startButton.props.onClick?.();

        expect(machineSpawnNewSessionMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            resumeSessionId: 'cursor-native-session-id',
            resumeSessionName: 'Cursor lifecycle review',
            cursorExecution: {
                model: 'auto',
                catalogVersion: 'cursor-catalog-1',
            },
            cursorLaunchControls: {
                executionMode: 'agent',
                force: false,
                autoReview: false,
                sandbox: 'local-configuration',
                approveMcps: false,
            },
        });
        expect(machineSpawnNewSessionMock.mock.calls[0]?.[0]).not.toHaveProperty('permissionMode');
    });

    it('keeps Cursor resume blocked when the fresh catalog is unavailable', async () => {
        navigationState.current = {
            cursorResume: {
                machineId: 'machine-1',
                directory: '/workspace/remcli',
                resumeSessionId: 'cursor-native-session-id',
                resumeSessionName: 'Cursor lifecycle review',
            },
        };
        machineGetCursorCapabilitiesMock.mockResolvedValue({
            agent: 'cursor',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            errorCode: 'unavailable',
        } satisfies CursorCapabilitiesSnapshot);
        componentHooks.enableEffects();

        renderNewSessionPage();
        await flushPendingEffects();
        const page = renderNewSessionPage();
        const startButton = findElement(page, (element) => element.type === 'button'
            && elementText(element).includes('new.resumeTitle'));

        expect(machineGetCursorCapabilitiesMock).toHaveBeenCalledWith('machine-1', true);
        expect(startButton.props.disabled).toBe(true);
        await startButton.props.onClick?.();
        expect(machineSpawnNewSessionMock).not.toHaveBeenCalled();
    });

    it('fails closed without a validated Cursor execution selection', () => {
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            codexExecution: null,
            codexReasoningEfforts: [],
            cursorExecution: null,
            cursorLaunchControls: {
                executionMode: 'agent',
                force: false,
                autoReview: false,
                sandbox: 'local-configuration',
                approveMcps: false,
            },
        })).toThrow('Cursor requires a capability-validated execution selection.');
    });

    it('fails closed without validated Cursor launch controls', () => {
        const cursorExecution = getDefaultCursorExecution(capabilities);

        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            codexExecution: null,
            codexReasoningEfforts: [],
            cursorExecution,
        })).toThrow('Cursor requires validated launch controls.');
    });
});

describe('NewSessionPage directory and resume sheets', () => {
    it('falls back to the selected directory for a legacy empty Cursor project path', () => {
        expect(getResumeDirectory('', '/workspace/remcli')).toBe('/workspace/remcli');
        expect(getResumeDirectory('/workspace/cursor', '/workspace/remcli')).toBe('/workspace/cursor');
    });

    it('renders daemon-provided canonical/display paths and selects the canonical value', () => {
        const path = '/Users/solidhard1/Projects/pet-projects/remcli/packages/remcli-web/src/pages';
        const onSelect = vi.fn();
        const directory = { canonicalPath: path, displayPath: '~/Projects/remcli/packages/remcli-web/src/pages', lastUsedAt: 10 };
        const content = RecentDirectoryList({
            directories: [directory],
            activePath: path,
            error: null,
            isLoading: false,
            isBrowseDisabled: false,
            onSelect,
            onRetry: vi.fn(),
            onBrowse: vi.fn(),
        });
        const pathRow = findElement(content, (element) => element.type === 'button' && elementText(element).includes(directory.displayPath));
        const pathLabel = findElement(content, (element) => element.type === 'span' && elementText(element) === directory.displayPath);

        expect(pathLabel.props.className).toContain('truncate');
        pathRow.props.onClick?.();
        expect(onSelect).toHaveBeenCalledWith(directory);
    });

    it('keeps the recent-directory error retryable while retaining the directory browser fallback', () => {
        const onRetry = vi.fn();
        const onBrowse = vi.fn();
        const content = RecentDirectoryList({
            directories: null,
            activePath: '/workspace',
            error: 'Recent directories are unavailable.',
            isLoading: false,
            isBrowseDisabled: false,
            onSelect: vi.fn(),
            onRetry,
            onBrowse,
        });
        const errorState = findElement(content, (element) => element.props.role === 'alert');
        const retryButton = findElement(content, (element) => element.type === 'button' && elementText(element) === 'new.dirRetry');
        const browseButton = findElement(content, (element) => element.type === 'button' && elementText(element) === 'new.dirBrowse');

        expect(elementText(errorState)).toContain('Recent directories are unavailable.');
        retryButton.props.onClick?.();
        browseButton.props.onClick?.();
        expect(onRetry).toHaveBeenCalledOnce();
        expect(onBrowse).toHaveBeenCalledOnce();
    });

    it('keeps directory and resume drawer surfaces at a stable height without disabling the shared reduced-motion token', () => {
        expect(directorySheetContentClass).toContain('data-[vaul-drawer-direction=bottom]:h-[min(78dvh,35rem)]');
        expect(resumeSheetContentClass).toContain('data-[vaul-drawer-direction=bottom]:h-[min(72dvh,32rem)]');
        expect(directorySheetContentClass).not.toContain('motion-reduce:transition-none');
        expect(resumeSheetContentClass).not.toContain('motion-reduce:transition-none');
    });

    it('renders a keyboard-focusable internal resume scroll region and resumes the selected item', () => {
        const onResume = vi.fn();
        const items = Array.from({ length: 24 }, (_, index) => ({
            sessionId: `codex-${index}`,
            agent: 'codex' as const,
            projectPath: '/Users/solidhard1/Projects/pet-projects/remcli',
            lastModified: index,
            firstMessage: null,
            messageCount: index,
            createdAt: index,
            sessionName: `Long-running Codex session ${index}`,
        }));

        const content = ResumeSheetContent({ agent: 'codex', items, onResume });
        const scrollRegion = findElement(content, (element) => element.props['aria-label'] === 'new.resumeTitle');
        const lastSession = findElement(content, (element) => element.type === 'button' && elementText(element).includes('Long-running Codex session 23'));

        expect(scrollRegion.props.className).toContain('overflow-y-auto');
        expect(scrollRegion.props.className).toContain('overscroll-contain');
        expect(scrollRegion.props.tabIndex).toBe(0);

        lastSession.props.onClick?.();
        expect(onResume).toHaveBeenCalledWith(items[23]);
    });

    it('keeps the resume loading state inside the same scrollable surface', () => {
        const content = ResumeSheetContent({ agent: 'codex', items: null, onResume: vi.fn() });
        const loadingState = findElement(content, (element) => elementText(element).includes('new.resumeLoading')
            && element.props.className?.includes('min-h-[12rem]') === true);

        expect(loadingState.props.className).toContain('min-h-[12rem]');
    });

    it('keeps a rejected resume list distinct from an empty list and retries inside the scroll region', () => {
        const onRetry = vi.fn();
        const content = ResumeSheetContent({
            agent: 'codex',
            items: null,
            error: 'history unavailable',
            onResume: vi.fn(),
            onRetry,
        });
        const scrollRegion = findElement(content, (element) => element.props.role === 'region'
            && element.props['aria-label'] === 'new.resumeTitle');
        const errorState = findElement(content, (element) => element.props.role === 'alert');
        const retryButton = findElement(content, (element) => element.type === 'button'
            && elementText(element) === 'connect.retry');

        expect(scrollRegion.props.className).toContain('overflow-y-auto');
        expect(scrollRegion.props['aria-busy']).toBe(false);
        expect(elementText(errorState)).toContain('history unavailable');
        expect(elementText(content)).not.toContain('new.resumeEmpty');

        retryButton.props.onClick?.();
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it('keeps the provider resume sheet busy and disables competing rows while a native retry is running', () => {
        const onResume = vi.fn();
        const item = {
            sessionId: 'cursor-native-session',
            agent: 'cursor' as const,
            projectPath: '/Users/solidhard1/Projects/pet-projects/remcli',
            lastModified: 1,
            firstMessage: 'Resume Cursor',
            messageCount: 1,
            createdAt: 1,
            sessionName: 'Cursor lifecycle review',
        };
        const content = ResumeSheetContent({ agent: 'cursor', items: [item], isResuming: true, onResume });
        const scrollRegion = findElement(content, (element) => element.props.role === 'region'
            && element.props['aria-label'] === 'new.resumeTitle');
        const progress = findElement(content, (element) => element.props.role === 'status'
            && elementText(element).includes('new.spawning'));
        const row = findElement(content, (element) => element.type === 'button' && elementText(element).includes('Cursor lifecycle review'));

        expect(scrollRegion.props['aria-busy']).toBe(true);
        expect(elementText(progress)).toContain('new.spawning');
        expect(row.props.disabled).toBe(true);
        row.props.onClick?.();
        expect(onResume).toHaveBeenCalledWith(item);
    });

    it('never uses UUID metadata as the resume primary label', () => {
        const item = {
            sessionId: '019f7dd8-9c4c-7b7c-9a89-abcdef123456',
            agent: 'cursor' as const,
            projectPath: '/Users/dev/projects/remcli',
            lastModified: 1,
            firstMessage: '019f7dd8-9c4c-7b7c-9a89-abcdef123457',
            messageCount: 1,
            createdAt: 1,
            sessionName: '019f7dd8-9c4c-7b7c-9a89-abcdef123458',
        };
        const content = ResumeSheetContent({ agent: 'cursor', items: [item], onResume: vi.fn() });
        const primaryLabel = getResumePrimaryLabel(item, 'cursor');
        const row = findElement(content, (element) => element.type === 'button' && elementText(element).includes(primaryLabel));
        const primary = findElement(row, (element) => element.props.title === primaryLabel);

        expect(primary.props.title).not.toContain(item.sessionId);
        expect(elementText(row)).not.toContain(item.sessionName);
        expect(elementText(row)).not.toContain(item.firstMessage);
        expect(elementText(row)).toContain(item.projectPath);
        expect(getResumePrimaryLabel({
            sessionId: item.sessionId,
            sessionName: item.sessionName,
            firstMessage: item.firstMessage,
            projectPath: item.projectPath,
        }, 'cursor')).toBe('new.resumeProviderTitle · remcli');
        expect(getResumePrimaryLabel({
            sessionId: item.sessionId,
            sessionName: null,
            firstMessage: null,
        }, 'cursor')).toBe('new.resumeProviderTitle');
    });

    it('prioritizes a human title, renders the message as preview, and clamps long values with full accessible text', () => {
        const title = 'Named Cursor session '.repeat(12).trim();
        const preview = 'Review the resume context before continuing '.repeat(12).trim();
        const projectPath = `/Users/dev/projects/${'nested-directory/'.repeat(20)}remcli`;
        const item = {
            sessionId: 'cursor-native-long-session',
            agent: 'cursor' as const,
            projectPath,
            lastModified: 1,
            firstMessage: preview,
            messageCount: 4,
            createdAt: 1,
            sessionName: title,
        };
        const content = ResumeSheetContent({ agent: 'cursor', items: [item], onResume: vi.fn() });
        const row = findElement(content, (element) => element.type === 'button' && elementText(element).includes(title));
        const titleElement = findElement(row, (element) => element.props.title === title);
        const previewElement = findElement(row, (element) => element.props.title === preview);
        const projectElement = findElement(row, (element) => element.props.title === projectPath);

        expect(titleElement.props.className).toContain('line-clamp-2');
        expect(previewElement.props['aria-label']).toBe(preview);
        expect(projectElement.props['aria-label']).toBe(projectPath);
        expect(projectElement.props.className).toContain('break-all');
        expect(row.props.className).toContain('overflow-hidden');
        expect(getResumePrimaryLabel({ ...item, sessionName: null, firstMessage: 'Continue from the saved Cursor context' }, 'cursor'))
            .toBe('Continue from the saved Cursor context');
    });

    it('keeps an opaque non-UUID provider id secondary and omits unknown project context', () => {
        const item = {
            sessionId: 'cursor-native-session-without-title',
            agent: 'cursor' as const,
            projectPath: '',
            lastModified: 1,
            firstMessage: 'cursor-native-session-without-title',
            messageCount: 1,
            createdAt: 1,
            sessionName: 'cursor-native-session-without-title',
        };
        const content = ResumeSheetContent({ agent: 'cursor', items: [item], onResume: vi.fn() });
        const primaryLabel = getResumePrimaryLabel(item, 'cursor');
        const row = findElement(content, (element) => element.type === 'button' && elementText(element).includes(primaryLabel));
        const secondaryId = findElement(row, (element) => element.props['aria-label'] === item.sessionId);

        expect(primaryLabel).not.toContain(item.sessionId);
        expect(secondaryId.props['aria-label']).toBe(item.sessionId);
        expect(elementText(secondaryId)).toBe('cursor-nativ…');
        expect(getShortResumeId(item.sessionId)).toBe('cursor-nativ…');
        expect(() => findElement(row, (element) => element.props.title === item.projectPath)).toThrow();
    });
});
