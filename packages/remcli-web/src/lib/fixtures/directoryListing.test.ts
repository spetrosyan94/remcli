import { describe, expect, it } from 'vitest';
import { fixtureListDirectory } from '@/lib/fixtures';

describe('fixtureListDirectory', () => {
    it('returns daemon-shaped directory listing metadata for fixture mode', () => {
        const listing = fixtureListDirectory('fx-machine-online', '/Users/dev/projects/remcli');

        expect(listing).toMatchObject({
            path: '/Users/dev/projects/remcli',
            displayPath: '~/projects/remcli',
            style: 'posix',
            separator: '/',
            home: {
                path: '/Users/dev',
                displayPath: '~',
            },
            parent: '/Users/dev/projects',
            parentDisplayPath: '~/projects',
        });
        expect(listing.entries).toContainEqual({
            name: 'packages',
            path: '/Users/dev/projects/remcli/packages',
            displayPath: '~/projects/remcli/packages',
            type: 'directory',
            hidden: false,
        });
        expect(listing.entries).toContainEqual({
            name: '.claude',
            path: '/Users/dev/projects/remcli/.claude',
            displayPath: '~/projects/remcli/.claude',
            type: 'directory',
            hidden: true,
        });
    });

    it('throws a daemon-shaped error for restricted fixture directories', () => {
        expect(() => fixtureListDirectory('fx-machine-online', '/Users/dev/projects/remcli/restricted'))
            .toThrow('Unable to list directory "/Users/dev/projects/remcli/restricted": permission denied.');
    });
});
