import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

/** Zod validation. Parsed values land in req.body / req.validated.{query,params}. */
export const validate =
  (schemas: { body?: ZodType; query?: ZodType; params?: ZodType }) =>
  (req: Request, _res: Response, next: NextFunction) => {
    req.validated ??= {};
    if (schemas.params) req.validated.params = schemas.params.parse(req.params);
    if (schemas.query) req.validated.query = schemas.query.parse(req.query);
    if (schemas.body) {
      req.body = schemas.body.parse(req.body ?? {});
      req.validated.body = req.body;
    }
    next();
  };
