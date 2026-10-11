import { randomBytes, randomInt } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { config } from './config';
import { getDb, GroupDoc, UserDoc } from './db';
import { ApiError } from './http';
import { serializeGroup, serializeMember } from './serialize';

// No 0/O, 1/I/L: the code is read aloud or typed from another screen.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;

function randomCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A code that no group is currently using for a live invite. */
async function unusedCode(now: Date): Promise<string> {
  const { groups } = await getDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    const clash = await groups.findOne({
      'invite.code': code,
      'invite.expiresAt': { $gt: now },
    });
    if (!clash) {
      return code;
    }
  }
  throw new ApiError(503, 'TRY_AGAIN', 'Could not generate a code, try again');
}

async function findGroupOf(user: UserDoc): Promise<GroupDoc | null> {
  if (!user.groupId) {
    return null;
  }
  const { groups } = await getDb();
  return groups.findOne({ _id: user.groupId });
}

/**
 * Issues a fresh invite code. A user with no group becomes the creator of a
 * new one; in an existing group only its creator may invite.
 */
export async function createInvite(user: UserDoc) {
  const { users, groups } = await getDb();
  const now = new Date();
  const invite = {
    code: await unusedCode(now),
    expiresAt: new Date(now.getTime() + config.inviteTtlMs),
  };

  let group = await findGroupOf(user);
  if (group) {
    if (!group.creatorId.equals(user._id)) {
      throw new ApiError(
        403,
        'NOT_GROUP_CREATOR',
        'Only the member who started this group can invite others',
      );
    }
    if (group.memberIds.length >= config.groupMaxMembers) {
      throw new ApiError(409, 'GROUP_FULL', 'This group is already full');
    }
    await groups.updateOne({ _id: group._id }, { $set: { invite } });
    return invite;
  }

  group = {
    _id: new ObjectId(),
    slug: randomBytes(9).toString('base64url'),
    creatorId: user._id,
    memberIds: [user._id],
    invite,
    lastLivePushAt: null,
    createdAt: now,
  };
  await groups.insertOne(group);
  // Claims the user only if they still have no group, so a double tap or a
  // join that landed in between can't leave them in two groups.
  const claimed = await users.updateOne(
    { _id: user._id, groupId: null },
    { $set: { groupId: group._id, updatedAt: now } },
  );
  if (claimed.modifiedCount === 0) {
    await groups.deleteOne({ _id: group._id });
    throw new ApiError(409, 'TRY_AGAIN', 'Group changed, try again');
  }
  return invite;
}

/** Adds the user to the group that owns a live invite code. */
export async function joinGroup(user: UserDoc, rawCode: string) {
  const { users, groups } = await getDb();
  const now = new Date();
  const code = normalizeCode(rawCode);

  // Someone who generated a code but got no takers is alone in their own
  // group; they may still join another one, and the empty group is removed.
  const current = await findGroupOf(user);
  const soloGroup =
    current &&
    current.creatorId.equals(user._id) &&
    current.memberIds.length === 1
      ? current
      : null;
  if (current && !soloGroup) {
    throw new ApiError(
      409,
      'ALREADY_IN_GROUP',
      'You are already a member of a group',
    );
  }

  const liveInvite = {
    'invite.code': code,
    'invite.expiresAt': { $gt: now },
    ...(soloGroup ? { _id: { $ne: soloGroup._id } } : {}),
  };
  // The size check is part of the update filter, so two people racing for the
  // last seat can't both get in.
  const joined = await groups.findOneAndUpdate(
    {
      ...liveInvite,
      $expr: { $lt: [{ $size: '$memberIds' }, config.groupMaxMembers] },
    },
    { $addToSet: { memberIds: user._id } },
    { returnDocument: 'after' },
  );
  if (!joined) {
    if (await groups.findOne(liveInvite)) {
      throw new ApiError(409, 'GROUP_FULL', 'This group is already full');
    }
    throw new ApiError(
      404,
      'INVALID_CODE',
      'That code is wrong or has expired',
    );
  }

  await users.updateOne(
    { _id: user._id },
    { $set: { groupId: joined._id, updatedAt: now } },
  );
  if (soloGroup) {
    await groups.deleteOne({ _id: soloGroup._id, memberIds: [user._id] });
  }
  return joined;
}

/** Removes another member from the group. Only its creator may do this. */
export async function removeMember(user: UserDoc, memberId: ObjectId) {
  const { users, groups } = await getDb();
  const group = await findGroupOf(user);
  if (!group) {
    throw new ApiError(409, 'NOT_IN_GROUP', 'You are not in a group');
  }
  if (!group.creatorId.equals(user._id)) {
    throw new ApiError(
      403,
      'NOT_GROUP_CREATOR',
      'Only the member who started this group can remove others',
    );
  }
  if (memberId.equals(user._id)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'Use leave to exit the group');
  }
  if (!group.memberIds.some(id => id.equals(memberId))) {
    throw new ApiError(404, 'NOT_FOUND', 'That person is not in your group');
  }

  await groups.updateOne(
    { _id: group._id },
    { $pull: { memberIds: memberId } },
  );
  await users.updateOne(
    { _id: memberId, groupId: group._id },
    { $set: { groupId: null, updatedAt: new Date() } },
  );
}

/**
 * Takes the user out of their group. When the creator leaves, the group ends
 * for everyone: there is nobody left who could invite or remove members.
 */
export async function leaveGroup(user: UserDoc) {
  const { users, groups } = await getDb();
  const group = await findGroupOf(user);
  if (!group) {
    throw new ApiError(409, 'NOT_IN_GROUP', 'You are not in a group');
  }
  const now = new Date();

  if (group.creatorId.equals(user._id)) {
    await users.updateMany(
      { groupId: group._id },
      { $set: { groupId: null, updatedAt: now } },
    );
    await groups.deleteOne({ _id: group._id });
    return;
  }

  await groups.updateOne(
    { _id: group._id },
    { $pull: { memberIds: user._id } },
  );
  await users.updateOne(
    { _id: user._id },
    { $set: { groupId: null, updatedAt: now } },
  );
}

/** The viewer's group and its members, with the viewer listed first. */
export async function loadGroupView(viewer: UserDoc) {
  const { users } = await getDb();
  const now = new Date();
  const group = await findGroupOf(viewer);

  const members = group
    ? await users.find({ _id: { $in: group.memberIds } }).toArray()
    : [viewer];
  members.sort((a, b) => {
    const aSelf = a._id.equals(viewer._id);
    const bSelf = b._id.equals(viewer._id);
    if (aSelf !== bSelf) {
      return aSelf ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    group: serializeGroup(group, viewer._id, now),
    // Anyone not in someone else's group may generate a code.
    canInvite: !group || group.creatorId.equals(viewer._id),
    members: members.map(member =>
      serializeMember(member, viewer._id, group?.creatorId ?? null, now),
    ),
  };
}
