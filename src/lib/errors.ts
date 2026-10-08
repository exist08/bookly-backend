import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import multer from 'multer';

/**
 * Every error leaves the API as
 *   { "error": { "code": "email_taken", "message": "…", "field": "email" } }
 * which is the same shape the app's mock ApiError uses, so screens can map
 * `field` errors straight onto the right input.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field?: string,
  ) {
    super(message);
  }

  static badRequest(code: string, message: string, field?: string) {
    return new ApiError(400, code, message, field);
  }
  static unauthorized(message = 'Your session has expired. Please sign in again.', code = 'unauthorized') {
    return new ApiError(401, code, message);
  }
  static forbidden(message = 'You can’t do that.', code = 'forbidden') {
    return new ApiError(403, code, message);
  }
  static notFound(message = 'Not found.', code = 'not_found') {
    return new ApiError(404, code, message);
  }
  static conflict(code: string, message: string, field?: string) {
    return new ApiError(409, code, message, field);
  }
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(ApiError.notFound('No such endpoint.'));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, field: err.field } });
    return;
  }
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    res.status(400).json({
      error: { code: 'invalid_input', message: first?.message ?? 'Invalid input.', field: first?.path.join('.') || undefined },
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is too large. Use one under 8 MB.'
        : err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Send the photo in the "${err.field}" field.`
          : 'Couldn’t read that upload.';
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: { code: 'invalid_upload', message, field: err.field } });
    return;
  }
  // Unique index race (two sign-ups with the same email at the same moment).
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0];
    const message = field === 'username' ? 'That username is taken.' : 'An account with this email already exists.';
    res.status(409).json({ error: { code: `${field ?? 'value'}_taken`, message, field } });
    return;
  }
  if (err instanceof mongoose.Error.ValidationError) {
    const first = Object.values(err.errors)[0];
    res.status(400).json({ error: { code: 'invalid_input', message: first?.message ?? 'Invalid input.', field: first?.path } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON.' } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong on our side.' } });
};
