import * as React from "react";
import { ActivityIndicator, Pressable, View, Text } from "react-native";
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { MarkdownView } from "./markdown/MarkdownView";
import { t } from '@/text';
import { Message, UserTextMessage, AgentTextMessage, ToolCallMessage } from "@/sync/typesMessage";
import { Metadata } from "@/sync/storageTypes";
import { layout } from "./layout";
import { ToolView } from "./tools/ToolView";
import { AgentEvent } from "@/sync/typesRaw";
import { sync } from '@/sync/sync';
import { Option } from './markdown/MarkdownView';
import { useSetting } from "@/sync/storage";
import { Ionicons } from '@expo/vector-icons';
import type { TtsState } from '@/hooks/useTts';

export interface TtsProps {
  ttsAvailable: boolean;
  /** The messageId currently being played/synthesized, or null */
  activeMessageId: string | null;
  ttsState: TtsState;
  onTtsPress: (text: string, messageId: string) => void;
}

export const MessageView = (props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  tts?: TtsProps;
}) => {
  return (
    <View style={styles.messageContainer} renderToHardwareTextureAndroid={true}>
      <View style={styles.messageContent}>
        <RenderBlock
          message={props.message}
          metadata={props.metadata}
          sessionId={props.sessionId}
          getMessageById={props.getMessageById}
          tts={props.tts}
        />
      </View>
    </View>
  );
};

// RenderBlock function that dispatches to the correct component based on message kind
function RenderBlock(props: {
  message: Message;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
  tts?: TtsProps;
}): React.ReactElement {
  switch (props.message.kind) {
    case 'user-text':
      return <UserTextBlock message={props.message} sessionId={props.sessionId} />;

    case 'agent-text':
      return <AgentTextBlock message={props.message} sessionId={props.sessionId} tts={props.tts} />;

    case 'tool-call':
      return <ToolCallBlock
        message={props.message}
        metadata={props.metadata}
        sessionId={props.sessionId}
        getMessageById={props.getMessageById}
      />;

    case 'agent-event':
      return <AgentEventBlock event={props.message.event} metadata={props.metadata} />;


    default:
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = props.message;
      throw new Error(`Unknown message kind: ${_exhaustive}`);
  }
}

function UserTextBlock(props: {
  message: UserTextMessage;
  sessionId: string;
}) {
  const isVoiceMessage = props.message.displayText?.startsWith('🎤') ?? false;

  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId]);

  return (
    <View style={styles.userMessageContainer}>
      <View style={[styles.userMessageBubble, isVoiceMessage && styles.voiceMessageBubble]}>
        {isVoiceMessage && (
          <View style={styles.voiceBadge}>
            <Text style={styles.voiceBadgeText}>🎤 Voice</Text>
          </View>
        )}
        <MarkdownView
          markdown={isVoiceMessage ? props.message.text : (props.message.displayText || props.message.text)}
          onOptionPress={handleOptionPress}
        />
      </View>
    </View>
  );
}

function AgentTextBlock(props: {
  message: AgentTextMessage;
  sessionId: string;
  tts?: TtsProps;
}) {
  const experiments = useSetting('experiments');
  const { theme } = useUnistyles();
  const handleOptionPress = React.useCallback((option: Option) => {
    sync.sendMessage(props.sessionId, option.title);
  }, [props.sessionId]);

  const handleTtsPress = React.useCallback(() => {
    if (props.tts) {
      props.tts.onTtsPress(props.message.text, props.message.id);
    }
  }, [props.tts, props.message.text, props.message.id]);

  // Hide thinking messages unless experiments is enabled
  if (props.message.isThinking && !experiments) {
    return null;
  }

  // Determine TTS button state for this specific message
  const isThisMessageActive = props.tts?.activeMessageId === props.message.id;
  const isSynthesizing = isThisMessageActive && props.tts?.ttsState === 'synthesizing';
  const isPlaying = isThisMessageActive && props.tts?.ttsState === 'playing';

  return (
    <View style={styles.agentMessageContainer}>
      <MarkdownView markdown={props.message.text} onOptionPress={handleOptionPress} />
      {props.tts?.ttsAvailable && !props.message.isThinking && (
        <View style={styles.ttsButtonRow}>
          <Pressable
            onPress={handleTtsPress}
            hitSlop={12}
            style={({ pressed }) => [
              styles.ttsButton,
              isPlaying && styles.ttsButtonActive,
              pressed && { opacity: 0.6 },
            ]}
          >
            {isSynthesizing ? (
              <ActivityIndicator size={16} color={theme.colors.textLink} />
            ) : (
              <Ionicons
                name={isPlaying ? 'volume-high' : 'volume-medium-outline'}
                size={18}
                color={isPlaying ? theme.colors.textLink : theme.colors.textSecondary}
              />
            )}
            <Text style={[
              styles.ttsButtonText,
              isPlaying && { color: theme.colors.textLink },
            ]}>
              {isSynthesizing ? 'Loading...' : isPlaying ? 'Playing' : 'Listen'}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function AgentEventBlock(props: {
  event: AgentEvent;
  metadata: Metadata | null;
}) {
  if (props.event.type === 'switch') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>{t('message.switchedToMode', { mode: props.event.mode })}</Text>
      </View>
    );
  }
  if (props.event.type === 'message') {
    return (
      <View style={styles.agentEventContainer}>
        <Text style={props.event.isError ? styles.agentEventError : styles.agentEventText}>{props.event.message}</Text>
      </View>
    );
  }
  if (props.event.type === 'limit-reached') {
    const formatTime = (timestamp: number): string => {
      try {
        const date = new Date(timestamp * 1000); // Convert from Unix timestamp
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return t('message.unknownTime');
      }
    };

    return (
      <View style={styles.agentEventContainer}>
        <Text style={styles.agentEventText}>
          {t('message.usageLimitUntil', { time: formatTime(props.event.endsAt) })}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.agentEventContainer}>
      <Text style={styles.agentEventText}>{t('message.unknownEvent')}</Text>
    </View>
  );
}

function ToolCallBlock(props: {
  message: ToolCallMessage;
  metadata: Metadata | null;
  sessionId: string;
  getMessageById?: (id: string) => Message | null;
}) {
  if (!props.message.tool) {
    return null;
  }
  return (
    <View style={styles.toolContainer}>
      <ToolView
        tool={props.message.tool}
        metadata={props.metadata}
        messages={props.message.children}
        sessionId={props.sessionId}
        messageId={props.message.id}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  messageContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  messageContent: {
    flexDirection: 'column',
    flexGrow: 1,
    flexBasis: 0,
    maxWidth: layout.maxWidth,
  },
  userMessageContainer: {
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
  },
  userMessageBubble: {
    backgroundColor: theme.colors.userMessageBackground,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 12,
    maxWidth: '100%',
  },
  voiceMessageBubble: {
    backgroundColor: theme.colors.voiceMessageBackground,
    borderWidth: 1,
    borderColor: theme.colors.voiceMessageBorder,
  },
  voiceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
    marginTop: 4,
  },
  voiceBadgeText: {
    fontSize: 11,
    color: theme.colors.textSecondary,
    fontWeight: '500',
  },
  agentMessageContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 16,
    alignSelf: 'flex-start',
  },
  agentEventContainer: {
    marginHorizontal: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  agentEventText: {
    color: theme.colors.agentEventText,
    fontSize: 14,
  },
  agentEventError: {
    color: theme.colors.textDestructive,
    fontSize: 14,
    fontWeight: '500',
  },
  toolContainer: {
    marginHorizontal: 8,
  },
  debugText: {
    color: theme.colors.agentEventText,
    fontSize: 12,
  },
  ttsButtonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginTop: 6,
    marginBottom: 4,
  },
  ttsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.divider,
  },
  ttsButtonActive: {
    backgroundColor: `${theme.colors.textLink}15`,
    borderColor: theme.colors.textLink,
  },
  ttsButtonText: {
    fontSize: 12,
    fontWeight: '500',
    color: theme.colors.textSecondary,
  },
}));
