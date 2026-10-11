import { ObjectId } from 'mongodb';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { ApiError } from '@/lib/http';

/** Serves a member's avatar to themselves and to people in their group. */
export const GET = authed<{ params: Promise<{ id: string }> }>(
  async (_request, { user }, context) => {
    const { id } = await context.params;
    const notFound = new ApiError(404, 'NOT_FOUND', 'No avatar');
    if (!ObjectId.isValid(id)) {
      throw notFound;
    }

    const targetId = new ObjectId(id);
    const { users } = await getDb();
    const target = targetId.equals(user._id)
      ? user
      : await users.findOne({ _id: targetId });
    const sameGroup =
      !!target?.groupId &&
      !!user.groupId &&
      target.groupId.equals(user.groupId);
    if (!target?.avatar || (!targetId.equals(user._id) && !sameGroup)) {
      throw notFound;
    }

    return new Response(Buffer.from(target.avatar.base64, 'base64'), {
      headers: {
        'content-type': target.avatar.contentType,
        // Safe to cache hard: the URL's version changes with the image.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  },
);
