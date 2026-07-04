const CONCIERGE_SPEAKER_PREFIX_PATTERN = /^(?:\s*(?:(?:джарвис|jarvis|консьерж|concierge|ассистент|assistant)\s*[:：\-–—]|ai\s*[:：])\s*)+/i;

export function stripConciergeSpeakerPrefix(content: string): string {
    const stripped = content.replace(CONCIERGE_SPEAKER_PREFIX_PATTERN, "").trimStart();
    return stripped.length > 0 ? stripped : content.trimStart();
}
