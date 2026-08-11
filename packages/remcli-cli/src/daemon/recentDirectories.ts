/**
 * Daemon-owned persistent project list for working directories.
 *
 * The store is intentionally separate from in-memory P2P/session state. It
 * keeps only machine-scoped paths, timestamps, pin preference and a safe
 * launch snapshot. Prompts, session IDs, tokens and transcripts are never
 * persisted here.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configuration } from '@/configuration';
import {
    createDirectoryPathContext,
    getDirectoryDisplayPath,
    type DirectoryPathContractDeps,
} from '@/daemon/directoryBrowser/pathContract';

export const MAX_DIRECTORY_PROJECTS = 20;

const DIRECTORY_PROJECTS_FILE_NAME = 'recent-directories.json';
const DIRECTORY_PROJECTS_FILE_MODE = 0o600;
const DIRECTORY_PROJECTS_FILE_VERSION = 2;

export type DirectoryProjectAgent = 'claude' | 'codex' | 'cursor' | 'gemini';
export type DirectoryProjectsErrorCode = 'unavailable' | 'invalid_machine_id' | 'invalid_directory';

export class DirectoryProjectsError extends Error {
    constructor(readonly code: DirectoryProjectsErrorCode) {
        super(code === 'invalid_machine_id'
            ? 'Directory projects are unavailable because this machine is not identified.'
            : code === 'invalid_directory'
                ? 'The directory project is unavailable.'
                : 'Directory projects are unavailable.');
        this.name = 'DirectoryProjectsError';
    }
}

export interface DirectoryProject {
    canonicalPath: string;
    displayPath: string;
    lastUsedAt: number;
    isPinned: boolean;
    lastAgent: DirectoryProjectAgent | null;
    branchAtLastLaunch: string | null;
}

export interface DirectoryProjectLaunchSnapshot {
    agent: DirectoryProjectAgent;
    branchAtLastLaunch: string | null;
}

export interface ListDirectoryProjectsResponse {
    projects: DirectoryProject[];
}

export interface ListDirectoryProjectsErrorResponse {
    error: {
        code: DirectoryProjectsErrorCode;
        message: string;
    };
}

export type ListDirectoryProjectsRpcResponse = ListDirectoryProjectsResponse | ListDirectoryProjectsErrorResponse;

export interface DirectoryProjectsStore {
    listProjects(): ListDirectoryProjectsResponse;
    recordSuccessfulSpawn(directory: string, snapshot: DirectoryProjectLaunchSnapshot): void;
    setProjectPinned(directory: string, isPinned: boolean): ListDirectoryProjectsResponse;
}

interface PersistedDirectoryProject {
    canonicalPath: string;
    displayPath: string;
    lastUsedAt: number;
    pinnedAt: number | null;
    lastAgent: DirectoryProjectAgent | null;
    branchAtLastLaunch: string | null;
}

interface LegacyRecentDirectory {
    canonicalPath: string;
    displayPath: string;
    lastUsedAt: number;
}

interface PersistedDirectoryProjects {
    v: typeof DIRECTORY_PROJECTS_FILE_VERSION;
    machines: Record<string, PersistedDirectoryProject[]>;
}

export interface DirectoryProjectsStoreDeps extends DirectoryPathContractDeps {
    machineId: string;
    filePath?: string;
    now?: () => number;
    resolveRealPath?: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDirectoryProjectAgent(value: unknown): value is DirectoryProjectAgent {
    return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'gemini';
}

function isNullableString(value: unknown): value is string | null {
    return value === null || (typeof value === 'string' && value.length <= 256);
}

function isLegacyRecentDirectory(value: unknown): value is LegacyRecentDirectory {
    if (!isRecord(value)) return false;

    return isNonEmptyString(value.canonicalPath)
        && isNonEmptyString(value.displayPath)
        && isTimestamp(value.lastUsedAt);
}

function isPersistedDirectoryProject(value: unknown): value is PersistedDirectoryProject {
    if (!isRecord(value)) return false;

    return isLegacyRecentDirectory(value)
        && (value.pinnedAt === null || isTimestamp(value.pinnedAt))
        && (value.lastAgent === null || isDirectoryProjectAgent(value.lastAgent))
        && isNullableString(value.branchAtLastLaunch);
}

function parsePersistedDirectoryProjects(value: unknown): PersistedDirectoryProjects | null {
    if (!isRecord(value) || !isRecord(value.machines)) {
        return null;
    }

    const machines: Record<string, PersistedDirectoryProject[]> = {};
    if (value.v === 1) {
        for (const [machineId, directories] of Object.entries(value.machines)) {
            if (!Array.isArray(directories) || !directories.every(isLegacyRecentDirectory)) {
                return null;
            }
            machines[machineId] = directories.map((directory) => ({
                ...directory,
                pinnedAt: null,
                lastAgent: null,
                branchAtLastLaunch: null,
            }));
        }
        return { v: DIRECTORY_PROJECTS_FILE_VERSION, machines };
    }

    if (value.v !== DIRECTORY_PROJECTS_FILE_VERSION) {
        return null;
    }

    for (const [machineId, projects] of Object.entries(value.machines)) {
        if (!Array.isArray(projects) || !projects.every(isPersistedDirectoryProject)) {
            return null;
        }
        machines[machineId] = projects.map((project) => ({ ...project }));
    }

    return { v: DIRECTORY_PROJECTS_FILE_VERSION, machines };
}

function sortDirectoryProjects(projects: PersistedDirectoryProject[]): PersistedDirectoryProject[] {
    return [...projects].sort((left, right) => {
        const leftIsPinned = left.pinnedAt !== null;
        const rightIsPinned = right.pinnedAt !== null;
        if (leftIsPinned !== rightIsPinned) {
            return leftIsPinned ? -1 : 1;
        }
        if (left.lastUsedAt !== right.lastUsedAt) {
            return right.lastUsedAt - left.lastUsedAt;
        }
        return left.canonicalPath.localeCompare(right.canonicalPath);
    });
}

function isExistingDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

function toDirectoryProject(project: PersistedDirectoryProject): DirectoryProject {
    return {
        canonicalPath: project.canonicalPath,
        displayPath: project.displayPath,
        lastUsedAt: project.lastUsedAt,
        isPinned: project.pinnedAt !== null,
        lastAgent: project.lastAgent,
        branchAtLastLaunch: project.branchAtLastLaunch,
    };
}

function normalizeBranchSnapshot(branch: string | null): string | null {
    if (branch === null) return null;
    const normalized = branch.trim();
    return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

export function getDirectoryProjectsFilePath(): string {
    return join(configuration.remcliHomeDir, DIRECTORY_PROJECTS_FILE_NAME);
}

/**
 * Creates a file-backed project list scoped to one persistent machine identity.
 * Invalid/corrupt contents are treated as an empty cache; filesystem failures
 * become typed, path-free errors safe to return over encrypted RPC.
 */
export function createDirectoryProjectsStore(deps: DirectoryProjectsStoreDeps): DirectoryProjectsStore {
    const machineId = deps.machineId;
    const filePath = deps.filePath ?? getDirectoryProjectsFilePath();
    const now = deps.now ?? Date.now;
    const resolveRealPath = deps.resolveRealPath ?? realpathSync;
    const initialPathContext = createDirectoryPathContext(deps);

    if (!machineId) {
        throw new DirectoryProjectsError('invalid_machine_id');
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

    function readPersisted(): PersistedDirectoryProjects {
        if (!existsSync(filePath)) {
            return { v: DIRECTORY_PROJECTS_FILE_VERSION, machines: {} };
        }

        try {
            const parsed = parsePersistedDirectoryProjects(JSON.parse(readFileSync(filePath, 'utf-8')) as unknown);
            return parsed ?? { v: DIRECTORY_PROJECTS_FILE_VERSION, machines: {} };
        } catch (error) {
            if (error instanceof SyntaxError) {
                return { v: DIRECTORY_PROJECTS_FILE_VERSION, machines: {} };
            }
            throw new DirectoryProjectsError('unavailable');
        }
    }

    function writePersisted(data: PersistedDirectoryProjects): void {
        const tempFilePath = `${filePath}.tmp`;

        try {
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(tempFilePath, JSON.stringify(data, null, 2), {
                encoding: 'utf-8',
                mode: DIRECTORY_PROJECTS_FILE_MODE,
            });
            renameSync(tempFilePath, filePath);
            chmodSync(filePath, DIRECTORY_PROJECTS_FILE_MODE);
        } catch {
            throw new DirectoryProjectsError('unavailable');
        }
    }

    function listFrom(data: PersistedDirectoryProjects): ListDirectoryProjectsResponse {
        const projects = sortDirectoryProjects(data.machines[machineId] ?? [])
            .filter((project) => isExistingDirectory(project.canonicalPath))
            .slice(0, MAX_DIRECTORY_PROJECTS)
            .map(toDirectoryProject);
        return { projects };
    }

    function getLiveProjects(data: PersistedDirectoryProjects): PersistedDirectoryProject[] {
        return (data.machines[machineId] ?? []).filter((project) => isExistingDirectory(project.canonicalPath));
    }

    return {
        listProjects(): ListDirectoryProjectsResponse {
            return listFrom(readPersisted());
        },

        recordSuccessfulSpawn(directory: string, snapshot: DirectoryProjectLaunchSnapshot): void {
            let canonicalPath: string;
            try {
                canonicalPath = resolveRealPath(directory);
            } catch {
                throw new DirectoryProjectsError('invalid_directory');
            }
            if (!isExistingDirectory(canonicalPath)) {
                throw new DirectoryProjectsError('invalid_directory');
            }

            const data = readPersisted();
            const currentProjects = getLiveProjects(data);
            const previousProject = currentProjects.find((project) => project.canonicalPath === canonicalPath);
            const recordedProject: PersistedDirectoryProject = {
                canonicalPath,
                displayPath: getDirectoryDisplayPath(canonicalPath, pathContext),
                lastUsedAt: now(),
                pinnedAt: previousProject?.pinnedAt ?? null,
                lastAgent: snapshot.agent,
                branchAtLastLaunch: normalizeBranchSnapshot(snapshot.branchAtLastLaunch),
            };
            const nextProjects = sortDirectoryProjects([
                recordedProject,
                ...currentProjects.filter((project) => project.canonicalPath !== canonicalPath),
            ]).slice(0, MAX_DIRECTORY_PROJECTS);

            writePersisted({
                v: DIRECTORY_PROJECTS_FILE_VERSION,
                machines: {
                    ...data.machines,
                    [machineId]: nextProjects,
                },
            });
        },

        setProjectPinned(directory: string, isPinned: boolean): ListDirectoryProjectsResponse {
            let canonicalPath: string;
            try {
                canonicalPath = resolveRealPath(directory);
            } catch {
                throw new DirectoryProjectsError('invalid_directory');
            }
            if (!isExistingDirectory(canonicalPath)) {
                throw new DirectoryProjectsError('invalid_directory');
            }

            const data = readPersisted();
            const currentProjects = getLiveProjects(data);
            const previousProject = currentProjects.find((project) => project.canonicalPath === canonicalPath);
            if (!previousProject && !isPinned) {
                return listFrom(data);
            }

            const project: PersistedDirectoryProject = previousProject
                ? {
                    ...previousProject,
                    pinnedAt: isPinned ? previousProject.pinnedAt ?? now() : null,
                }
                : {
                    canonicalPath,
                    displayPath: getDirectoryDisplayPath(canonicalPath, pathContext),
                    lastUsedAt: now(),
                    pinnedAt: now(),
                    lastAgent: null,
                    branchAtLastLaunch: null,
                };
            const nextData: PersistedDirectoryProjects = {
                v: DIRECTORY_PROJECTS_FILE_VERSION,
                machines: {
                    ...data.machines,
                    [machineId]: sortDirectoryProjects([
                        project,
                        ...currentProjects.filter((item) => item.canonicalPath !== canonicalPath),
                    ]).slice(0, MAX_DIRECTORY_PROJECTS),
                },
            };
            writePersisted(nextData);
            return listFrom(nextData);
        },
    };
}
