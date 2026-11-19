import type { NextFunction, Request, Response } from 'express';

const API_KEY_HEADER = 'x-api-key';

export function createApiKeyMiddleware(apiKeys: string[]) {
  const validKeys = new Set(apiKeys.map((key) => key.trim()).filter(Boolean));

  return (req: Request, res: Response, next: NextFunction) => {
    if (validKeys.size === 0) {
      next();
      return;
    }

    const apiKey = req.header(API_KEY_HEADER)?.trim();

    if (!apiKey) {
      next();
      return;
    }

    if (validKeys.has(apiKey)) {
      res.locals.apiKeyAuthenticated = true;
      next();
      return;
    }

    res.status(401).json({ error: 'Invalid API key' });
  };
}
