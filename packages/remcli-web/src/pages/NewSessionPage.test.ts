import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

function clickButton(root: unknown, label: string): void {
    const button = findElement(root, (element) => element.type === 'button' && elementText(element).includes(label));
    button.props.onClick?.();
}

function clickModel(root: unknown, model: string): void {
    const modelRow = findElement(root, (element) => element.props.label === model);
    modelRow.props.onClick?.();
}

function renderNewSessionPage(): unknown {
    componentHooks.beginRender();
    return NewSessionPage();
}

async function startCodexSession(root: unknown): Promise<unknown> {
    clickButton(root, 'start:codex');
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledOnce());
    return navigateMock.mock.calls[0]?.[1]?.state;
}

let agentOptions: Array<{ id: string; models: string[] }> = [];
let getModelOverride = (_model: string): string | null => {
    throw new Error('NewSessionPage module was not loaded');
};
let modelOverrideState = (_model: string, _hasExplicitModelSelection: boolean): { model?: string | null } => {
    throw new Error('NewSessionPage module was not loaded');
};
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

describe('NewSessionPage model selection', () => {
    it('uses Codex default without a concrete model override', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models[0]).toBe('default');
        expect(getModelOverride(codex?.models[0] ?? '')).toBeNull();
    });

    it('does not send model metadata for the initial default selection', () => {
        expect(modelOverrideState('default', false)).toEqual({});
    });

    it('sends explicit default as a deliberate model reset only after user selection', () => {
        expect(modelOverrideState('default', true)).toEqual({ model: null });
    });

    it('exposes current Codex model choices after default', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models).toEqual([
            'default',
            'gpt-5.6-sol',
            'gpt-5.6-terra',
            'gpt-5.6-luna',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex-spark'
        ]);
    });

    it('does not expose stale Codex model ids', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models).not.toContain('gpt-5.3-codex');
        expect(codex?.models).not.toContain('gpt-5.2');
        expect(codex?.models).not.toContain('gpt-5.1-codex-mini');
    });

    it('keeps explicit non-default model overrides intact', () => {
        expect(getModelOverride('sonnet')).toBe('sonnet');
    });
});

describe('NewSessionPage model navigation state', () => {
    it('omits model for the initial Codex default', async () => {
        let page = renderNewSessionPage();
        clickButton(page, 'Codex');
        page = renderNewSessionPage();

        const state = await startCodexSession(page);

        expect(state).toEqual({
            permissionMode: 'workspace-write',
        });
    });

    it('passes the explicitly selected Codex model to the session route', async () => {
        let page = renderNewSessionPage();
        clickButton(page, 'Codex');
        page = renderNewSessionPage();
        clickButton(page, 'default');
        page = renderNewSessionPage();
        clickModel(page, 'gpt-5.6-luna');
        page = renderNewSessionPage();

        const state = await startCodexSession(page);

        expect(state).toEqual({ permissionMode: 'workspace-write', model: 'gpt-5.6-luna' });
    });

    it('passes model null after resetting a concrete Codex selection to default', async () => {
        let page = renderNewSessionPage();
        clickButton(page, 'Codex');
        page = renderNewSessionPage();
        clickButton(page, 'default');
        page = renderNewSessionPage();
        clickModel(page, 'gpt-5.6-luna');
        page = renderNewSessionPage();
        clickButton(page, 'gpt-5.6-luna');
        page = renderNewSessionPage();
        clickModel(page, 'default');
        page = renderNewSessionPage();

        const state = await startCodexSession(page);

        expect(state).toEqual({ permissionMode: 'workspace-write', model: null });
    });

    it('clears an explicit Codex model when switching away and back to Codex', async () => {
        let page = renderNewSessionPage();
        clickButton(page, 'Codex');
        page = renderNewSessionPage();
        clickButton(page, 'default');
        page = renderNewSessionPage();
        clickModel(page, 'gpt-5.6-luna');
        page = renderNewSessionPage();
        clickButton(page, 'Claude');
        page = renderNewSessionPage();
        clickButton(page, 'Codex');
        page = renderNewSessionPage();

        const state = await startCodexSession(page);

        expect(state).toEqual({ permissionMode: 'workspace-write' });
    });
});

describe('NewSessionPage directory and resume sheets', () => {
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
});
