/**
 * Types for the machine-level directory browser RPC.
 *
 * The browser is intentionally read-only and exposes directories only, so the
 * web client can choose a working directory without daemon-side mutations.
 */

export interface ListDirectoryParams {
    path?: string;
}

export type DirectoryPathStyle = 'posix' | 'win32';

export interface DirectoryPathHomeMetadata {
    path: string;
    displayPath: string;
}

export interface DirectoryPathMetadata {
    style: DirectoryPathStyle;
    separator: string;
    home: DirectoryPathHomeMetadata;
}

export interface DirectoryBrowserEntry {
    name: string;
    path: string;
    displayPath: string;
    type: 'directory';
    hidden: boolean;
}

export interface ListDirectoryResponse extends DirectoryPathMetadata {
    path: string;
    displayPath: string;
    parent: string | null;
    parentDisplayPath: string | null;
    entries: DirectoryBrowserEntry[];
}
