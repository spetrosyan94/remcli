/**
 * Read-only directory browser for machine RPC.
 *
 * Lists immediate child directories for a requested path. It does not create,
 * delete, write, recurse, or follow symlink entries.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';

import {
    createDirectoryPathContext,
    getDirectoryDisplayPath,
    getDirectoryParentPath,
    getDirectoryPathMetadata,
    normalizeDirectoryPathValue,
    type DirectoryPathContractDeps,
} from './pathContract';
import type {
    DirectoryBrowserEntry,
    ListDirectoryResponse,
} from './types';

interface DirectoryBrowserDeps extends DirectoryPathContractDeps {
    readDirectory?: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
}

interface FileSystemError extends Error {
    code?: string;
}

function getPathParam(params: unknown): string | undefined {
    if (params === undefined || params === null) {
        return undefined;
    }

    if (typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('Params must be an object with optional path');
    }

    const value = (params as Record<string, unknown>).path;
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== 'string') {
        throw new Error('Path must be a string');
    }

    if (value.length === 0) {
        throw new Error('Path must be a non-empty string');
    }

    return value;
}

function isFileSystemError(error: unknown): error is FileSystemError {
    return error instanceof Error;
}

function getDirectoryReadErrorMessage(path: string, error: unknown): string {
    if (!isFileSystemError(error)) {
        return `Unable to list directory "${path}".`;
    }

    switch (error.code) {
        case 'EACCES':
        case 'EPERM':
            return `Unable to list directory "${path}": permission denied.`;
        case 'ENOENT':
            return `Unable to list directory "${path}": directory does not exist.`;
        case 'ENOTDIR':
            return `Unable to list directory "${path}": path is not a directory.`;
        default:
            return `Unable to list directory "${path}": ${error.message}`;
    }
}

function compareDirectoryEntries(left: DirectoryBrowserEntry, right: DirectoryBrowserEntry): number {
    if (left.hidden !== right.hidden) {
        return left.hidden ? 1 : -1;
    }

    return left.name.localeCompare(right.name);
}

export async function listDirectoryForBrowser(
    params: unknown = {},
    deps: DirectoryBrowserDeps = {},
): Promise<ListDirectoryResponse> {
    const readDirectory = deps.readDirectory ?? readdir;
    const pathContext = createDirectoryPathContext(deps);
    const requestedPath = getPathParam(params);
    const currentPath = requestedPath === undefined
        ? pathContext.homePath
        : normalizeDirectoryPathValue(requestedPath, pathContext);

    let dirents: Dirent[];
    try {
        dirents = await readDirectory(currentPath, { withFileTypes: true });
    } catch (error) {
        throw new Error(getDirectoryReadErrorMessage(currentPath, error));
    }

    const entries = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry): DirectoryBrowserEntry => {
            const entryPath = pathContext.pathTools.join(currentPath, entry.name);

            return {
                name: entry.name,
                path: entryPath,
                displayPath: getDirectoryDisplayPath(entryPath, pathContext),
                type: 'directory',
                hidden: entry.name.startsWith('.'),
            };
        })
        .sort(compareDirectoryEntries);

    const parent = getDirectoryParentPath(currentPath, pathContext);

    return {
        path: currentPath,
        displayPath: getDirectoryDisplayPath(currentPath, pathContext),
        parent,
        parentDisplayPath: parent === null ? null : getDirectoryDisplayPath(parent, pathContext),
        ...getDirectoryPathMetadata(pathContext),
        entries,
    };
}
