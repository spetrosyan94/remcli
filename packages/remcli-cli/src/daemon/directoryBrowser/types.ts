/**
 * Types for the machine-level directory browser RPC.
 *
 * The browser is intentionally read-only and exposes directories only, so the
 * web client can choose a working directory without daemon-side mutations.
 */

export interface ListDirectoryParams {
    path?: string;
}

export interface DirectoryBrowserEntry {
    name: string;
    path: string;
    type: 'directory';
    hidden: boolean;
}

export interface ListDirectoryResponse {
    path: string;
    parent: string | null;
    entries: DirectoryBrowserEntry[];
}
