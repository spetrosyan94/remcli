import React from 'react';
import { View, Text, ActivityIndicator, SectionList } from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { Item } from '@/components/Item';
import { ItemGroup } from '@/components/ItemGroup';
import { ItemList } from '@/components/ItemList';
import { machineListAgentSessions, machineSpawnNewSession } from '@/sync/ops';
import { sync } from '@/sync/sync';
import { storage, useSetting } from '@/sync/storage';
import { Modal } from '@/modal';
import { formatLastSeen } from '@/utils/sessionUtils';
import type { AgentSessionInfo } from '@/sync/ops';
import type { PermissionMode } from '@/components/PermissionModeSelector';

// Agent display configuration
const AGENT_ICONS: Record<string, { icon: string; color: string }> = {
    claude: { icon: 'logo-electron', color: '#D97706' },
    codex: { icon: 'code-slash-outline', color: '#10B981' },
    cursor: { icon: 'terminal-outline', color: '#6366F1' },
    gemini: { icon: 'sparkles-outline', color: '#3B82F6' },
};

/**
 * Groups sessions by projectPath for section list display.
 * Returns sections sorted by most recent session within each group.
 */
function groupSessionsByPath(sessions: AgentSessionInfo[]): Array<{ title: string; data: AgentSessionInfo[] }> {
    const groups = new Map<string, AgentSessionInfo[]>();

    for (const session of sessions) {
        const key = session.projectPath || 'Unknown';
        const existing = groups.get(key);
        if (existing) {
            existing.push(session);
        } else {
            groups.set(key, [session]);
        }
    }

    // Sort sessions within each group by lastModified desc
    const sections: Array<{ title: string; data: AgentSessionInfo[] }> = [];
    for (const [title, data] of groups) {
        data.sort((a, b) => b.lastModified - a.lastModified);
        sections.push({ title, data });
    }

    // Sort groups by the most recent session in each group
    sections.sort((a, b) => b.data[0].lastModified - a.data[0].lastModified);

    return sections;
}

function ResumeSessionScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{
        machineId: string;
        agent?: string;
        directory?: string;
    }>();

    const lastUsedPermissionMode = useSetting('lastUsedPermissionMode');

    const [sessions, setSessions] = React.useState<AgentSessionInfo[] | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [spawningId, setSpawningId] = React.useState<string | null>(null);

    // Load sessions on mount
    React.useEffect(() => {
        if (!params.machineId) return;

        let cancelled = false;

        (async () => {
            try {
                const result = await machineListAgentSessions(
                    params.machineId,
                    params.agent,
                    params.directory,
                    50
                );
                if (!cancelled) {
                    setSessions(result);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e instanceof Error ? e.message : 'Failed to load sessions');
                }
            }
        })();

        return () => { cancelled = true; };
    }, [params.machineId, params.agent, params.directory]);

    const sections = React.useMemo(() => {
        if (!sessions) return [];
        return groupSessionsByPath(sessions);
    }, [sessions]);

    const handleResume = React.useCallback(async (session: AgentSessionInfo) => {
        if (spawningId) return;
        setSpawningId(session.sessionId);

        try {
            const result = await machineSpawnNewSession({
                machineId: params.machineId,
                directory: session.projectPath || params.directory || '',
                resumeSessionId: session.sessionId,
                resumeSessionName: session.sessionName || undefined,
                agent: session.agent,
                approvedNewDirectoryCreation: true,
            });

            if (result && 'sessionId' in result && result.sessionId) {
                await sync.refreshSessions();

                // Apply permission mode from settings
                if (lastUsedPermissionMode) {
                    storage.getState().updateSessionPermissionMode(result.sessionId, lastUsedPermissionMode as PermissionMode);
                }

                router.replace(`/session/${result.sessionId}`, {
                    dangerouslySingular() {
                        return 'session';
                    },
                });
            } else {
                const errorMsg = result && 'errorMessage' in result ? result.errorMessage : 'Failed to resume session';
                Modal.alert(t('common.error'), errorMsg);
                setSpawningId(null);
            }
        } catch (e) {
            Modal.alert(t('common.error'), e instanceof Error ? e.message : 'Failed to resume session');
            setSpawningId(null);
        }
    }, [params.machineId, params.directory, spawningId, lastUsedPermissionMode, router]);

    // Loading state
    if (sessions === null && !error) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Resume Session',
                        headerBackTitle: t('common.back'),
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.centerContainer}>
                        <ActivityIndicator size="large" color={theme.colors.textSecondary} />
                    </View>
                </View>
            </>
        );
    }

    // Error state
    if (error) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Resume Session',
                        headerBackTitle: t('common.back'),
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.centerContainer}>
                        <Ionicons name="warning-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={styles.emptyText}>{error}</Text>
                    </View>
                </View>
            </>
        );
    }

    // Empty state
    if (sessions && sessions.length === 0) {
        return (
            <>
                <Stack.Screen
                    options={{
                        headerShown: true,
                        headerTitle: 'Resume Session',
                        headerBackTitle: t('common.back'),
                    }}
                />
                <View style={styles.container}>
                    <View style={styles.centerContainer}>
                        <Ionicons name="document-text-outline" size={48} color={theme.colors.textSecondary} />
                        <Text style={styles.emptyText}>{t('newSession.resumeSessionEmpty')}</Text>
                        <Text style={styles.emptySubtext}>{t('newSession.resumeSessionEmptyHint')}</Text>
                    </View>
                </View>
            </>
        );
    }

    // Sessions list
    return (
        <>
            <Stack.Screen
                options={{
                    headerShown: true,
                    headerTitle: 'Resume Session',
                    headerBackTitle: t('common.back'),
                }}
            />
            <ItemList>
                {sections.map((section) => (
                    <ItemGroup key={section.title} title={section.title}>
                        {section.data.map((session, index) => {
                            const agentConfig = AGENT_ICONS[session.agent] ?? AGENT_ICONS.claude;
                            const title = session.sessionName || session.firstMessage || t('newSession.resumeSessionUntitled');
                            const truncatedTitle = title.length > 80 ? title.slice(0, 80) + '...' : title;
                            const timeAgo = formatLastSeen(session.lastModified);
                            const subtitle = `${session.messageCount} message${session.messageCount !== 1 ? 's' : ''} \u00B7 ${timeAgo}`;
                            const isSpawning = spawningId === session.sessionId;
                            const isLast = index === section.data.length - 1;

                            return (
                                <Item
                                    key={session.sessionId}
                                    title={truncatedTitle}
                                    subtitle={subtitle}
                                    leftElement={
                                        <Ionicons
                                            name={agentConfig.icon as keyof typeof Ionicons.glyphMap}
                                            size={20}
                                            color={agentConfig.color}
                                        />
                                    }
                                    rightElement={
                                        params.agent ? undefined : (
                                            <Text style={styles.agentBadge}>{session.agent}</Text>
                                        )
                                    }
                                    onPress={() => handleResume(session)}
                                    loading={isSpawning}
                                    disabled={spawningId !== null}
                                    showDivider={!isLast}
                                />
                            );
                        })}
                    </ItemGroup>
                ))}
            </ItemList>
        </>
    );
}

export default React.memo(ResumeSessionScreen);

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.groupped.background,
    },
    centerContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
        gap: 12,
    },
    emptyText: {
        fontSize: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        ...Typography.default(),
    },
    emptySubtext: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        opacity: 0.7,
        ...Typography.default(),
    },
    agentBadge: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        textTransform: 'capitalize',
    },
}));
