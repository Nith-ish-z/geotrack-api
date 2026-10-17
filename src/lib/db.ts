import { Collection, Db, MongoClient, ObjectId } from 'mongodb';
import { config } from './config';

export type SoundMode = 'silent' | 'vibrate' | 'normal';

export type LocationMode =
  | 'share'
  | 'pause_30m'
  | 'pause_1h'
  | 'pause_2h'
  | 'pause_5h'
  | 'pause_12h'
  | 'pause_1d'
  | 'pause_7d';

export interface Preferences {
  shareLocation: boolean;
  locationMode: LocationMode;
  /** Set by the server from locationMode; sharing resumes after this. */
  pauseUntil: Date | null;
  shareBattery: boolean;
  shareScreen: boolean;
  shareSound: boolean;
}

export interface DeviceStatus {
  battery: number | null;
  charging: boolean | null;
  soundMode: SoundMode | null;
  screenOn: boolean | null;
  location: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
    updatedAt: Date;
  } | null;
  updatedAt: Date;
}

export interface Session {
  /** ID of the one token currently valid for this user. */
  jti: string;
  expiresAt: Date;
  /**
   * The token replaced by the last renewal, honoured briefly so requests that
   * were already in flight don't get logged out.
   */
  previousJti: string | null;
  previousValidUntil: Date | null;
}

export interface UserDoc {
  _id: ObjectId;
  phone: string;
  name: string;
  avatar: { contentType: string; base64: string; version: number } | null;
  groupId: ObjectId | null;
  session: Session | null;
  fcmToken: string | null;
  preferences: Preferences;
  status: DeviceStatus | null;
  /** Last foreground heartbeat from the app; only used to trigger pushes. */
  lastActiveAt: Date | null;
  /** Last time the phone reported in at all, with or without changes. */
  lastHeardAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GroupDoc {
  _id: ObjectId;
  /** Random public identifier; groups have no user-facing name. */
  slug: string;
  creatorId: ObjectId;
  memberIds: ObjectId[];
  invite: { code: string; expiresAt: Date } | null;
  lastLivePushAt: Date | null;
  createdAt: Date;
}

export const defaultPreferences: Preferences = {
  shareLocation: true,
  locationMode: 'share',
  pauseUntil: null,
  shareBattery: true,
  shareScreen: true,
  shareSound: true,
};

interface Collections {
  db: Db;
  users: Collection<UserDoc>;
  groups: Collection<GroupDoc>;
}

// Cached on globalThis so dev hot reloads and warm serverless invocations
// reuse one connection pool.
const globalCache = globalThis as typeof globalThis & {
  __geotrackerDb?: Promise<Collections>;
};

async function connect(): Promise<Collections> {
  const client = await new MongoClient(config.mongoUri).connect();
  const db = client.db(config.mongoDb);
  const users = db.collection<UserDoc>('users');
  const groups = db.collection<GroupDoc>('groups');

  await Promise.all([
    users.createIndex({ phone: 1 }, { unique: true }),
    users.createIndex({ groupId: 1 }),
    groups.createIndex({ slug: 1 }, { unique: true }),
    groups.createIndex({ 'invite.code': 1 }),
  ]);

  return { db, users, groups };
}

export function getDb(): Promise<Collections> {
  if (!globalCache.__geotrackerDb) {
    globalCache.__geotrackerDb = connect().catch(error => {
      globalCache.__geotrackerDb = undefined;
      throw error;
    });
  }
  return globalCache.__geotrackerDb;
}
