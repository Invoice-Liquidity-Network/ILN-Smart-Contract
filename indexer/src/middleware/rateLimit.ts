import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

type RequestWithRateLimit = Request & {
  rateLimit?: {
    resetTime?: Date;
  };
};

export function createRateLimitMiddleware(limit: number, windowMs: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (_req, res) => res.locals.apiKeyAuthenticated === true,
    handler: (req: RequestWithRateLimit, res: Response) => {
      const resetTimeMs = req.rateLimit?.resetTime?.getTime();
      const retryAfterSeconds =
        resetTimeMs === undefined
          ? Math.ceil(windowMs / 1000)
          : Math.max(1, Math.ceil((resetTimeMs - Date.now()) / 1000));

      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: 'Too many requests, please try again later.',
      });
    },
  });
}
