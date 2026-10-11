import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBody } from '@/lib/http';
import { fcmTokenSchema } from '@/lib/schemas';

/** Registers this device's push token for status requests. */
export const PUT = authed(async (request, { user }) => {
  const { token } = await parseBody(request, fcmTokenSchema);
  const { users } = await getDb();
  // A device belongs to whoever logged in on it last.
  await users.updateMany(
    { fcmToken: token, _id: { $ne: user._id } },
    { $set: { fcmToken: null } },
  );
  await users.updateOne({ _id: user._id }, { $set: { fcmToken: token } });
  return NextResponse.json({ ok: true });
});
