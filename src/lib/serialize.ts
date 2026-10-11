import { ObjectId } from 'mongodb';
import { ACTIVE_WINDOW_MS, config } from './config';
import { GroupDoc, LocationMode, Preferences, UserDoc } from './db';

const PAUSE_DURATIONS_MS: Record<Exclude<LocationMode, 'share'>, number> = {
  pause_30m: 30 * 60 * 1000,
  pause_1h: 60 * 60 * 1000,
  pause_2h: 2 * 60 * 60 * 1000,
  pause_5h: 5 * 60 * 60 * 1000,
  pause_12h: 12 * 60 * 60 * 1000,
  pause_1d: 24 * 60 * 60 * 1000,
  pause_7d: 7 * 24 * 60 * 60 * 1000,
};

export function pauseUntilFor(mode: LocationMode, now: Date): Date | null {
  return mode === 'share'
    ? null
    : new Date(now.getTime() + PAUSE_DURATIONS_MS[mode]);
}

/** Preferences as the app sees them: a pause that has run out reads as "share". */
export function currentPreferences(prefs: Preferences, now: Date) {
  const paused = !!prefs.pauseUntil && prefs.pauseUntil > now;
  return {
    shareLocation: prefs.shareLocation,
    locationMode: paused ? prefs.locationMode : ('share' as LocationMode),
    pauseUntil: paused ? prefs.pauseUntil : null,
    shareBattery: prefs.shareBattery,
    shareScreen: prefs.shareScreen,
    shareSound: prefs.shareSound,
  };
}

function avatarUrl(user: UserDoc): string | null {
  return user.avatar
    ? `/api/users/${user._id.toHexString()}/avatar?v=${user.avatar.version}`
    : null;
}

export function serializeSelf(user: UserDoc, now: Date) {
  return {
    id: user._id.toHexString(),
    name: user.name,
    phone: user.phone,
    avatarUrl: avatarUrl(user),
    preferences: currentPreferences(user.preferences, now),
  };
}

/**
 * One row of the group list. Other members only get the fields the member has
 * chosen to share; a member always sees their own data in full.
 */
export function serializeMember(
  member: UserDoc,
  viewerId: ObjectId,
  creatorId: ObjectId | null,
  now: Date,
) {
  const isSelf = member._id.equals(viewerId);
  const prefs = currentPreferences(member.preferences, now);
  const status = member.status;
  const locationShared = prefs.shareLocation && prefs.locationMode === 'share';

  const location =
    status?.location && (isSelf || locationShared)
      ? {
          latitude: status.location.latitude,
          longitude: status.location.longitude,
          accuracy: status.location.accuracy,
          updatedAt: status.location.updatedAt,
        }
      : null;

  const lastActiveAt = member.lastActiveAt?.getTime() ?? 0;
  const lastSeenAt = Math.max(lastActiveAt, status?.updatedAt.getTime() ?? 0);

  return {
    id: member._id.toHexString(),
    name: member.name,
    avatarUrl: avatarUrl(member),
    isSelf,
    isCreator: !!creatorId && member._id.equals(creatorId),
    active: now.getTime() - lastActiveAt < ACTIVE_WINDOW_MS,
    lastSeenAt: lastSeenAt ? new Date(lastSeenAt) : null,
    battery: isSelf || prefs.shareBattery ? (status?.battery ?? null) : null,
    charging: isSelf || prefs.shareBattery ? (status?.charging ?? null) : null,
    soundMode: isSelf || prefs.shareSound ? (status?.soundMode ?? null) : null,
    screenOn: isSelf || prefs.shareScreen ? (status?.screenOn ?? null) : null,
    location,
    statusUpdatedAt: status?.updatedAt ?? null,
  };
}

export function serializeGroup(
  group: GroupDoc | null,
  viewerId: ObjectId,
  now: Date,
) {
  if (!group) {
    // Not in a group yet: generating an invite code will create one.
    return null;
  }
  const isCreator = group.creatorId.equals(viewerId);
  const inviteActive = !!group.invite && group.invite.expiresAt > now;
  return {
    id: group.slug,
    memberCount: group.memberIds.length,
    maxMembers: config.groupMaxMembers,
    isCreator,
    // Only the creator ever sees the code.
    invite:
      isCreator && inviteActive
        ? { code: group.invite!.code, expiresAt: group.invite!.expiresAt }
        : null,
  };
}
