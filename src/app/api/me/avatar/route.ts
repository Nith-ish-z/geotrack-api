import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBody } from '@/lib/http';
import { avatarSchema } from '@/lib/schemas';
import { serializeSelf } from '@/lib/serialize';

export const PUT = authed(async (request, { user }) => {
  const { contentType, base64 } = await parseBody(request, avatarSchema);
  const { users } = await getDb();
  const now = new Date();
  // The version goes into the avatar URL so clients refetch after a change.
  const avatar = { contentType, base64, version: now.getTime() };
  await users.updateOne(
    { _id: user._id },
    { $set: { avatar, updatedAt: now } },
  );
  return NextResponse.json({ user: serializeSelf({ ...user, avatar }, now) });
});

export const DELETE = authed(async (_request, { user }) => {
  const { users } = await getDb();
  const now = new Date();
  await users.updateOne(
    { _id: user._id },
    { $set: { avatar: null, updatedAt: now } },
  );
  return NextResponse.json({
    user: serializeSelf({ ...user, avatar: null }, now),
  });
});
