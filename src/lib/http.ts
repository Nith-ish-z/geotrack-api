import { NextRequest, NextResponse } from 'next/server';
import { ZodError, ZodType } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    const issue = error.issues[0];
    const path = issue.path.join('.');
    return NextResponse.json(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: path ? `${path}: ${issue.message}` : issue.message,
        },
      },
      { status: 400 },
    );
  }
  console.error(error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } },
    { status: 500 },
  );
}

export async function parseBody<T>(
  request: NextRequest,
  schema: ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, 'INVALID_REQUEST', 'Request body must be JSON');
  }
  return schema.parse(body);
}

/** Wraps a public route handler with the shared error handling. */
export function route<C>(
  handler: (request: NextRequest, context: C) => Promise<Response>,
) {
  return async (request: NextRequest, context: C): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
