import { Request, Response, NextFunction } from 'express';
import { getDb } from '../db';
import { AuthRequest } from './auth';

export function apiLogger(req: AuthRequest, res: Response, next: NextFunction): void {
  const startTime = Date.now();
  const db = getDb();
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0] || req.ip || '';
  const cityCode = (req.query.city_code as string) || (req.body?.city_code as string) || '';

  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    try {
      const insert = db.prepare(`
        INSERT INTO api_calls (endpoint, method, status_code, response_time_ms, client_ip, user_token, city_code)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        req.path,
        req.method,
        res.statusCode,
        responseTime,
        clientIp,
        req.userToken || '',
        cityCode,
      );
    } catch (_e) {
      // Ignore logging errors
    }
  });

  next();
}
