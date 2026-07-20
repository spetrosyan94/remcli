/**
 * Daemon-owned persistent MRU for working directories.
 *
 * The store is intentionally separate from the in-memory P2P/session state.
 * It contains only machine-scoped paths and timestamps; prompts, tokens, and
 * session metadata are never persisted here.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import {
    createDirectoryPathContext,
    getDirectoryDisplayPath,
    type DirectoryPathContractDeps,
} from '@/daemon/directoryBrowser/pathContract';

export const MAX_RECENT_DIRECTORIES = 20;

const RECENT_DIRECTORIES_FILE_NAME = 'recent-directories.json';
const RECENT_DIRECTORIES_FILE_MODE = 0o600;
const RECENT_DIRECTORIES_FILE_VERSION = 1;

export type RecentDirectoriesErrorCode = 'unavailable' | 'invalid_machine_id';

export class RecentDirectoriesError extends Error {
    constructor(readonly code: RecentDirectoriesErrorCode) {
        super(code === 'invalid_machine_id'
            ? 'Recent directories are unavailable because this machine is not identified.'
            : 'Recent directories are unavailable.');
        this.name = 'RecentDirectoriesError';
    }
}

export interface RecentDirectory {
    canonicalPath: string;
    displayPath: string;
    lastUsedAt: number;
}

export interface ListRecentDirectoriesResponse {
    directories: RecentDirectory[];
}

export interface ListRecentDirectoriesErrorResponse {
    error: {
        code: RecentDirectoriesErrorCode;
        message: string;
    };
}

export type ListRecentDirectoriesRpcResponse = ListRecentDirectoriesResponse | ListRecentDirectoriesErrorResponse;

export interface RecentDirectoriesStore {
    list(): ListRecentDirectoriesResponse;
    recordSuccessfulSpawn(directory: string): void;
}

interface PersistedRecentDirectories {
    v: typeof RECENT_DIRECTORIES_FILE_VERSION;
    machines: Record<string, RecentDirectory[]>;
}

export interface RecentDirectoriesStoreDeps extends DirectoryPathContractDeps {
    machineId: string;
    filePath?: string;
    now?: () => number;
    resolveRealPath?: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecentDirectory(value: unknown): value is RecentDirectory {
    if (!isRecord(value)) return false;

    return typeof value.canonicalPath === 'string'
        && value.canonicalPath.length > 0
        && typeof value.displayPath === 'string'
        && value.displayPath.length > 0
        && typeof value.lastUsedAt === 'number'
        && Number.isFinite(value.lastUsedAt)
        && value.lastUsedAt >= 0;
}

function parsePersistedRecentDirectories(value: unknown): PersistedRecentDirectories | null {
    if (!isRecord(value) || value.v !== RECENT_DIRECTORIES_FILE_VERSION || !isRecord(value.machines)) {
        return null;
    }

    const machines: Record<string, RecentDirectory[]> = {};
    for (const [machineId, directories] of Object.entries(value.machines)) {
        if (!Array.isArray(directories) || !directories.every(isRecentDirectory)) {
            return null;
        }

        machines[machineId] = directories.map((directory) => ({ ...directory }));
    }

    return { v: RECENT_DIRECTORIES_FILE_VERSION, machines };
}

function sortRecentDirectories(directories: RecentDirectory[]): RecentDirectory[] {
    return [...directories].sort((left, right) => {
        if (left.lastUsedAt !== right.lastUsedAt) {
            return right.lastUsedAt - left.lastUsedAt;
        }

        return left.canonicalPath.localeCompare(right.canonicalPath);
    });
}

export function getRecentDirectoriesFilePath(): string {
    return join(configuration.remcliHomeDir, RECENT_DIRECTORIES_FILE_NAME);
}

/**
 * Creates a file-backed MRU store scoped to one persistent machine identity.
 * Invalid/corrupt contents are treated as an empty cache; filesystem failures
 * become a typed, path-free error safe to return over encrypted RPC.
 */
export function createRecentDirectoriesStore(deps: RecentDirectoriesStoreDeps): RecentDirectoriesStore {
    const machineId = deps.machineId;
    const filePath = deps.filePath ?? getRecentDirectoriesFilePath();
    const now = deps.now ?? Date.now;
    const resolveRealPath = deps.resolveRealPath ?? realpathSync;
    const initialPathContext = createDirectoryPathContext(deps);

    if (!machineId) {
        throw new RecentDirectoriesError('invalid_machine_id');
    }

    let canonicalHomePath = initialPathContext.homePath;
    try {
        canonicalHomePath = resolveRealPath(initialPathContext.homePath);
    } catch {
        // The home directory is available in normal daemon operation. Falling
        // back preserves a useful display path in constrained test/sandbox envs.
    }
    const pathContext = {
        ...initialPathContext,
        homePath: canonicalHomePath,
    };

    function readPersisted(): PersistedRecentDirectories {
        if (!existsSync(filePath)) {
            return { v: RECENT_DIRECTORIES_FILE_VERSION, machines: {} };
        }

        try {
            const parsed = parsePersistedRecentDirectories(JSON.parse(readFileSync(filePath, 'utf-8')) as unknown);
            return parsed ?? { v: RECENT_DIRECTORIES_FILE_VERSION, machines: {} };
        } catch (error) {
            if (error instanceof SyntaxError) {
                return { v: RECENT_DIRECTORIES_FILE_VERSION, machines: {} };
            }

            throw new RecentDirectoriesError('unavailable');
        }
    }

    function writePersisted(data: PersistedRecentDirectories): void {
        const tempFilePath = `${filePath}.tmp`;

        try {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(tempFilePath, JSON.stringify(data, null, 2), {
                encoding: 'utf-8',
                mode: RECENT_DIRECTORIES_FILE_MODE,
            });
            renameSync(tempFilePath, filePath);
            chmodSync(filePath, RECENT_DIRECTORIES_FILE_MODE);
        } catch {
            throw new RecentDirectoriesError('unavailable');
        }
    }

    return {
        list(): ListRecentDirectoriesResponse {
            const data = readPersisted();
            return {
                directories: sortRecentDirectories(data.machines[machineId] ?? [])
                    .slice(0, MAX_RECENT_DIRECTORIES),
            };
        },

        recordSuccessfulSpawn(directory: string): void {
            let canonicalPath: string;
            try {
                canonicalPath = resolveRealPath(directory);
            } catch {
                throw new RecentDirectoriesError('unavailable');
            }

            const data = readPersisted();
            const recordedDirectory: RecentDirectory = {
                canonicalPath,
                displayPath: getDirectoryDisplayPath(canonicalPath, pathContext),
                lastUsedAt: now(),
            };
            const currentDirectories = data.machines[machineId] ?? [];
            const nextDirectories = sortRecentDirectories([
                recordedDirectory,
                ...currentDirectories.filter((item) => item.canonicalPath !== canonicalPath),
            ]).slice(0, MAX_RECENT_DIRECTORIES);

            writePersisted({
                v: RECENT_DIRECTORIES_FILE_VERSION,
                machines: {
                    ...data.machines,
                    [machineId]: nextDirectories,
                },
            });
        },
    };
}
