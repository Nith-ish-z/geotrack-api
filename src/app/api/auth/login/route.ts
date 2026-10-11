import { NextResponse } from 'next/server';
import { startSession } from '@/lib/auth';
import { defaultPreferences, getDb } from '@/lib/db';
import { loadGroupView } from '@/lib/groups';
import { ApiError, parseBody, route } from '@/lib/http';
import { verifyOtp } from '@/lib/otp';
import { loginSchema } from '@/lib/schemas';
import { serializeSelf } from '@/lib/serialize';

/**
 * Second login step: exchanges a phone number and its code for an app token.
 * First login creates the user with an empty name, which the app then asks for.
 */
export const POST = route(async request => {
  const { phone, otp } = await parseBody(request, loginSchema);
  if (!(await verifyOtp(phone, otp))) {
    throw new ApiError(401, 'INVALID_OTP', 'That code is not correct');
  }

  const { users } = await getDb();
  const now = new Date();
  const user = await users.findOneAndUpdate(
    { phone },
    {
      $set: { updatedAt: now },
      $setOnInsert: {
        phone,
        name: '',
        avatar: null,
        groupId: null,
        session: null,
        fcmToken: null,
        preferences: defaultPreferences,
        status: null,
        lastActiveAt: null,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  if (!user) {
    throw new Error('Login upsert returned no user');
  }

  const session = await startSession(user._id);
  return NextResponse.json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: serializeSelf(user, now),
    ...(await loadGroupView(user)),
  });
});
