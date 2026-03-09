/**
 * VoiceRecordingBar
 *
 * Visual feedback bar shown in place of the TextInput when voice recording
 * or transcription is active. Shows animated VoiceBars + elapsed timer
 * during recording, and an ActivityIndicator during transcription.
 */

import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { VoiceBars } from './VoiceBars';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

interface VoiceRecordingBarProps {
    state: 'recording' | 'transcribing';
    elapsedSeconds: number;
    onStop: () => void;
}

function formatElapsed(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const VoiceRecordingBar = React.memo(({ state, elapsedSeconds, onStop }: VoiceRecordingBarProps) => {
    const { theme } = useUnistyles();

    if (state === 'transcribing') {
        return (
            <View style={styles.container}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={[styles.transcribingText, { color: theme.colors.textSecondary }]}>
                    {t('whisper.transcribing')}
                </Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.recordingIndicator}>
                <View style={[styles.redDot, { backgroundColor: '#FF3B30' }]} />
            </View>
            <VoiceBars isActive={true} color={theme.colors.textSecondary} size="medium" />
            <Text style={[styles.timerText, { color: theme.colors.text }]}>
                {formatElapsed(elapsedSeconds)}
            </Text>
            <View style={{ flex: 1 }} />
            <Pressable
                onPress={onStop}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={({ pressed }) => [
                    styles.stopButton,
                    { opacity: pressed ? 0.7 : 1 }
                ]}
            >
                <View style={styles.stopIcon} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 40,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 10,
    },
    recordingIndicator: {
        width: 8,
        height: 8,
        justifyContent: 'center',
        alignItems: 'center',
    },
    redDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    timerText: {
        fontSize: 15,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
    transcribingText: {
        fontSize: 14,
        ...Typography.default(),
    },
    stopButton: {
        width: 28,
        height: 28,
        borderRadius: 14,
        backgroundColor: '#FF3B30',
        justifyContent: 'center',
        alignItems: 'center',
    },
    stopIcon: {
        width: 10,
        height: 10,
        borderRadius: 2,
        backgroundColor: '#FFFFFF',
    },
}));
