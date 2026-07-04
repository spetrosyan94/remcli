/**
 * Read-only directory browser for machine RPC.
 *
 * Lists immediate child directories for a requested path. It does not create,
 * delete, write, recurse, or follow symlink entries.
 */

import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as os from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { DirectoryBrowserEntry, ListDirectoryResponse } from './types';

interface DirectoryBrowserDeps {
    getHomeDirectory?: () => string;
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

function getParentPath(path: string): string | null {
    const parent = dirname(path);
    return parent === path ? null : parent;
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
    const getHomeDirectory = deps.getHomeDirectory ?? os.homedir;
    const readDirectory = deps.readDirectory ?? readdir;
    const requestedPath = getPathParam(params);
    const currentPath = resolve(requestedPath ?? getHomeDirectory());

    let dirents: Dirent[];
    try {
        dirents = await readDirectory(currentPath, { withFileTypes: true });
    } catch (error) {
        throw new Error(getDirectoryReadErrorMessage(currentPath, error));
    }

    const entries = dirents
        .filter((entry) => entry.isDirectory())
        .map((entry): DirectoryBrowserEntry => ({
            name: entry.name,
            path: join(currentPath, entry.name),
            type: 'directory',
            hidden: entry.name.startsWith('.'),
        }))
        .sort(compareDirectoryEntries);

    return {
        path: currentPath,
        parent: getParentPath(currentPath),
        entries,
    };
}
