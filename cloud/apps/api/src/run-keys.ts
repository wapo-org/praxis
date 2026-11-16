const CANCELLATION_KEY_PREFIX = 'cancel';

export const cancellationKey = (userId: string, runId: string): string =>
  `${CANCELLATION_KEY_PREFIX}:${userId}:${runId}`;
