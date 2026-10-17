import { NextResponse } from 'next/server';
import { authed } from '@/lib/auth';
import { getDb, UserDoc } from '@/lib/db';
import { parseBody } from '@/lib/http';
import { statusSchema } from '@/lib/schemas';

/**
 * Device status upload: battery, charging, sound mode, screen state, location.
 * Phones send only what changed, or `{ alive: true }` when nothing did. Every
 * call records that the phone reported in; only changed fields are stored.
 * During a live session a moving phone may call this every second.
 */
export const POST = authed(async (request, { user }) => {
  const body = await parseBody(request, statusSchema);
  const now = new Date();
  const previous = user.status;

  const changed =
    body.battery !== undefined ||
    body.charging !== undefined ||
    body.soundMode !== undefined ||
    body.screenOn !== undefined ||
    body.location !== undefined;

  const update: Partial<UserDoc> = { lastHeardAt: now };
  if (changed) {
    update.status = {
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
  }

  const { users } = await getDb();
  await users.updateOne({ _id: user._id }, { $set: update });
  return NextResponse.json({ ok: true, changed, receivedAt: now });
});
