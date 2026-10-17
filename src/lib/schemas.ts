import { z } from 'zod';
import { AVATAR_MAX_BASE64_LENGTH } from './config';

const phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'must be in +<country><number> form');

export const requestOtpSchema = z.object({ phone });

export const loginSchema = z.object({
  phone,
  otp: z.string().regex(/^\d{4,8}$/, 'must be the numeric code'),
});

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(40),
});

export const avatarSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  base64: z
    .string()
    .min(1)
    .max(AVATAR_MAX_BASE64_LENGTH, 'image is too large')
    .regex(/^[A-Za-z0-9+/]+=*$/, 'must be base64'),
});

export const preferencesSchema = z
  .object({
    shareLocation: z.boolean(),
    locationMode: z.enum([
      'share',
      'pause_30m',
      'pause_1h',
      'pause_2h',
      'pause_5h',
      'pause_12h',
      'pause_1d',
      'pause_7d',
    ]),
    shareBattery: z.boolean(),
    shareScreen: z.boolean(),
    shareSound: z.boolean(),
  })
  .partial();

export const fcmTokenSchema = z.object({
  token: z.string().min(1).max(4096),
});

/**
 * Device status upload. Phones send only the fields that changed since their
 * last upload; omitted fields keep their stored value. With nothing changed
 * they send just `{ alive: true }`, which only records that they reported.
 */
export const statusSchema = z.object({
  alive: z.literal(true).optional(),
  battery: z.number().int().min(0).max(100).optional(),
  charging: z.boolean().optional(),
  soundMode: z.enum(['silent', 'vibrate', 'normal']).optional(),
  screenOn: z.boolean().optional(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      accuracy: z.number().min(0).nullable().optional(),
    })
    .optional(),
});

export const joinSchema = z.object({
  code: z.string().trim().min(1).max(12),
});

export const presenceSchema = z.object({
  active: z.boolean(),
});
