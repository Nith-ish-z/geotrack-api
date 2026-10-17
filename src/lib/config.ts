function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function numberFrom(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }
  return value;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Getters so a missing variable fails the request that needs it, not the build.
export const config = {
  get mongoUri() {
    return required('MONGODB_URI');
  },
  get mongoDb() {
    return process.env.MONGODB_DB || 'geotracker';
  },
  get jwtSecret() {
    const secret = required('JWT_SECRET');
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters');
    }
    return secret;
  },
  /** How long an issued token is valid. */
  get tokenTtlMs() {
    return numberFrom('JWT_EXPIRES_DAYS', 7) * DAY_MS;
  },
  /** How long after expiry a token can still be swapped for a new one. */
  get tokenRenewGraceMs() {
    return numberFrom('JWT_RENEW_GRACE_DAYS', 30) * DAY_MS;
  },
  get inviteTtlMs() {
    return numberFrom('INVITE_CODE_TTL_SECONDS', 120) * 1000;
  },
  get groupMaxMembers() {
    return numberFrom('GROUP_MAX_MEMBERS', 6);
  },
  /** Minimum gap between "send your status" pushes to one group. */
  get livePushIntervalMs() {
    return numberFrom('LIVE_PUSH_INTERVAL_SECONDS', 30) * 1000;
  },
  get firebaseServiceAccount() {
    return process.env.FIREBASE_SERVICE_ACCOUNT || null;
  },
  /**
   * The one login code every phone number accepts until an SMS provider is
   * wired in; see lib/otp.ts.
   */
  get staticOtp() {
    return process.env.STATIC_OTP || '1101';
  },
};

/**
 * A member shows as active (green dot) when their last report said the screen
 * was on and that report is at most this old. While anyone has the app open,
 * the others report every ~30 seconds, so this only expires for phones that
 * stopped answering.
 */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
/** Avatar upload limit, measured on the base64 text. */
export const AVATAR_MAX_BASE64_LENGTH = 200_000;
