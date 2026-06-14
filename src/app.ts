import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config';
import { logger } from './utils/logger';
import { initTables } from './db';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiLogger } from './middleware/apiLogger';

import linesRouter from './routes/lines';
import stationsRouter from './routes/stations';
import realtimeRouter from './routes/realtime';
import userRouter from './routes/user';
import transferRouter from './routes/transfer';
import adminRouter from './routes/admin';
import { success } from './utils/response';

export function createApp(): express.Application {
  initTables();

  const app = express();

  app.use(helmet());
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(
    morgan('combined', {
      stream: {
        write: (message: string) => logger.info(message.trim()),
      },
    }),
  );

  const limiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    message: { code: 429, message: '请求过于频繁，请稍后再试' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);

  app.use(apiLogger);

  app.get('/', (_req, res) => {
    success(res, {
      name: '公交到站信息后端服务',
      version: '1.0.0',
      status: 'running',
      docs: {
        lines: '/api/lines',
        stations: '/api/stations',
        realtime: '/api/realtime',
        user: '/api/user',
        transfer: '/api/transfer',
        admin: '/api/admin',
      },
    });
  });

  app.get('/health', (_req, res) => {
    success(res, { status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/lines', linesRouter);
  app.use('/api/stations', stationsRouter);
  app.use('/api/realtime', realtimeRouter);
  app.use('/api/user', userRouter);
  app.use('/api/transfer', transferRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
