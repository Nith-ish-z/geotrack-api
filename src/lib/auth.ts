import { randomUUID } from 'node:crypto';
import { errors, jwtVerify, JWTPayload, SignJWT } from 'jose';
import { ObjectId } from 'mongodb';
import { NextRequest } from 'next/server';
import { config } from './config';
import { getDb, UserDoc } from './db';
import { ApiError, errorResponse } from './http';

/** Response header carrying a replacement token after a renewal. */
export const RENEWED_TOKEN_HEADER = 'x-auth-token';
/** How long the replaced token keeps working after a renewal. */
const PREVIOUS_TOKEN_WINDOW_MS = 60 * 1000;

const secretKey = () => new TextEncoder().encode(config.jwtSecret);

export interface IssuedToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

async function signToken(userId: ObjectId): Promise<IssuedToken> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + config.tokenTtlMs);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId.toHexString())
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretKey());
  return { token, jti, expiresAt };
}

/** Starts a fresh session at login, invalidating any earlier token. */
export async function startSession(userId: ObjectId): Promise<IssuedToken> {
  const issued = await signToken(userId);
  const { users } = await getDb();
  await users.updateOne(
    { _id: userId },
    {
      $set: {
        session: {
          jti: issued.jti,
          expiresAt: issued.expiresAt,
          previousJti: null,
          previousValidUntil: null,
        },
      },
    },
  );
  return issued;
}

const unauthorized = (code: string, message: string) =>
  new ApiError(401, code, message);

export interface AuthContext {
  user: UserDoc;
  /** Set when the presented token had expired and was replaced. */
  renewed: IssuedToken | null;
}

/**
 * Validates the bearer token against its signature and the session stored on
 * the user. An expired token that is still the user's current one is swapped
 * for a new token; anything else is rejected and the app must log in again.
 */
export async function authenticate(request: NextRequest): Promise<AuthContext> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    throw unauthorized('MISSING_TOKEN', 'Authorization token is required');
  }

  let payload: JWTPayload;
  let expired = false;
  try {
    ({ payload } = await jwtVerify(token, secretKey(), {
      algorithms: ['HS256'],
    }));
  } catch (error) {
    // jose checks the signature before the claims, so an expired token's
    // payload is still authentic.
    if (error instanceof errors.JWTExpired) {
      payload = error.payload;
      expired = true;
    } else {
      throw unauthorized('INVALID_TOKEN', 'Authorization token is invalid');
    }
  }

  const { sub, jti, exp } = payload;
  if (!sub || !jti || !exp || !ObjectId.isValid(sub)) {
    throw unauthorized('INVALID_TOKEN', 'Authorization token is invalid');
  }

  const { users } = await getDb();
  const userId = new ObjectId(sub);
  const user = await users.findOne({ _id: userId });
  const session = user?.session;
  if (!user || !session) {
    throw unauthorized('INVALID_TOKEN', 'Session no longer exists');
  }

  const now = Date.now();
  const isCurrent = jti === session.jti;
  const isPrevious =
    jti === session.previousJti &&
    !!session.previousValidUntil &&
    session.previousValidUntil.getTime() > now;
  if (!isCurrent && !isPrevious) {
    throw unauthorized('INVALID_TOKEN', 'Session was replaced or signed out');
  }

  if (!expired || isPrevious) {
    return { user, renewed: null };
  }
  if (exp * 1000 + config.tokenRenewGraceMs < now) {
    throw unauthorized('TOKEN_EXPIRED', 'Session expired, log in again');
  }

  const renewed = await signToken(userId);
  // Filtering on the old jti makes the swap atomic: if a parallel request
  // already renewed, this one keeps working without issuing a second token.
  const result = await users.updateOne(
    { _id: userId, 'session.jti': jti },
    {
      $set: {
        session: {
          jti: renewed.jti,
          expiresAt: renewed.expiresAt,
          previousJti: jti,
          previousValidUntil: new Date(now + PREVIOUS_TOKEN_WINDOW_MS),
        },
      },
    },
  );
  return { user, renewed: result.modifiedCount === 1 ? renewed : null };
}

/** Wraps a route handler that requires a logged-in user. */
export function authed<C>(
  handler: (
    request: NextRequest,
    auth: AuthContext,
    context: C,
  ) => Promise<Response>,
) {
  return async (request: NextRequest, context: C): Promise<Response> => {
    try {
      const auth = await authenticate(request);
      const response = await handler(request, auth, context);
      if (auth.renewed) {
        response.headers.set(RENEWED_TOKEN_HEADER, auth.renewed.token);
        response.headers.set(
          'x-auth-token-expires',
          auth.renewed.expiresAt.toISOString(),
        );
      }
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}
