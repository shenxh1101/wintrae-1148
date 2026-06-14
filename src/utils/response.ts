import { Response } from 'express';

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data?: T;
  timestamp: string;
  requestId?: string;
}

export function success<T>(res: Response, data?: T, message: string = 'success', code: number = 200): Response<ApiResponse<T>> {
  return res.status(code).json({
    code,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
}

export function fail(res: Response, message: string, code: number = 400, errors?: unknown): Response<ApiResponse> {
  return res.status(code).json({
    code,
    message,
    errors,
    timestamp: new Date().toISOString(),
  });
}

export function notFound(res: Response, message: string = 'Resource not found'): Response<ApiResponse> {
  return fail(res, message, 404);
}

export function unauthorized(res: Response, message: string = 'Unauthorized'): Response<ApiResponse> {
  return fail(res, message, 401);
}

export function forbidden(res: Response, message: string = 'Forbidden'): Response<ApiResponse> {
  return fail(res, message, 403);
}
