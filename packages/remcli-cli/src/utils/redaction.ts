const SENSITIVE_FIELD_NAME = /(token|secret|password|passphrase|credential|authorization|auth|key|cookie)/i;
const ENV_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const SENSITIVE_FLAG_VALUE = /(--[A-Za-z0-9-]*(?:token|secret|password|passphrase|credential|auth|key)[A-Za-z0-9-]*)(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]+)@/gi;
const URL_QUERY_VALUE = /([?&])([^=&\s]+)=([^&#\s]*)/g;
const DOUBLE_QUOTED_HEADER_VALUE = /"([A-Za-z0-9_-]+)"(\s*:\s*)"((?:\\.|[^"\\\r\n])*)"/g;
const SINGLE_QUOTED_HEADER_VALUE = /'([A-Za-z0-9_-]+)'(\s*:\s*)'((?:\\.|[^'\\\r\n])*)'/g;
const SENSITIVE_HEADER_VALUE = /\b([A-Za-z0-9_-]*(?:token|secret|password|passphrase|credential|authorization|auth|key|cookie)[A-Za-z0-9_-]*)(\s*:\s*)(?:(Bearer|Basic)\s+)?(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^'"\r\n]*)/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSensitiveName(name: string): boolean {
    return SENSITIVE_FIELD_NAME.test(name);
}

export function redactSensitiveText(value: string): string {
    return value
        .replace(URL_CREDENTIALS, (_match, prefix: string) => `${prefix}[REDACTED]@`)
        .replace(URL_QUERY_VALUE, (match: string, separator: string, name: string) => (
            isSensitiveName(name) ? `${separator}${name}=[REDACTED]` : match
        ))
        .replace(DOUBLE_QUOTED_HEADER_VALUE, (match: string, name: string, separator: string) => (
            isSensitiveName(name) ? `"${name}"${separator}"[REDACTED]"` : match
        ))
        .replace(SINGLE_QUOTED_HEADER_VALUE, (match: string, name: string, separator: string) => (
            isSensitiveName(name) ? `'${name}'${separator}'[REDACTED]'` : match
        ))
        .replace(SENSITIVE_HEADER_VALUE, (_match: string, name: string, separator: string, scheme?: string) => (
            `${name}${separator}${scheme ? `${scheme} ` : ''}[REDACTED]`
        ));
}

export function redactDiagnosticData(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redactDiagnosticData);
    }

    if (typeof value === 'string') {
        return redactSensitiveText(value);
    }

    if (value instanceof Error) {
        const error = value as Error & { cause?: unknown };
        const diagnosticError: Record<string, unknown> = Object.fromEntries(
            Object.entries(error).map(([key, nestedValue]) => [
                key,
                isSensitiveName(key) ? '[REDACTED]' : redactDiagnosticData(nestedValue),
            ])
        );
        diagnosticError.name = error.name;
        diagnosticError.message = redactSensitiveText(error.message);
        if (error.stack) {
            diagnosticError.stack = redactSensitiveText(error.stack);
        }
        if (error.cause !== undefined) {
            diagnosticError.cause = redactDiagnosticData(error.cause);
        }
        return diagnosticError;
    }

    if (!isRecord(value)) {
        return value;
    }

    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSensitiveName(key) ? '[REDACTED]' : redactDiagnosticData(nestedValue),
    ]));
}

export function redactSensitiveCommand(command: string): string {
    return redactSensitiveText(command
        .replace(ENV_ASSIGNMENT, (assignment: string, name: string) => (
            isSensitiveName(name) ? `${name}=[REDACTED]` : assignment
        ))
        .replace(SENSITIVE_FLAG_VALUE, (_match: string, flag: string) => `${flag}=[REDACTED]`));
}
