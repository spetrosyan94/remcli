import { beforeEach, describe, expect, it, vi } from "vitest";

const protocol = vi.hoisted(() => ({
    getRestConfig: vi.fn(() => ({ endpoint: "http://fixture", token: "token", authSecret: new Uint8Array(32) })),
    kvGet: vi.fn(),
    kvMutate: vi.fn(),
    subscribeKvChanges: vi.fn(() => () => undefined),
}));

vi.mock("@/lib/protocol", () => protocol);

interface StoredTask {
    id: string;
    title: string;
    isDone: boolean;
    createdAt: number;
    updatedAt: number;
    sessionId?: string;
}

describe("Zen task deletion", () => {
    let storedTasks: StoredTask[];
    let storedVersion: number;

    beforeEach(() => {
        vi.clearAllMocks();
        storedTasks = [
            {
                id: "linked",
                title: "Linked task",
                isDone: false,
                createdAt: 1,
                updatedAt: 2,
                sessionId: "session-that-must-remain",
            },
            { id: "other", title: "Other task", isDone: false, createdAt: 3, updatedAt: 4 },
        ];
        storedVersion = 7;
        protocol.kvGet.mockImplementation(async () => ({
            key: "zen-tasks",
            value: JSON.stringify(storedTasks),
            version: storedVersion,
        }));
        protocol.kvMutate.mockImplementation(async (_config, mutations) => {
            const mutation = mutations[0];
            storedTasks = JSON.parse(mutation.value) as StoredTask[];
            storedVersion += 1;
            return { success: true, results: [{ key: "zen-tasks", version: storedVersion }] };
        });
    });

    it("persists removal of only the selected Zen task across a module reload", async () => {
        vi.resetModules();
        const firstModule = await import("@/lib/zenTasks");
        await firstModule.loadZenTasks();

        const remaining = await firstModule.deleteZenTask("linked");

        expect(remaining.map((task) => task.id)).toEqual(["other"]);
        expect(protocol.kvMutate).toHaveBeenCalledOnce();
        expect(protocol.kvMutate.mock.calls[0]?.[1]).toEqual([{
            key: "zen-tasks",
            value: JSON.stringify([{
                id: "other",
                title: "Other task",
                isDone: false,
                createdAt: 3,
                updatedAt: 4,
            }]),
            version: 7,
        }]);

        vi.resetModules();
        const reloadedModule = await import("@/lib/zenTasks");
        await expect(reloadedModule.loadZenTasks()).resolves.toEqual([expect.objectContaining({ id: "other" })]);
    });

    it("serializes local mutations so deletion cannot be overwritten by an older response", async () => {
        let resolveFirstMutation: ((value: unknown) => void) | undefined;
        const firstMutation = new Promise((resolve) => {
            resolveFirstMutation = resolve;
        });
        protocol.kvMutate
            .mockImplementationOnce(async () => firstMutation)
            .mockImplementationOnce(async (_config, mutations) => ({
                success: true,
                results: [{ key: "zen-tasks", version: 9 }],
                appliedValue: mutations[0]?.value,
            }));

        vi.resetModules();
        const zenTasks = await import("@/lib/zenTasks");
        await zenTasks.loadZenTasks();

        const toggle = zenTasks.toggleZenTask("other");
        const deletion = zenTasks.deleteZenTask("linked");
        await Promise.resolve();
        expect(protocol.kvMutate).toHaveBeenCalledTimes(1);

        resolveFirstMutation?.({ success: true, results: [{ key: "zen-tasks", version: 8 }] });
        await expect(toggle).resolves.toEqual([
            expect.objectContaining({ id: "linked" }),
            expect.objectContaining({ id: "other", isDone: true }),
        ]);
        await expect(deletion).resolves.toEqual([
            expect.objectContaining({ id: "other", isDone: true }),
        ]);

        expect(protocol.kvMutate).toHaveBeenCalledTimes(2);
        expect(protocol.kvMutate.mock.calls[1]?.[1]).toEqual([{
            key: "zen-tasks",
            value: expect.not.stringContaining('"id":"linked"'),
            version: 8,
        }]);
    });
});
