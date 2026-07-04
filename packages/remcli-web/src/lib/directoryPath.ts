const DIRECTORY_SEPARATORS = ["/", "\\"] as const;

type DirectorySeparator = (typeof DIRECTORY_SEPARATORS)[number];

function isDirectorySeparator(value: string): value is DirectorySeparator {
    return value === "/" || value === "\\";
}

function trimTrailingDirectorySeparators(path: string): string {
    let end = path.length;
    while (end > 1 && isDirectorySeparator(path[end - 1] ?? "")) {
        end -= 1;
    }
    return path.slice(0, end);
}

function preferredHomeSeparator(homeDir: string): DirectorySeparator {
    const lastForwardSlash = homeDir.lastIndexOf("/");
    const lastBackslash = homeDir.lastIndexOf("\\");
    return lastBackslash > lastForwardSlash ? "\\" : "/";
}

export function displayDirectoryPath(path: string, homeDir: string | undefined): string {
    if (!homeDir) return path;

    const normalizedHomeDir = trimTrailingDirectorySeparators(homeDir);
    if (trimTrailingDirectorySeparators(path) === normalizedHomeDir) return "~";
    if (!path.startsWith(normalizedHomeDir)) return path;

    const rest = path.slice(normalizedHomeDir.length);
    return isDirectorySeparator(rest[0] ?? "") ? `~${rest}` : path;
}

export function expandDirectoryPath(path: string, homeDir: string | undefined): string {
    if (!homeDir || !path.startsWith("~")) return path;

    const normalizedHomeDir = trimTrailingDirectorySeparators(homeDir);
    if (path === "~") return normalizedHomeDir;

    const inputSeparator = path[1];
    if (!isDirectorySeparator(inputSeparator ?? "")) return path;

    const separator = preferredHomeSeparator(homeDir);
    const rest = path.slice(2).replace(/[\\/]/g, separator);
    return `${normalizedHomeDir}${separator}${rest}`;
}
