import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCapabilitiesSnapshot, CursorCapabilitiesSnapshot } from '@/lib/protocol';

const componentHooks = vi.hoisted(() => {
    const values: unknown[] = [];
    let index = 0;

    return {
        reset() {
            values.length = 0;
            index = 0;
        },
        beginRender() {
            index = 0;
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
    };
});

const machineSpawnNewSessionMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const protocolSessions = vi.hoisted(() => ({ current: [] as unknown[] }));

vi.mock('react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
        ...actual,
        useEffect: () => undefined,
        useMemo: <T>(factory: () => T) => factory(),
        useRef: componentHooks.useRef,
        useState: componentHooks.useState,
    };
});

vi.mock('react-router', () => ({
    useLocation: () => ({ state: null }),
    useNavigate: () => navigateMock,
}));

vi.mock('sonner', () => ({
    toast: { error: vi.fn() },
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
    machineGetCodexCapabilities: vi.fn(),
    machineGetCursorCapabilities: vi.fn(),
    machineSpawnNewSession: machineSpawnNewSessionMock,
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
        disabled?: boolean;
        label?: string;
        onClick?: () => void;
        className?: string;
        tabIndex?: number;
        role?: string;
        'aria-label'?: string;
        'aria-busy'?: boolean;
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

let agentOptions: Array<{ id: string; models: string[] }> = [];
let getModelOverride = (_model: string): string | null => {
    throw new Error('NewSessionPage module was not loaded');
};
let modelOverrideState = (_model: string, _hasExplicitModelSelection: boolean): { model?: string | null } => {
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
    getResumeDirectory = pageModule.getResumeDirectory;
    getDefaultCodexExecution = pageModule.getDefaultCodexExecution;
    createCodexExecutionForModel = pageModule.createCodexExecutionForModel;
    getDefaultCursorExecution = pageModule.getDefaultCursorExecution;
    createCursorExecutionForModel = pageModule.createCursorExecutionForModel;
    getReasoningControlState = pageModule.getReasoningControlState;
    buildNewSessionSpawnOptions = pageModule.buildNewSessionSpawnOptions;
    isCodexCapabilityRejection = pageModule.isCodexCapabilityRejection;
    isCursorCapabilityRejection = pageModule.isCursorCapabilityRejection;
    resolveSheetOpenChange = pageModule.resolveSheetOpenChange;
    NewSessionPage = pageModule.NewSessionPage;
    ResumeSheetContent = pageModule.ResumeSheetContent;
    directorySheetContentClass = pageModule.DIRECTORY_SHEET_CONTENT_CLASS;
    resumeSheetContentClass = pageModule.RESUME_SHEET_CONTENT_CLASS;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

beforeEach(() => {
    componentHooks.reset();
    machineSpawnNewSessionMock.mockReset();
    machineSpawnNewSessionMock.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    navigateMock.mockReset();
    protocolSessions.current = [];
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

        expect(buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            permissionMode: 'agent',
            codexExecution: null,
            codexReasoningEfforts: [],
            cursorExecution,
        })).toEqual({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            permissionMode: 'agent',
            cursorExecution,
        });
    });

    it('fails closed without a validated Cursor execution selection', () => {
        expect(() => buildNewSessionSpawnOptions({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'cursor',
            permissionMode: 'agent',
            codexExecution: null,
            codexReasoningEfforts: [],
            cursorExecution: null,
        })).toThrow('Cursor requires a capability-validated execution selection.');
    });
});

describe('NewSessionPage directory and resume sheets', () => {
    it('falls back to the selected directory for a legacy empty Cursor project path', () => {
        expect(getResumeDirectory('', '/workspace/remcli')).toBe('/workspace/remcli');
        expect(getResumeDirectory('/workspace/cursor', '/workspace/remcli')).toBe('/workspace/cursor');
    });

    it('left-aligns a long recent directory path inside its row', () => {
        const path = '/Users/solidhard1/Projects/pet-projects/remcli/packages/remcli-web/src/pages';
        protocolSessions.current = [{
            metadata: { machineId: 'machine-1', path },
            updatedAt: 1,
        }];

        const page = renderNewSessionPage();
        const pathLabel = findElement(page, (element) => element.type === 'span' && elementText(element) === path);
        const pathRow = findElement(page, (element) => element.type === 'button' && elementText(element).includes(path));

        expect(pathLabel.props.className).toContain('text-left');
        expect(pathRow.props.className).toContain('text-left');
        expect(pathLabel.props.className).toContain('truncate');
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
        const lastSession = findElement(content, (element) => element.props.label === 'Long-running Codex session 23');

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
        const row = findElement(content, (element) => element.props.label === 'Cursor lifecycle review');

        expect(scrollRegion.props['aria-busy']).toBe(true);
        expect(elementText(progress)).toContain('new.spawning');
        expect(row.props.disabled).toBe(true);
        row.props.onClick?.();
        expect(onResume).toHaveBeenCalledWith(item);
    });
});
