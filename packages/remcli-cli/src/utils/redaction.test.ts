import { describe, expect, it } from 'vitest';

import { redactDiagnosticData, redactSensitiveCommand, redactSensitiveText } from './redaction';

describe('diagnostic redaction', () => {
    it('redacts nested credential fields while preserving safe diagnostics', () => {
        expect(redactDiagnosticData({
            pid: 1234,
            p2pSharedSecret: 'shared-secret',
            nested: {
                apiKey: 'api-key',
                endpoint: 'ws://127.0.0.1:45123',
            },
        })).toEqual({
            pid: 1234,
            p2pSharedSecret: '[REDACTED]',
            nested: {
                apiKey: '[REDACTED]',
                endpoint: 'ws://127.0.0.1:45123',
            },
        });
    });

    it('redacts sensitive environment assignments and command flags', () => {
        const command = [
            'REMCLI_DAEMON_RUNNER_TOKEN=runner-token',
            'codex',
            '--remote-auth-token super-secret',
            '--model gpt-5.6-luna',
        ].join(' ');

        expect(redactSensitiveCommand(command)).toBe([
            'REMCLI_DAEMON_RUNNER_TOKEN=[REDACTED]',
            'codex',
            '--remote-auth-token=[REDACTED]',
            '--model gpt-5.6-luna',
        ].join(' '));
    });

    it('redacts URL credentials, sensitive query values, and authorization headers', () => {
        const token = 'query-token-value';
        const password = 'url-password-value';
        const bearer = 'bearer-token-value';
        const command = [
            `curl 'https://user:${password}@example.test/status?token=${token}&page=2'`,
            `-H 'Authorization: Bearer ${bearer}'`,
        ].join(' ');

        const output = redactSensitiveText(command);

        expect(output).toContain('https://[REDACTED]@example.test/status?token=[REDACTED]&page=2');
        expect(output).toContain('Authorization: Bearer [REDACTED]');
        expect(output).not.toContain(token);
        expect(output).not.toContain(password);
        expect(output).not.toContain(bearer);
    });

    it('redacts complete Cookie and Set-Cookie header values', () => {
        const session = 'session-cookie-value';
        const refresh = 'refresh-cookie-value';
        const csrf = 'csrf-cookie-value';
        const quotedBearer = 'quoted-bearer-value';
        const genericHeader = 'generic-auth-token-value';
        const command = [
            `curl -H 'Cookie: session=${session}; refresh=${refresh}'`,
            `-H "Set-Cookie: csrf=${csrf}; HttpOnly; Secure"`,
            `-H 'Authorization: Bearer ${quotedBearer} with a quoted tail'`,
            `-H 'X-Auth-Token: ${genericHeader}'`,
        ].join(' ');

        const output = redactSensitiveText(command);

        expect(output).toContain("Cookie: [REDACTED]'");
        expect(output).toContain('Set-Cookie: [REDACTED]"');
        expect(output).toContain("Authorization: Bearer [REDACTED]'");
        expect(output).toContain("X-Auth-Token: [REDACTED]'");
        expect(output).not.toContain(session);
        expect(output).not.toContain(refresh);
        expect(output).not.toContain(csrf);
        expect(output).not.toContain(quotedBearer);
        expect(output).not.toContain(genericHeader);
    });

    it('redacts quoted JSON-style headers without hiding their diagnostic names', () => {
        const cookie = 'quoted-cookie-value';
        const setCookie = 'quoted-set-cookie-value';
        const bearer = 'quoted-bearer-value';
        const authToken = 'quoted-auth-token-value';
        const apiKey = 'quoted-api-key-value';
        const underscoreAuthToken = 'quoted-underscore-auth-token-value';
        const diagnostic = JSON.stringify({
            headers: {
                Cookie: cookie,
                'Set-Cookie': setCookie,
                Authorization: `Bearer ${bearer}`,
                'X-Auth-Token': authToken,
                api_key: apiKey,
                x_auth_token: underscoreAuthToken,
            },
        });

        const output = redactSensitiveText(diagnostic);

        expect(output).toContain('"Cookie":"[REDACTED]"');
        expect(output).toContain('"Set-Cookie":"[REDACTED]"');
        expect(output).toContain('"Authorization":"[REDACTED]"');
        expect(output).toContain('"X-Auth-Token":"[REDACTED]"');
        expect(output).toContain('"api_key":"[REDACTED]"');
        expect(output).toContain('"x_auth_token":"[REDACTED]"');
        expect(output).not.toContain(cookie);
        expect(output).not.toContain(setCookie);
        expect(output).not.toContain(bearer);
        expect(output).not.toContain(authToken);
        expect(output).not.toContain(apiKey);
        expect(output).not.toContain(underscoreAuthToken);
    });

    it('redacts sensitive text embedded in nested diagnostic data', () => {
        const output = redactDiagnosticData({
            endpoint: 'https://example.test/connect?access_token=access-token-value',
            nested: [{ header: 'X-Api-Key: api-key-value' }],
        });

        expect(output).toEqual({
            endpoint: 'https://example.test/connect?access_token=[REDACTED]',
            nested: [{ header: 'X-Api-Key: [REDACTED]' }],
        });
    });

    it('preserves safe Error diagnostics while redacting its message, stack, cause, and enumerable fields', () => {
        const secret = 'error-cookie-value';
        const accessToken = 'enumerable-access-token-value';
        const apiKey = 'enumerable-api-key-value';
        const error = new Error(`upstream rejected Cookie: ${secret}`) as Error & {
            cause?: unknown;
            accessToken?: string;
            api_key?: string;
            attempt?: number;
        };
        error.cause = { Authorization: `Bearer ${secret}` };
        error.accessToken = accessToken;
        error.api_key = apiKey;
        error.attempt = 3;

        const output = redactDiagnosticData(error);

        expect(output).toMatchObject({
            name: 'Error',
            message: 'upstream rejected Cookie: [REDACTED]',
            cause: { Authorization: '[REDACTED]' },
            accessToken: '[REDACTED]',
            api_key: '[REDACTED]',
            attempt: 3,
        });
        expect(JSON.stringify(output)).not.toContain(secret);
        expect(JSON.stringify(output)).not.toContain(accessToken);
        expect(JSON.stringify(output)).not.toContain(apiKey);
    });
});
