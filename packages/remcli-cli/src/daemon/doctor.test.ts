import { afterEach, describe, expect, it, vi } from 'vitest';

const psList = vi.hoisted(() => vi.fn());

vi.mock('ps-list', () => ({ default: psList }));

import { findAllRemcliProcesses } from './doctor';

afterEach(() => {
    psList.mockReset();
});

describe('findAllRemcliProcesses', () => {
    it('does not represent a discovery failure as an empty process list', async () => {
        psList.mockRejectedValue(new Error('ps-list unavailable'));

        await expect(findAllRemcliProcesses()).rejects.toThrow('Failed to discover Remcli processes');
    });
});
