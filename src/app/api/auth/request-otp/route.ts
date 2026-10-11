import { NextResponse } from 'next/server';
import { parseBody, route } from '@/lib/http';
import { otpLength, requestOtp } from '@/lib/otp';
import { requestOtpSchema } from '@/lib/schemas';

/** First login step: asks for a code to be sent to the phone number. */
export const POST = route(async request => {
  const { phone } = await parseBody(request, requestOtpSchema);
  await requestOtp(phone);
  return NextResponse.json({ ok: true, codeLength: otpLength() });
});
