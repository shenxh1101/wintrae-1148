export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  db: {
    path: process.env.DB_PATH || './data/bus_service.db',
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    max: 100,
  },
  admin: {
    token: process.env.ADMIN_TOKEN || 'admin-secret-token-2024',
  },
  geo: {
    defaultRadius: 1000,
    maxRadius: 5000,
  },
};
