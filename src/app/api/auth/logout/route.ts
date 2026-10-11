import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';

/** Ends the session and stops pushes to this device. */
export const POST = authed(async (_request, { user }) => {
  const { users } = await getDb();
  await users.updateOne(
    { _id: user._id },
    { $set: { session: null, fcmToken: null, lastActiveAt: null } },
  );
  return NextResponse.json({ ok: true });
});
