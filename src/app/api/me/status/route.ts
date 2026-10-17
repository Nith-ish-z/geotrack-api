import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { parseBody } from '@/lib/http';
import { statusSchema } from '@/lib/schemas';

/**
 * Device status upload: battery, charging, sound mode, screen state, location.
 * Sent by each phone about once an hour on its own schedule, every minute
 * while the app is open, and when a push asks for it.
 */
export const POST = authed(async (request, { user }) => {
  const body = await parseBody(request, statusSchema);
  const now = new Date();
  const previous = user.status;

  const status = {
    battery: body.battery ?? previous?.battery ?? null,
    charging: body.charging ?? previous?.charging ?? null,
    soundMode: body.soundMode ?? previous?.soundMode ?? null,
    screenOn: body.screenOn ?? previous?.screenOn ?? null,
    location: body.location
      ? {
          latitude: body.location.latitude,
          longitude: body.location.longitude,
          accuracy: body.location.accuracy ?? null,
          updatedAt: now,
        }
      : (previous?.location ?? null),
    updatedAt: now,
  };

  const { users } = await getDb();
  await users.updateOne({ _id: user._id }, { $set: { status } });
  return NextResponse.json({ ok: true, updatedAt: now });
});
