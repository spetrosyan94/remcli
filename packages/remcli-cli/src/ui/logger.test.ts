import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Logger } from './logger';

const temporaryDirectories: string[] = [];

function createLogger(): { logger: Logger; logPath: string } {
    const directory = mkdtempSync(join(tmpdir(), 'remcli-logger-'));
    temporaryDirectories.push(directory);
    const logPath = join(directory, 'session.log');
    return { logger: new Logger(logPath), logPath };
}

afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('Logger.debugLargeJson', () => {
    it('does not write inspected payloads unless DEBUG is enabled', () => {
        vi.stubEnv('DEBUG', '');
        const { logger, logPath } = createLogger();

        logger.debugLargeJson('received payload', {
            Authorization: 'Bearer secret-value',
        });

        expect(existsSync(logPath)).toBe(false);
    });

    it('redacts sensitive fields and text before writing an inspected payload', () => {
        vi.stubEnv('DEBUG', '1');
        const { logger, logPath } = createLogger();
        const bearer = 'bearer-secret-value';
        const cookie = 'cookie-secret-value';
        const accessToken = 'access-token-value';

        logger.debugLargeJson('received payload', {
            headers: {
                Authorization: `Bearer ${bearer}`,
                Cookie: cookie,
            },
            endpoint: `https://example.test/run?access_token=${accessToken}`,
            safe: 'kept',
        });

        const output = readFileSync(logPath, 'utf8');
        expect(output).toContain('[REDACTED]');
        expect(output).toContain('"safe": "kept"');
        expect(output).not.toContain(bearer);
        expect(output).not.toContain(cookie);
        expect(output).not.toContain(accessToken);
    });
});
