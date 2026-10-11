import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from './config';
import { getDb } from './db';

function getFirebaseApp(): App | null {
  const raw = config.firebaseServiceAccount;
  if (!raw) {
    return null;
  }
  const existing = getApps()[0];
  if (existing) {
    return existing;
  }
  // Accepts the service account JSON as-is or base64-encoded, since multi-line
  // JSON is awkward to paste into hosting dashboards.
  const json = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw, 'base64').toString('utf8');
  return initializeApp({ credential: cert(JSON.parse(json)) });
}

export type StatusRequestReason = 'hourly' | 'live';

export interface PushResult {
  sent: number;
  failed: number;
  /** True when Firebase isn't configured, so nothing was attempted. */
  skipped: boolean;
}

const FCM_BATCH_SIZE = 500;
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends a silent data push asking each device to upload its current status.
 * Tokens FCM reports as dead are removed from their users.
 */
export async function sendStatusRequest(
  tokens: string[],
  reason: StatusRequestReason,
): Promise<PushResult> {
  const app = getFirebaseApp();
  if (!app) {
    console.warn('Push skipped: FIREBASE_SERVICE_ACCOUNT is not set');
    return { sent: 0, failed: 0, skipped: true };
  }

  const result: PushResult = { sent: 0, failed: 0, skipped: false };
  const deadTokens: string[] = [];

  for (let start = 0; start < tokens.length; start += FCM_BATCH_SIZE) {
    const batch = tokens.slice(start, start + FCM_BATCH_SIZE);
    const response = await getMessaging(app).sendEachForMulticast({
      tokens: batch,
      data: { type: 'STATUS_REQUEST', reason },
      // High priority so Android wakes the app even when it's in Doze.
      android: { priority: 'high', ttl: 5 * 60 * 1000 },
      apns: {
        headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
        payload: { aps: { contentAvailable: true } },
      },
    });
    result.sent += response.successCount;
    result.failed += response.failureCount;
    response.responses.forEach((item, index) => {
      if (item.error && DEAD_TOKEN_CODES.has(item.error.code)) {
        deadTokens.push(batch[index]);
      }
    });
  }

  if (deadTokens.length > 0) {
    const { users } = await getDb();
    await users.updateMany(
      { fcmToken: { $in: deadTokens } },
      { $set: { fcmToken: null } },
    );
  }
  return result;
}
