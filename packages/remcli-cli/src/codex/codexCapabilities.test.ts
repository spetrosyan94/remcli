import { describe, expect, it, vi } from 'vitest';

import {
    CodexCapabilitiesError,
    CodexCapabilitiesService,
    fetchCodexCapabilities,
    getDefaultCodexExecution,
    validateCodexExecution,
    type CodexCapabilityClient,
} from './codexCapabilities';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

type ModelListPage = Awaited<ReturnType<CodexCapabilityClient['listModels']>>;

function createDeferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createModelListPage(id: string): ModelListPage {
    return {
        data: [{
            id,
            displayName: id,
            defaultReasoningEffort: 'xhigh',
            supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }],
            isDefault: true,
        }],
    };
}

function createClient(overrides: Partial<CodexCapabilityClient> = {}): CodexCapabilityClient {
    return {
        listModels: vi.fn(async () => ({
            data: [
                {
                    id: 'gpt-5.6-luna',
                    displayName: 'GPT-5.6-Luna',
                    defaultReasoningEffort: 'xhigh',
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'low' },
                        { reasoningEffort: 'medium' },
                        { reasoningEffort: 'high' },
                        { reasoningEffort: 'xhigh' },
                        { reasoningEffort: 'max' },
                        { reasoningEffort: 'ultra' },
                    ],
                    isDefault: true,
                },
            ],
        })),
        readConfigRequirements: vi.fn(async () => ({
            allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
        })),
        disconnect: vi.fn(async () => undefined),
        ...overrides,
    };
}

function expectCapabilityError(action: () => void, code: CodexCapabilitiesError['code']): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexCapabilitiesError);
    expect((thrown as CodexCapabilitiesError).code).toBe(code);
}

const READ_ONLY_PERMISSION_CONFIG = {
    sandbox: 'read-only' as const,
    approvalPolicy: 'on-request' as const,
};

const WORKSPACE_WRITE_PERMISSION_CONFIG = {
    sandbox: 'workspace-write' as const,
    approvalPolicy: 'on-request' as const,
};

const DANGER_FULL_ACCESS_PERMISSION_CONFIG = {
    sandbox: 'danger-full-access' as const,
    approvalPolicy: 'never' as const,
};

describe('fetchCodexCapabilities', () => {
    it('keeps every account-visible provider reasoning effort and follows pagination', async () => {
        const client = createClient({
            listModels: vi.fn(async (cursor?: string) => cursor
                ? {
                    data: [{
                        id: 'gpt-5.6-terra',
                        displayName: 'GPT-5.6-Terra',
                        defaultReasoningEffort: 'high',
                        supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }],
                        isDefault: false,
                    }],
                }
                : {
                    data: [
                        {
                            id: 'gpt-5.6-luna',
                            displayName: 'GPT-5.6-Luna',
                            defaultReasoningEffort: 'xhigh',
                            supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }, { reasoningEffort: 'ultra' }],
                            isDefault: true,
                        },
                        {
                            id: 'gpt-5.6-no-reasoning',
                            displayName: 'GPT-5.6 No Reasoning',
                            supportedReasoningEfforts: [],
                            isDefault: false,
                        },
                    ],
                    nextCursor: 'page-2',
                }),
        });

        const snapshot = await fetchCodexCapabilities(client, () => 1_000, 5_000);

        expect(client.listModels).toHaveBeenNthCalledWith(1, undefined);
        expect(client.listModels).toHaveBeenNthCalledWith(2, 'page-2');
        expect(snapshot).toMatchObject({
            status: 'ready',
            fetchedAt: 1_000,
            expiresAt: 6_000,
            permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
            approvalPolicies: ['untrusted', 'on-request', 'never'],
        });
        expect(snapshot.models).toEqual([
            expect.objectContaining({
                id: 'gpt-5.6-luna',
                supportedReasoningEfforts: ['low', 'max', 'ultra'],
            }),
            expect.objectContaining({
                id: 'gpt-5.6-no-reasoning',
                supportedReasoningEfforts: [],
            }),
            expect.objectContaining({ id: 'gpt-5.6-terra' }),
        ]);
    });

    it('rejects a stale, forged, unsupported, or policy-denied selection', async () => {
        const snapshot = await fetchCodexCapabilities(createClient(), () => 1_000);
        const execution = getDefaultCodexExecution(snapshot);
        expect(execution).not.toBeNull();
        validateCodexExecution(
            snapshot,
            execution ?? undefined,
            WORKSPACE_WRITE_PERMISSION_CONFIG.sandbox,
            WORKSPACE_WRITE_PERMISSION_CONFIG.approvalPolicy,
        );

        expectCapabilityError(() => validateCodexExecution(snapshot, {
            ...execution!,
            catalogVersion: 'stale-catalog',
        }, WORKSPACE_WRITE_PERMISSION_CONFIG.sandbox, WORKSPACE_WRITE_PERMISSION_CONFIG.approvalPolicy), 'expired');
        expectCapabilityError(() => validateCodexExecution(snapshot, {
            ...execution!,
            reasoningEffort: 'not-advertised',
        }, WORKSPACE_WRITE_PERMISSION_CONFIG.sandbox, WORKSPACE_WRITE_PERMISSION_CONFIG.approvalPolicy), 'unsupported_selection');
        expect(() => validateCodexExecution(
            snapshot,
            execution ?? undefined,
            READ_ONLY_PERMISSION_CONFIG.sandbox,
            READ_ONLY_PERMISSION_CONFIG.approvalPolicy,
        )).not.toThrow();
    });

    it.each([
        ['missing', undefined],
        ['invalid', 'not-provider-supported'],
    ] as const)('does not synthesize a %s provider default reasoning effort', async (_caseName, defaultReasoningEffort) => {
        const snapshot = await fetchCodexCapabilities(createClient({
            listModels: vi.fn(async () => ({
                data: [{
                    id: 'gpt-5.6-luna',
                    displayName: 'GPT-5.6-Luna',
                    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
                    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
                    isDefault: true,
                }],
            })),
        }));

        expect(snapshot).toMatchObject({ status: 'ready' });
        expect(snapshot.models).toEqual([{
            id: 'gpt-5.6-luna',
            displayName: 'GPT-5.6-Luna',
            supportedReasoningEfforts: ['low', 'high'],
            isDefault: true,
        }]);
        expect(getDefaultCodexExecution(snapshot)).toBeNull();
        expect(() => validateCodexExecution(snapshot, {
            model: 'gpt-5.6-luna',
            reasoningEffort: 'high',
            catalogVersion: snapshot.catalogVersion!,
        }, READ_ONLY_PERMISSION_CONFIG.sandbox, READ_ONLY_PERMISSION_CONFIG.approvalPolicy)).not.toThrow();
    });

    it('keeps a provider-visible model that has no reasoning selector', async () => {
        const snapshot = await fetchCodexCapabilities(createClient({
            listModels: vi.fn(async () => ({
                data: [{
                    id: 'gpt-5.6-no-reasoning',
                    displayName: 'GPT-5.6 No Reasoning',
                    supportedReasoningEfforts: [],
                    isDefault: true,
                }],
            })),
        }));
        const execution = getDefaultCodexExecution(snapshot);

        expect(execution).toEqual({
            model: 'gpt-5.6-no-reasoning',
            catalogVersion: snapshot.catalogVersion,
        });
        expect(() => validateCodexExecution(
            snapshot,
            execution ?? undefined,
            READ_ONLY_PERMISSION_CONFIG.sandbox,
            READ_ONLY_PERMISSION_CONFIG.approvalPolicy,
        )).not.toThrow();
        expectCapabilityError(() => validateCodexExecution(snapshot, {
            ...execution!,
            reasoningEffort: 'xhigh',
        }, READ_ONLY_PERMISSION_CONFIG.sandbox, READ_ONLY_PERMISSION_CONFIG.approvalPolicy), 'unsupported_selection');
    });

    it('normalizes native app-server approval policies before versioning and validating them', async () => {
        const nativePolicies = await fetchCodexCapabilities(createClient({
            readConfigRequirements: vi.fn(async () => ({
                allowedApprovalPolicies: ['onRequest', 'unlessTrusted', 'never'],
                allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
            })),
        }));
        const canonicalPolicies = await fetchCodexCapabilities(createClient({
            readConfigRequirements: vi.fn(async () => ({
                allowedApprovalPolicies: ['on-request', 'untrusted', 'never'],
                allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
            })),
        }));

        expect(nativePolicies.approvalPolicies).toEqual(['on-request', 'untrusted', 'never']);
        expect(nativePolicies.catalogVersion).toBe(canonicalPolicies.catalogVersion);
        expect(() => validateCodexExecution(
            nativePolicies,
            getDefaultCodexExecution(nativePolicies) ?? undefined,
            READ_ONLY_PERMISSION_CONFIG.sandbox,
            READ_ONLY_PERMISSION_CONFIG.approvalPolicy,
        )).not.toThrow();
    });

    it('rejects an unknown app-server approval policy', async () => {
        const client = createClient({
            readConfigRequirements: vi.fn(async () => ({
                allowedApprovalPolicies: ['unsupported-policy'],
                allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
            })),
        });

        await expect(fetchCodexCapabilities(client)).rejects.toThrow(
            'Codex app-server policy does not allow any Remcli approval policy.',
        );
    });

    it('includes approval policy restrictions in the catalog version and rejects a disallowed mapped policy', async () => {
        const unrestricted = await fetchCodexCapabilities(createClient({
            readConfigRequirements: vi.fn(async () => ({
                allowedApprovalPolicies: ['on-request', 'never'],
                allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
            })),
        }));
        const neverOnly = await fetchCodexCapabilities(createClient({
            readConfigRequirements: vi.fn(async () => ({
                allowedApprovalPolicies: ['never'],
                allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
            })),
        }));
        const execution = getDefaultCodexExecution(neverOnly);

        expect(neverOnly.approvalPolicies).toEqual(['never']);
        expect(neverOnly.catalogVersion).not.toBe(unrestricted.catalogVersion);
        expectCapabilityError(() => validateCodexExecution(
            neverOnly,
            execution ?? undefined,
            READ_ONLY_PERMISSION_CONFIG.sandbox,
            READ_ONLY_PERMISSION_CONFIG.approvalPolicy,
        ), 'policy_denied');
        expect(() => validateCodexExecution(
            neverOnly,
            execution ?? undefined,
            DANGER_FULL_ACCESS_PERMISSION_CONFIG.sandbox,
            DANGER_FULL_ACCESS_PERMISSION_CONFIG.approvalPolicy,
        )).not.toThrow();
    });
});

describe('CodexCapabilitiesService', () => {
    it('coalesces concurrent discovery for the same app-server source', async () => {
        const models = createDeferred<ModelListPage>();
        const clientFactory = vi.fn(() => createClient({
            listModels: vi.fn(() => models.promise),
        }));
        const service = new CodexCapabilitiesService({
            getAppServerState: () => ({
                codexAppServerEndpoint: 'ws://127.0.0.1:45123',
                codexAppServerPid: 123,
            }),
            isStateUsable: async () => true,
            createClient: clientFactory,
        });

        const first = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(1));
        const second = service.getCapabilities();

        expect(clientFactory).toHaveBeenCalledTimes(1);
        models.resolve(createModelListPage('gpt-5.6-source-a'));

        const [firstSnapshot, secondSnapshot] = await Promise.all([first, second]);
        expect(firstSnapshot).toBe(secondSnapshot);
        expect(firstSnapshot.models[0]?.id).toBe('gpt-5.6-source-a');
    });

    it('starts independent discovery for source B when source A is still in flight', async () => {
        const sourceAModels = createDeferred<ModelListPage>();
        const sourceBModels = createDeferred<ModelListPage>();
        let state = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 123,
        };
        const clientFactory = vi.fn((endpoint: string) => createClient({
            listModels: vi.fn(() => endpoint === 'ws://127.0.0.1:45123'
                ? sourceAModels.promise
                : sourceBModels.promise),
        }));
        const service = new CodexCapabilitiesService({
            getAppServerState: () => state,
            isStateUsable: async () => true,
            createClient: clientFactory,
        });

        const fromSourceA = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(1));

        state = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45124',
            codexAppServerPid: 124,
        };
        const fromSourceB = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(2));

        expect(clientFactory).toHaveBeenNthCalledWith(1, 'ws://127.0.0.1:45123');
        expect(clientFactory).toHaveBeenNthCalledWith(2, 'ws://127.0.0.1:45124');

        sourceAModels.resolve(createModelListPage('gpt-5.6-source-a'));
        sourceBModels.resolve(createModelListPage('gpt-5.6-source-b'));

        await expect(fromSourceA).resolves.toMatchObject({
            models: [expect.objectContaining({ id: 'gpt-5.6-source-a' })],
        });
        await expect(fromSourceB).resolves.toMatchObject({
            models: [expect.objectContaining({ id: 'gpt-5.6-source-b' })],
        });
    });

    it('does not let a late source A discovery clobber source B cache', async () => {
        const sourceAModels = createDeferred<ModelListPage>();
        const sourceBModels = createDeferred<ModelListPage>();
        let state = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 123,
        };
        const clientFactory = vi.fn((endpoint: string) => createClient({
            listModels: vi.fn(() => endpoint === 'ws://127.0.0.1:45123'
                ? sourceAModels.promise
                : sourceBModels.promise),
        }));
        const service = new CodexCapabilitiesService({
            getAppServerState: () => state,
            isStateUsable: async () => true,
            createClient: clientFactory,
        });

        const fromSourceA = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(1));

        state = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45124',
            codexAppServerPid: 124,
        };
        const fromSourceB = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(2));

        sourceBModels.resolve(createModelListPage('gpt-5.6-source-b'));
        const sourceBSnapshot = await fromSourceB;
        sourceAModels.resolve(createModelListPage('gpt-5.6-source-a'));
        await fromSourceA;

        await expect(service.getCapabilities()).resolves.toBe(sourceBSnapshot);
        expect(clientFactory).toHaveBeenCalledTimes(2);
    });

    it('forces a fresh current-source discovery while coalescing concurrent force refreshes', async () => {
        const initialModels = createDeferred<ModelListPage>();
        const forcedModels = createDeferred<ModelListPage>();
        const clientFactory = vi.fn(() => createClient({
            listModels: vi.fn(() => clientFactory.mock.calls.length === 1
                ? initialModels.promise
                : forcedModels.promise),
        }));
        const service = new CodexCapabilitiesService({
            getAppServerState: () => ({
                codexAppServerEndpoint: 'ws://127.0.0.1:45123',
                codexAppServerPid: 123,
            }),
            isStateUsable: async () => true,
            createClient: clientFactory,
        });

        const initial = service.getCapabilities();
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(1));
        initialModels.resolve(createModelListPage('gpt-5.6-initial'));
        const initialSnapshot = await initial;

        await expect(service.getCapabilities()).resolves.toBe(initialSnapshot);
        const forcedFirst = service.getCapabilities(true);
        await vi.waitFor(() => expect(clientFactory).toHaveBeenCalledTimes(2));
        const forcedSecond = service.getCapabilities(true);

        expect(clientFactory).toHaveBeenCalledTimes(2);
        forcedModels.resolve(createModelListPage('gpt-5.6-forced'));

        const [firstForcedSnapshot, secondForcedSnapshot] = await Promise.all([forcedFirst, forcedSecond]);
        expect(firstForcedSnapshot).toBe(secondForcedSnapshot);
        expect(firstForcedSnapshot.models[0]?.id).toBe('gpt-5.6-forced');
        await expect(service.getCapabilities()).resolves.toBe(firstForcedSnapshot);
    });

    it('caches a fresh snapshot, invalidates it on source change, and never exposes raw discovery errors', async () => {
        let now = 1_000;
        let endpoint = 'ws://127.0.0.1:45123';
        const clients: CodexCapabilityClient[] = [];
        const service = new CodexCapabilitiesService({
            getAppServerState: () => ({ codexAppServerEndpoint: endpoint, codexAppServerPid: 123 }),
            isStateUsable: async () => true,
            now: () => now,
            cacheTtlMs: 100,
            createClient: () => {
                const client = createClient();
                clients.push(client);
                return client;
            },
        });

        const first = await service.getCapabilities();
        const cached = await service.getCapabilities();
        expect(first).toBe(cached);
        expect(clients).toHaveLength(1);

        endpoint = 'ws://127.0.0.1:45124';
        await service.getCapabilities();
        expect(clients).toHaveLength(2);

        now += 200;
        const unavailableService = new CodexCapabilitiesService({
            getAppServerState: () => ({ codexAppServerEndpoint: endpoint, codexAppServerPid: 123 }),
            isStateUsable: async () => true,
            createClient: () => createClient({
                listModels: vi.fn(async () => { throw new Error('account quota details must not leak'); }),
            }),
            now: () => now,
        });
        await expect(unavailableService.getCapabilities()).resolves.toEqual({
            agent: 'codex',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            permissionModes: [],
            approvalPolicies: [],
            errorCode: 'unavailable',
        });
    });

    it('fails closed when the shared daemon app-server is unavailable', async () => {
        const service = new CodexCapabilitiesService({
            getAppServerState: () => null,
            isStateUsable: async () => false,
        });

        await expect(service.validateSelection(undefined, 'workspace-write')).rejects.toMatchObject({
            name: 'CodexCapabilitiesError',
            code: 'unavailable',
        });
    });

    it('fails closed when a mixed approval policy payload contains an unknown provider value', async () => {
        const service = new CodexCapabilitiesService({
            getAppServerState: () => ({
                codexAppServerEndpoint: 'ws://127.0.0.1:45123',
                codexAppServerPid: 123,
            }),
            isStateUsable: async () => true,
            createClient: () => createClient({
                readConfigRequirements: vi.fn(async () => ({
                    allowedApprovalPolicies: ['onRequest', 'futurePolicy'],
                    allowedSandboxModes: ['readOnly', 'workspaceWrite', 'dangerFullAccess'],
                })),
            }),
        });

        const snapshot = await service.getCapabilities();

        expect(snapshot).toEqual({
            agent: 'codex',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            permissionModes: [],
            approvalPolicies: [],
            errorCode: 'unavailable',
        });
        expectCapabilityError(() => validateCodexExecution(
            snapshot,
            undefined,
            WORKSPACE_WRITE_PERMISSION_CONFIG.sandbox,
            WORKSPACE_WRITE_PERMISSION_CONFIG.approvalPolicy,
        ), 'unavailable');
    });
});
