import type { RequestHandler } from 'express';
import type { z } from 'zod';

/** Parses req.body with a zod schema and replaces it with the clean value. ZodErrors go to errorHandler. */
export const validateBody =
  <S extends z.ZodType>(schema: S): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
