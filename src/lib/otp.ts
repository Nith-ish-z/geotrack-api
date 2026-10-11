import { timingSafeEqual } from 'node:crypto';
import { config } from './config';

/**
 * Login codes. There is no SMS provider yet, so every phone number shares one
 * fixed code (STATIC_OTP, default 1101) and nothing is actually sent.
 *
 * This means the code proves nothing about who owns a number. When a provider
 * is chosen, only this file changes: `requestOtp` generates, stores and sends
 * a per-number code, and `verifyOtp` checks the stored one. The routes and the
 * app already call both in the right order.
 */

/** Length of the code, so the app can size its input. */
export const otpLength = () => config.staticOtp.length;

/** Called when the user asks for a code. Nothing to send for now. */
export async function requestOtp(phone: string): Promise<void> {
  void phone;
}

/** Whether `code` is the right login code for `phone`. */
export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  void phone;
  const expected = Buffer.from(config.staticOtp);
  const actual = Buffer.from(code);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
