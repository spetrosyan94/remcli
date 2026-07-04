/**
 * Path contract helpers for directory browser RPCs.
 *
 * The daemon owns host path semantics because only it knows the remote machine
 * path style, separator, and home directory.
 */

import * as os from 'node:os';
import * as nodePath from 'node:path';

import type { DirectoryPathMetadata, DirectoryPathStyle } from './types';

export interface DirectoryPathTools {
    sep: string;
    dirname(path: string): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    resolve(...paths: string[]): string;
}

export interface DirectoryPathContractDeps {
    getHomeDirectory?: () => string;
    pathStyle?: DirectoryPathStyle;
    pathTools?: DirectoryPathTools;
}

export interface DirectoryPathContext {
    homePath: string;
    pathTools: DirectoryPathTools;
    separator: string;
    style: DirectoryPathStyle;
}

const DIRECTORY_SEPARATOR_PATTERN = /[\\/]+/g;

function getHostPathStyle(): DirectoryPathStyle {
    return process.platform === 'win32' ? 'win32' : 'posix';
}

function getPathTools(style: DirectoryPathStyle): DirectoryPathTools {
    return style === 'win32' ? nodePath.win32 : nodePath.posix;
}

function inferPathStyle(pathTools: DirectoryPathTools): DirectoryPathStyle {
    return pathTools.sep === '\\' ? 'win32' : 'posix';
}

function shouldExpandHomePath(path: string): boolean {
    return path === '~' || path.startsWith('~/') || path.startsWith('~\\');
}

function expandHomePath(path: string, context: DirectoryPathContext): string {
    if (!shouldExpandHomePath(path)) {
        return path;
    }

    if (path === '~') {
        return context.homePath;
    }

    const relativePath = path.slice(2).replace(DIRECTORY_SEPARATOR_PATTERN, context.separator);
    return context.pathTools.join(context.homePath, relativePath);
}

function isOutsideHome(relativePath: string, context: DirectoryPathContext): boolean {
    return (
        relativePath === '..' ||
        relativePath.startsWith(`..${context.separator}`) ||
        context.pathTools.isAbsolute(relativePath)
    );
}

export function createDirectoryPathContext(deps: DirectoryPathContractDeps = {}): DirectoryPathContext {
    const style = deps.pathStyle ?? (deps.pathTools ? inferPathStyle(deps.pathTools) : getHostPathStyle());
    const pathTools = deps.pathTools ?? getPathTools(style);
    const getHomeDirectory = deps.getHomeDirectory ?? os.homedir;
    const homePath = pathTools.resolve(getHomeDirectory());

    return {
        homePath,
        pathTools,
        separator: pathTools.sep,
        style,
    };
}

export function normalizeDirectoryPathValue(path: string, context: DirectoryPathContext): string {
    return context.pathTools.resolve(expandHomePath(path, context));
}

export function getDirectoryParentPath(path: string, context: DirectoryPathContext): string | null {
    const parentPath = context.pathTools.dirname(path);
    return parentPath === path ? null : parentPath;
}

export function getDirectoryDisplayPath(path: string, context: DirectoryPathContext): string {
    const canonicalPath = context.pathTools.resolve(path);
    const relativePath = context.pathTools.relative(context.homePath, canonicalPath);

    if (relativePath === '') {
        return '~';
    }

    if (isOutsideHome(relativePath, context)) {
        return canonicalPath;
    }

    return `~${context.separator}${relativePath}`;
}

export function getDirectoryPathMetadata(context: DirectoryPathContext): DirectoryPathMetadata {
    return {
        style: context.style,
        separator: context.separator,
        home: {
            path: context.homePath,
            displayPath: '~',
        },
    };
}
