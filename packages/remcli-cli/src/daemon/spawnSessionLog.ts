import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export function buildSafeSpawnSessionLogPayload(options: Partial<SpawnSessionOptions>): Record<string, unknown> {
    return {
        directory: options.directory,
        sessionId: options.sessionId,
        resumeSessionId: options.resumeSessionId,
        resumeSessionName: options.resumeSessionName,
        approvedNewDirectoryCreation: options.approvedNewDirectoryCreation,
        agent: options.agent,
        hasToken: Boolean(options.token),
        environmentVariableKeys: Object.keys(options.environmentVariables ?? {}),
    };
}
