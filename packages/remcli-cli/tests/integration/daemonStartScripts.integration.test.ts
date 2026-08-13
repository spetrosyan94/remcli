import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface RootPackageJson {
    scripts?: Record<string, string | undefined>;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8'),
) as RootPackageJson;

describe('root daemon start scripts', () => {
    it.each([
        ['start', ''],
        ['start:tunnel', ' --tunnel'],
    ])('does not start a replacement after a failed daemon stop: %s', (scriptName, startArguments) => {
        expect(packageJson.scripts?.[scriptName]).toBe(
            `npm run build && node packages/remcli-cli/bin/remcli.mjs daemon stop && node packages/remcli-cli/bin/remcli.mjs daemon start-sync${startArguments}`,
        );
    });

});
