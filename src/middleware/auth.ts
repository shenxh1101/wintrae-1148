import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { unauthorized, forbidden } from '../utils/response';
import { getDb } from '../db';

export interface AuthRequest extends Request {
  userId?: number;
  userToken?: string;
  isAdmin?: boolean;
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers['x-admin-token'] as string;
  if (!token) {
    unauthorized(res, '管理员令牌缺失');
    return;
  }
  if (token !== config.admin.token) {
    forbidden(res, '管理员令牌无效');
    return;
  }
  req.isAdmin = true;
  next();
}

export function requireUser(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers['x-user-token'] as string;
  if (!token) {
    unauthorized(res, '用户令牌缺失');
    return;
  }
  const db = getDb();
  const user = db.prepare('SELECT id, user_token FROM users WHERE user_token = ?').get(token) as { id: number; user_token: string } | undefined;
  if (!user) {
    const result = db.prepare('INSERT INTO users (user_token, nickname) VALUES (?, ?)').run(token, `用户${token.slice(-4)}`);
    req.userId = result.lastInsertRowid as number;
  } else {
    req.userId = user.id;
  }
  req.userToken = token;
  next();
}

export function optionalUser(req: AuthRequest, _res: Response, next: NextFunction): void {
  const token = req.headers['x-user-token'] as string;
  if (token) {
    const db = getDb();
    const user = db.prepare('SELECT id, user_token FROM users WHERE user_token = ?').get(token) as { id: number; user_token: string } | undefined;
    if (user) {
      req.userId = user.id;
      req.userToken = token;
    }
  }
  next();
}
