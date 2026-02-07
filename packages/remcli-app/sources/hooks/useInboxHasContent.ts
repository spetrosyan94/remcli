import { useUpdates } from './useUpdates';

// Hook to check if inbox has content to show
export function useInboxHasContent(): boolean {
    const { updateAvailable } = useUpdates();

    // Show dot if there's any actionable content:
    // - App updates available
    return updateAvailable;
}
