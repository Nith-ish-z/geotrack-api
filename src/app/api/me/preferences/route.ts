import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBody } from '@/lib/http';
import { preferencesSchema } from '@/lib/schemas';
import { pauseUntilFor, serializeSelf } from '@/lib/serialize';

/** Updates any subset of the sharing preferences. */
export const PUT = authed(async (request, { user }) => {
  const patch = await parseBody(request, preferencesSchema);
  const now = new Date();

  const preferences = { ...user.preferences, ...patch };
  if (patch.locationMode) {
    // The pause clock starts when the mode is chosen.
    preferences.pauseUntil = pauseUntilFor(patch.locationMode, now);
  }

  const { users } = await getDb();
  await users.updateOne(
    { _id: user._id },
    { $set: { preferences, updatedAt: now } },
  );
  return NextResponse.json({
    user: serializeSelf({ ...user, preferences }, now),
  });
});
