import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { loadGroupView } from '@/lib/groups';
import { parseBody } from '@/lib/http';
import { profileSchema } from '@/lib/schemas';
import { serializeSelf } from '@/lib/serialize';

/** Called on app open: confirms the token and returns everything to render. */
export const GET = authed(async (_request, { user }) => {
  return NextResponse.json({
    user: serializeSelf(user, new Date()),
    ...(await loadGroupView(user)),
  });
});

export const PATCH = authed(async (request, { user }) => {
  const { name } = await parseBody(request, profileSchema);
  const { users } = await getDb();
  const now = new Date();
  await users.updateOne({ _id: user._id }, { $set: { name, updatedAt: now } });
  return NextResponse.json({ user: serializeSelf({ ...user, name }, now) });
});
