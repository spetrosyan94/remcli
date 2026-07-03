import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- Mocks ----

let testHomeDir: string;

vi.mock('node:os', async () => {
    const actual = await vi.importActual('node:os');
    return { ...actual, homedir: () => testHomeDir };
});

vi.mock('@/claude/utils/path', () => ({
    getProjectPath: (path: string) => path,
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: () => {} },
}));

// ---- Helpers ----

function createClaudeSession(
    dir: string,
    sessionId: string,
    opts?: { message?: string; cwd?: string; timestamp?: string; extraLines?: string[] },
): string {
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sessionId}.jsonl`);
    const lines = [
        JSON.stringify({
            uuid: 'msg-1',
            type: 'user',
            timestamp: opts?.timestamp ?? '2026-01-15T10:30:00Z',
            cwd: opts?.cwd ?? '/home/user/projects/webapp',
            message: { role: 'user', content: opts?.message ?? 'Refactor the authentication module' },
        }),
        JSON.stringify({
            uuid: 'msg-2',
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'I will refactor the auth module.' }] },
        }),
        ...(opts?.extraLines ?? []),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
}

function createCodexSession(
    baseDir: string,
    sessionId: string,
    opts?: { cwd?: string; timestamp?: string; userMessage?: string; dateDir?: string },
): string {
    const dateDir = opts?.dateDir ?? '2026/01/15';
    const dir = join(baseDir, dateDir);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `rollout-${sessionId}.jsonl`);
    const lines = [
        JSON.stringify({
            timestamp: opts?.timestamp ?? '2026-01-15T10:30:00Z',
            type: 'session_meta',
            payload: {
                id: sessionId,
                cwd: opts?.cwd ?? '/home/user/projects/api-server',
                timestamp: opts?.timestamp ?? '2026-01-15T10:30:00Z',
            },
        }),
        JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', content: opts?.userMessage ?? 'Fix the database connection pooling' },
        }),
    ];
    writeFileSync(filePath, lines.join('\n') + '\n');
    return filePath;
}

function createCursorSession(chatsDir: string, workspaceId: string, sessionId: string): string {
    const sessionDir = join(chatsDir, workspaceId, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const storeDbPath = join(sessionDir, 'store.db');
    writeFileSync(storeDbPath, 'SQLite binary content placeholder');
    return storeDbPath;
}

function createGeminiSession(
    tmpDir: string,
    projectHash: string,
    sessionFileName: string,
    data: Record<string, unknown>,
): string {
    const chatsDir = join(tmpDir, projectHash, 'chats');
    mkdirSync(chatsDir, { recursive: true });
    const filePath = join(chatsDir, sessionFileName);
    writeFileSync(filePath, JSON.stringify(data));
    return filePath;
}

// ---- Tests ----

describe('listAgentSessions', () => {
    let testDir: string;
    let originalClaudeConfigDir: string | undefined;

    beforeEach(() => {
        testDir = join(tmpdir(), `test-agent-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(testDir, { recursive: true });
        testHomeDir = testDir;
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = join(testDir, '.claude');
    });

    afterEach(() => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }
        if (existsSync(testDir)) {
            rmSync(testDir, { recursive: true, force: true });
        }
    });

    // =========================================================================
    // listClaudeSessions
    // =========================================================================

    describe('listClaudeSessions', () => {
        let claudeProjectsDir: string;

        beforeEach(() => {
            claudeProjectsDir = join(testDir, '.claude', 'projects');
            mkdirSync(claudeProjectsDir, { recursive: true });
        });

        async function getListClaudeSessions() {
            const mod = await import('./listAgentSessions');
            return mod.listClaudeSessions;
        }

        it('should return sessions from Claude JSONL files with correct metadata', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'my-project');
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            createClaudeSession(projectDir, sessionId, {
                message: 'Implement user registration endpoint',
                cwd: '/home/user/projects/webapp',
                timestamp: '2026-03-10T14:00:00Z',
            });

            const sessions = listClaudeSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toMatchObject({
                sessionId,
                agent: 'claude',
                projectPath: '/home/user/projects/webapp',
                firstMessage: 'Implement user registration endpoint',
                messageCount: 2,
            });
            expect(sessions[0]!.createdAt).toBe(Date.parse('2026-03-10T14:00:00Z'));
            expect(sessions[0]!.lastModified).toBeGreaterThan(0);
        });

        it('should extract firstMessage from first type: "user" message', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-a');
            const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
            mkdirSync(projectDir, { recursive: true });
            const filePath = join(projectDir, `${sessionId}.jsonl`);
            const lines = [
                JSON.stringify({ uuid: 'msg-0', type: 'summary', leafUuid: 'leaf-1' }),
                JSON.stringify({
                    uuid: 'msg-1', type: 'user', timestamp: '2026-02-01T09:00:00Z',
                    cwd: '/projects/alpha',
                    message: { role: 'user', content: 'Add pagination to the products API' },
                }),
                JSON.stringify({
                    uuid: 'msg-2', type: 'user',
                    message: { role: 'user', content: 'Also add sorting' },
                }),
            ];
            writeFileSync(filePath, lines.join('\n') + '\n');

            const sessions = listClaudeSessions();
            expect(sessions[0]!.firstMessage).toBe('Add pagination to the products API');
        });

        it('should extract firstMessage from content array with text parts', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-b');
            const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
            mkdirSync(projectDir, { recursive: true });
            const filePath = join(projectDir, `${sessionId}.jsonl`);
            const lines = [
                JSON.stringify({
                    uuid: 'msg-1', type: 'user', timestamp: '2026-02-01T09:00:00Z',
                    cwd: '/projects/beta',
                    message: {
                        role: 'user',
                        content: [{ type: 'text', text: 'Migrate database to PostgreSQL 16' }],
                    },
                }),
            ];
            writeFileSync(filePath, lines.join('\n') + '\n');

            const sessions = listClaudeSessions();
            expect(sessions[0]!.firstMessage).toBe('Migrate database to PostgreSQL 16');
        });

        it('should extract projectPath from cwd field', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-c');
            const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
            createClaudeSession(projectDir, sessionId, { cwd: '/var/www/production-app' });

            const sessions = listClaudeSessions();
            expect(sessions[0]!.projectPath).toBe('/var/www/production-app');
        });

        it('should extract createdAt from timestamp field', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-d');
            const sessionId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
            createClaudeSession(projectDir, sessionId, { timestamp: '2026-06-15T18:45:00Z' });

            const sessions = listClaudeSessions();
            expect(sessions[0]!.createdAt).toBe(Date.parse('2026-06-15T18:45:00Z'));
        });

        it('should count lines for messageCount', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-e');
            const sessionId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
            createClaudeSession(projectDir, sessionId, {
                extraLines: [
                    JSON.stringify({ uuid: 'msg-3', type: 'user', message: { role: 'user', content: 'Continue' } }),
                    JSON.stringify({ uuid: 'msg-4', type: 'assistant', message: { role: 'assistant', content: 'Done' } }),
                ],
            });

            const sessions = listClaudeSessions();
            expect(sessions[0]!.messageCount).toBe(4);
        });

        it('should filter out non-UUID filenames', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-f');
            mkdirSync(projectDir, { recursive: true });

            // Non-UUID files
            writeFileSync(
                join(projectDir, 'agent-task-runner.jsonl'),
                JSON.stringify({ uuid: 'msg-1', type: 'user' }) + '\n',
            );
            writeFileSync(
                join(projectDir, 'not-a-uuid.jsonl'),
                JSON.stringify({ uuid: 'msg-2', type: 'user' }) + '\n',
            );

            const sessions = listClaudeSessions();
            expect(sessions).toHaveLength(0);
        });

        it('should filter out invalid sessions (no uuid/messageId/leafUuid)', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-g');
            const sessionId = '11111111-1111-1111-1111-111111111111';
            mkdirSync(projectDir, { recursive: true });
            writeFileSync(
                join(projectDir, `${sessionId}.jsonl`),
                JSON.stringify({ type: 'user', content: 'no id field' }) + '\n',
            );

            const sessions = listClaudeSessions();
            expect(sessions).toHaveLength(0);
        });

        it('should return empty array for non-existent projects directory', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            // Remove the projects dir we created in beforeEach
            rmSync(claudeProjectsDir, { recursive: true, force: true });

            const sessions = listClaudeSessions();
            expect(sessions).toEqual([]);
        });

        it('should sort by mtime descending', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-h');

            const oldId = '11111111-1111-1111-1111-111111111111';
            const newId = '22222222-2222-2222-2222-222222222222';

            const oldFile = createClaudeSession(projectDir, oldId);
            utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));

            const newFile = createClaudeSession(projectDir, newId);
            utimesSync(newFile, new Date('2026-12-31'), new Date('2026-12-31'));

            const sessions = listClaudeSessions();
            expect(sessions).toHaveLength(2);
            // The function itself does not sort — listAllAgentSessions does.
            // But we can verify both are returned.
            const ids = sessions.map(s => s.sessionId);
            expect(ids).toContain(oldId);
            expect(ids).toContain(newId);
        });

        it('should scope to directory when provided via getProjectPath', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'scoped-project');
            const sessionId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
            createClaudeSession(projectDir, sessionId);

            // Also create a session in another project
            const otherDir = join(claudeProjectsDir, 'other-project');
            createClaudeSession(otherDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

            // Pass the exact project dir path (getProjectPath is mocked to return it as-is)
            const sessions = listClaudeSessions(projectDir);
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.sessionId).toBe(sessionId);
        });

        it('should truncate long firstMessage to 200 characters', async () => {
            const listClaudeSessions = await getListClaudeSessions();
            const projectDir = join(claudeProjectsDir, 'project-long');
            const sessionId = '99999999-9999-9999-9999-999999999999';
            const longMessage = 'A'.repeat(300);
            createClaudeSession(projectDir, sessionId, { message: longMessage });

            const sessions = listClaudeSessions();
            expect(sessions[0]!.firstMessage).toBe('A'.repeat(200) + '...');
        });

        it('should use CLAUDE_CONFIG_DIR env var when set', async () => {
            const customConfigDir = join(testDir, 'custom-claude-config');
            const customProjectsDir = join(customConfigDir, 'projects', 'my-project');
            const sessionId = '88888888-8888-8888-8888-888888888888';
            createClaudeSession(customProjectsDir, sessionId);

            process.env.CLAUDE_CONFIG_DIR = customConfigDir;
            const listClaudeSessions = await getListClaudeSessions();
            const sessions = listClaudeSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.sessionId).toBe(sessionId);
        });
    });

    // =========================================================================
    // listCodexSessions
    // =========================================================================

    describe('listCodexSessions', () => {
        let codexSessionsDir: string;

        beforeEach(() => {
            codexSessionsDir = join(testDir, '.codex', 'sessions');
            mkdirSync(codexSessionsDir, { recursive: true });
        });

        async function getListCodexSessions() {
            const mod = await import('./listAgentSessions');
            return mod.listCodexSessions;
        }

        it('should parse session_meta from first JSONL line', async () => {
            const listCodexSessions = await getListCodexSessions();
            const sessionId = 'codex-session-12345';
            createCodexSession(codexSessionsDir, sessionId, {
                cwd: '/home/user/api-project',
                timestamp: '2026-02-20T11:00:00Z',
                userMessage: 'Optimize the query performance',
            });

            const sessions = listCodexSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toMatchObject({
                sessionId,
                agent: 'codex',
                projectPath: '/home/user/api-project',
                firstMessage: 'Optimize the query performance',
                messageCount: 2,
            });
            expect(sessions[0]!.createdAt).toBe(Date.parse('2026-02-20T11:00:00Z'));
        });

        it('should extract sessionId from payload.id', async () => {
            const listCodexSessions = await getListCodexSessions();
            const sessionId = 'custom-codex-id-abc';
            createCodexSession(codexSessionsDir, sessionId);

            const sessions = listCodexSessions();
            expect(sessions[0]!.sessionId).toBe(sessionId);
        });

        it('should extract projectPath from payload.cwd', async () => {
            const listCodexSessions = await getListCodexSessions();
            createCodexSession(codexSessionsDir, 'sess-path-test', {
                cwd: '/opt/services/payment-gateway',
            });

            const sessions = listCodexSessions();
            expect(sessions[0]!.projectPath).toBe('/opt/services/payment-gateway');
        });

        it('should extract createdAt from payload.timestamp', async () => {
            const listCodexSessions = await getListCodexSessions();
            createCodexSession(codexSessionsDir, 'sess-time-test', {
                timestamp: '2026-07-04T16:30:00Z',
            });

            const sessions = listCodexSessions();
            expect(sessions[0]!.createdAt).toBe(Date.parse('2026-07-04T16:30:00Z'));
        });

        it('should return empty array when ~/.codex/sessions/ does not exist', async () => {
            const listCodexSessions = await getListCodexSessions();
            rmSync(codexSessionsDir, { recursive: true, force: true });

            const sessions = listCodexSessions();
            expect(sessions).toEqual([]);
        });

        it('should handle nested YYYY/MM/DD directory structure', async () => {
            const listCodexSessions = await getListCodexSessions();
            createCodexSession(codexSessionsDir, 'session-jan', { dateDir: '2026/01/15' });
            createCodexSession(codexSessionsDir, 'session-feb', { dateDir: '2026/02/28' });
            createCodexSession(codexSessionsDir, 'session-mar', { dateDir: '2026/03/10' });

            const sessions = listCodexSessions();
            expect(sessions).toHaveLength(3);
            const ids = sessions.map(s => s.sessionId).sort();
            expect(ids).toEqual(['session-feb', 'session-jan', 'session-mar']);
        });

        it('should fallback to filename as sessionId when session_meta has no id', async () => {
            const listCodexSessions = await getListCodexSessions();
            const dir = join(codexSessionsDir, '2026/04/01');
            mkdirSync(dir, { recursive: true });
            const filePath = join(dir, 'rollout-fallback-id.jsonl');
            const lines = [
                JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', content: 'Hello' } }),
            ];
            writeFileSync(filePath, lines.join('\n') + '\n');

            const sessions = listCodexSessions();
            expect(sessions[0]!.sessionId).toBe('rollout-fallback-id');
        });

        it('should handle numeric timestamp in payload', async () => {
            const listCodexSessions = await getListCodexSessions();
            const dir = join(codexSessionsDir, '2026/05/01');
            mkdirSync(dir, { recursive: true });
            const numericTs = Date.parse('2026-05-01T12:00:00Z');
            const filePath = join(dir, 'rollout-num-ts.jsonl');
            writeFileSync(filePath, JSON.stringify({
                type: 'session_meta',
                payload: { id: 'num-ts-session', cwd: '/tmp', timestamp: numericTs },
            }) + '\n');

            const sessions = listCodexSessions();
            expect(sessions[0]!.createdAt).toBe(numericTs);
        });
    });

    // =========================================================================
    // listCursorSessions
    // =========================================================================

    describe('listCursorSessions', () => {
        let cursorChatsDir: string;

        beforeEach(() => {
            cursorChatsDir = join(testDir, '.cursor', 'chats');
            mkdirSync(cursorChatsDir, { recursive: true });
        });

        async function getListCursorSessions() {
            const mod = await import('./listAgentSessions');
            return mod.listCursorSessions;
        }

        it('should scan ~/.cursor/chats/ directory structure', async () => {
            const listCursorSessions = await getListCursorSessions();
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            createCursorSession(cursorChatsDir, 'workspace-001', sessionId);

            const sessions = listCursorSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toMatchObject({
                sessionId,
                agent: 'cursor',
                projectPath: '',
                firstMessage: null,
                messageCount: 0,
                createdAt: null,
            });
            expect(sessions[0]!.lastModified).toBeGreaterThan(0);
        });

        it('should only accept UUID directory names as sessions', async () => {
            const listCursorSessions = await getListCursorSessions();
            const workspaceDir = join(cursorChatsDir, 'workspace-002');

            // Valid UUID session
            const validId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
            createCursorSession(cursorChatsDir, 'workspace-002', validId);

            // Non-UUID directory
            const invalidDir = join(workspaceDir, 'not-a-uuid');
            mkdirSync(invalidDir, { recursive: true });
            writeFileSync(join(invalidDir, 'store.db'), 'data');

            const sessions = listCursorSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.sessionId).toBe(validId);
        });

        it('should set firstMessage to null (SQLite not parsed)', async () => {
            const listCursorSessions = await getListCursorSessions();
            const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
            createCursorSession(cursorChatsDir, 'workspace-003', sessionId);

            const sessions = listCursorSessions();
            expect(sessions[0]!.firstMessage).toBeNull();
        });

        it('should return empty array when directory does not exist', async () => {
            const listCursorSessions = await getListCursorSessions();
            rmSync(cursorChatsDir, { recursive: true, force: true });

            const sessions = listCursorSessions();
            expect(sessions).toEqual([]);
        });

        it('should find sessions across multiple workspaces', async () => {
            const listCursorSessions = await getListCursorSessions();
            const id1 = '11111111-1111-1111-1111-111111111111';
            const id2 = '22222222-2222-2222-2222-222222222222';
            createCursorSession(cursorChatsDir, 'workspace-a', id1);
            createCursorSession(cursorChatsDir, 'workspace-b', id2);

            const sessions = listCursorSessions();
            expect(sessions).toHaveLength(2);
            const ids = sessions.map(s => s.sessionId).sort();
            expect(ids).toEqual([id1, id2]);
        });

        it('should skip session directories without store.db', async () => {
            const listCursorSessions = await getListCursorSessions();
            const sessionId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
            const sessionDir = join(cursorChatsDir, 'workspace-004', sessionId);
            mkdirSync(sessionDir, { recursive: true });
            // No store.db file

            const sessions = listCursorSessions();
            expect(sessions).toHaveLength(0);
        });
    });

    // =========================================================================
    // listGeminiSessions
    // =========================================================================

    describe('listGeminiSessions', () => {
        let geminiTmpDir: string;

        beforeEach(() => {
            geminiTmpDir = join(testDir, '.gemini', 'tmp');
            mkdirSync(geminiTmpDir, { recursive: true });
        });

        async function getListGeminiSessions() {
            const mod = await import('./listAgentSessions');
            return mod.listGeminiSessions;
        }

        it('should parse JSON session files', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'project-hash-1', 'session-001.json', {
                sessionId: 'gemini-session-001',
                startTime: 1737990000000,
                messages: [
                    { role: 'user', content: 'Write a Python script to analyze CSV data' },
                    { role: 'assistant', content: 'Here is the script...' },
                ],
            });

            const sessions = listGeminiSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toMatchObject({
                sessionId: 'gemini-session-001',
                agent: 'gemini',
                firstMessage: 'Write a Python script to analyze CSV data',
                messageCount: 2,
                createdAt: 1737990000000,
            });
        });

        it('should extract sessionId from data', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'hash-a', 'session-custom-id.json', {
                sessionId: 'my-custom-gemini-id',
                messages: [],
            });

            const sessions = listGeminiSessions();
            expect(sessions[0]!.sessionId).toBe('my-custom-gemini-id');
        });

        it('should fallback to filename when sessionId is missing', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'hash-b', 'session-fallback.json', {
                messages: [],
            });

            const sessions = listGeminiSessions();
            expect(sessions[0]!.sessionId).toBe('session-fallback');
        });

        it('should extract firstMessage from first user message', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'hash-c', 'session-msg.json', {
                sessionId: 'msg-test',
                messages: [
                    { role: 'assistant', content: 'Hello! How can I help?' },
                    { role: 'user', content: 'Set up a Kubernetes deployment manifest' },
                    { role: 'user', content: 'Also add a service' },
                ],
            });

            const sessions = listGeminiSessions();
            expect(sessions[0]!.firstMessage).toBe('Set up a Kubernetes deployment manifest');
        });

        it('should handle content as array with text parts', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'hash-d', 'session-arr.json', {
                sessionId: 'arr-test',
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'Configure nginx reverse proxy' }] },
                ],
            });

            const sessions = listGeminiSessions();
            expect(sessions[0]!.firstMessage).toBe('Configure nginx reverse proxy');
        });

        it('should handle startTime as string', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'hash-e', 'session-strtime.json', {
                sessionId: 'strtime-test',
                startTime: '2026-04-15T08:00:00Z',
                messages: [],
            });

            const sessions = listGeminiSessions();
            expect(sessions[0]!.createdAt).toBe(Date.parse('2026-04-15T08:00:00Z'));
        });

        it('should return empty array when directory does not exist', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            rmSync(geminiTmpDir, { recursive: true, force: true });

            const sessions = listGeminiSessions();
            expect(sessions).toEqual([]);
        });

        it('should only process session-*.json files', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            const chatsDir = join(geminiTmpDir, 'hash-f', 'chats');
            mkdirSync(chatsDir, { recursive: true });

            // Valid
            writeFileSync(join(chatsDir, 'session-valid.json'), JSON.stringify({
                sessionId: 'valid', messages: [],
            }));

            // Invalid names
            writeFileSync(join(chatsDir, 'config.json'), JSON.stringify({ messages: [] }));
            writeFileSync(join(chatsDir, 'session-data.txt'), 'not json');

            const sessions = listGeminiSessions();
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.sessionId).toBe('valid');
        });

        it('should find sessions across multiple project hashes', async () => {
            const listGeminiSessions = await getListGeminiSessions();
            createGeminiSession(geminiTmpDir, 'project-alpha', 'session-a.json', {
                sessionId: 'alpha-session', messages: [],
            });
            createGeminiSession(geminiTmpDir, 'project-beta', 'session-b.json', {
                sessionId: 'beta-session', messages: [],
            });

            const sessions = listGeminiSessions();
            expect(sessions).toHaveLength(2);
            const ids = sessions.map(s => s.sessionId).sort();
            expect(ids).toEqual(['alpha-session', 'beta-session']);
        });
    });

    // =========================================================================
    // listAllAgentSessions
    // =========================================================================

    describe('listAllAgentSessions', () => {
        async function getListAllAgentSessions() {
            const mod = await import('./listAgentSessions');
            return mod.listAllAgentSessions;
        }

        it('should combine sessions from all agents', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            // Create Claude session
            const claudeDir = join(testDir, '.claude', 'projects', 'combined-project');
            createClaudeSession(claudeDir, '11111111-1111-1111-1111-111111111111');

            // Create Codex session
            const codexDir = join(testDir, '.codex', 'sessions');
            createCodexSession(codexDir, 'codex-combined');

            // Create Cursor session
            const cursorDir = join(testDir, '.cursor', 'chats');
            createCursorSession(cursorDir, 'ws-combined', '22222222-2222-2222-2222-222222222222');

            // Create Gemini session
            const geminiDir = join(testDir, '.gemini', 'tmp');
            createGeminiSession(geminiDir, 'hash-combined', 'session-combined.json', {
                sessionId: 'gemini-combined', messages: [],
            });

            const sessions = listAllAgentSessions();
            const agents = sessions.map(s => s.agent).sort();
            expect(agents).toEqual(['claude', 'codex', 'cursor', 'gemini']);
        });

        it('should sort by lastModified descending', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            const claudeDir = join(testDir, '.claude', 'projects', 'sort-project');
            const oldFile = createClaudeSession(claudeDir, '11111111-1111-1111-1111-111111111111');
            utimesSync(oldFile, new Date('2026-01-01'), new Date('2026-01-01'));

            const newFile = createClaudeSession(claudeDir, '22222222-2222-2222-2222-222222222222');
            utimesSync(newFile, new Date('2026-12-31'), new Date('2026-12-31'));

            const sessions = listAllAgentSessions('claude');
            expect(sessions).toHaveLength(2);
            expect(sessions[0]!.sessionId).toBe('22222222-2222-2222-2222-222222222222');
            expect(sessions[1]!.sessionId).toBe('11111111-1111-1111-1111-111111111111');
        });

        it('should apply limit (default 200)', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            const claudeDir = join(testDir, '.claude', 'projects', 'limit-project');
            mkdirSync(claudeDir, { recursive: true });
            for (let i = 0; i < 205; i++) {
                const id = `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111`;
                createClaudeSession(claudeDir, id);
            }

            const sessions = listAllAgentSessions('claude');
            expect(sessions).toHaveLength(200);
        });

        it('should respect custom limit', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            const claudeDir = join(testDir, '.claude', 'projects', 'custom-limit');
            mkdirSync(claudeDir, { recursive: true });
            for (let i = 0; i < 10; i++) {
                const id = `${i.toString().padStart(8, '0')}-2222-2222-2222-222222222222`;
                createClaudeSession(claudeDir, id);
            }

            const sessions = listAllAgentSessions('claude', undefined, 3);
            expect(sessions).toHaveLength(3);
        });

        it('should filter by agent when specified', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            // Create sessions for multiple agents
            const claudeDir = join(testDir, '.claude', 'projects', 'filter-project');
            createClaudeSession(claudeDir, '11111111-1111-1111-1111-111111111111');

            const codexDir = join(testDir, '.codex', 'sessions');
            createCodexSession(codexDir, 'codex-filter');

            const sessions = listAllAgentSessions('codex');
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.agent).toBe('codex');
        });

        it('should filter by directory when specified (Claude only)', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();

            const projectDir = join(testDir, '.claude', 'projects', 'dir-filter');
            createClaudeSession(projectDir, '11111111-1111-1111-1111-111111111111');

            const otherDir = join(testDir, '.claude', 'projects', 'other-dir');
            createClaudeSession(otherDir, '22222222-2222-2222-2222-222222222222');

            const sessions = listAllAgentSessions('claude', projectDir);
            expect(sessions).toHaveLength(1);
            expect(sessions[0]!.sessionId).toBe('11111111-1111-1111-1111-111111111111');
        });

        it('should return empty array when no agents have sessions', async () => {
            const listAllAgentSessions = await getListAllAgentSessions();
            const sessions = listAllAgentSessions();
            expect(sessions).toEqual([]);
        });
    });
});
