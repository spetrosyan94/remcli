/**
 * Cross-platform UUID generation.
 * Native: uses expo-crypto (secure native random).
 * Web: see uuid.web.ts (uses crypto.randomUUID).
 */
import { randomUUID } from 'expo-crypto';

export { randomUUID };
