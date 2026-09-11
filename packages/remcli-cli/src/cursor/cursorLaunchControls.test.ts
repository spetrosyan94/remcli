import { describe, expect, it } from 'vitest';

import {
    DEFAULT_CURSOR_LAUNCH_CONTROLS,
    isCursorLaunchControls,
} from './cursorLaunchControls';

describe('Cursor launch-control validation', () => {
    it('accepts the complete ACP mode contract', () => {
        expect(isCursorLaunchControls({ ...DEFAULT_CURSOR_LAUNCH_CONTROLS })).toBe(true);
    });

    it.each([
        ['a missing required field', {}],
        ['an unknown execution mode', {
            ...DEFAULT_CURSOR_LAUNCH_CONTROLS,
            executionMode: 'force',
        }],
        ['an extra property', {
            ...DEFAULT_CURSOR_LAUNCH_CONTROLS,
            force: true,
        }],
        ['a non-plain object', Object.assign(Object.create(null), DEFAULT_CURSOR_LAUNCH_CONTROLS)],
        ['an array', [DEFAULT_CURSOR_LAUNCH_CONTROLS]],
    ] as const)('rejects %s', (_caseName, controls) => {
        expect(isCursorLaunchControls(controls)).toBe(false);
    });

    it('fails closed when property access throws', () => {
        const controls = new Proxy({ ...DEFAULT_CURSOR_LAUNCH_CONTROLS }, {
            get(target, property, receiver) {
                if (property === 'executionMode') {
                    throw new Error('untrusted getter');
                }
                return Reflect.get(target, property, receiver);
            },
        });

        expect(isCursorLaunchControls(controls)).toBe(false);
    });
});
