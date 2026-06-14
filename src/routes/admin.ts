import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, fail, notFound, unauthorized } from '../utils/response';
import { AuthRequest, requireAdmin } from '../middleware/auth';

const router = Router();

router.use(requireAdmin);

router.get('/dashboard', (_req: Request, res: Response) => {
  const db = getDb();

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM cities) as cities_count,
      (SELECT COUNT(*) FROM lines) as lines_count,
      (SELECT COUNT(*) FROM stations) as stations_count,
      (SELECT COUNT(*) FROM vehicles) as vehicles_count,
      (SELECT COUNT(*) FROM users) as users_count,
      (SELECT COUNT(*) FROM favorites) as favorites_count,
      (SELECT COUNT(*) FROM feedbacks WHERE status = 'pending') as pending_feedback,
      (SELECT COUNT(*) FROM announcements WHERE is_published = 1) as active_announcements,
      (SELECT COUNT(*) FROM route_diversions WHERE status = 'active') as active_diversions,
      (SELECT COUNT(*) FROM crowd_reports WHERE reported_at >= date('now', '-1 day')) as crowd_reports_today
  `).get();

  const recentCalls = db.prepare(`
    SELECT endpoint, method, status_code, response_time_ms, client_ip, created_at
    FROM api_calls
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const topEndpoints = db.prepare(`
    SELECT endpoint, COUNT(*) as call_count, AVG(response_time_ms) as avg_response_time
    FROM api_calls
    WHERE created_at >= date('now', '-7 day')
    GROUP BY endpoint
    ORDER BY call_count DESC
    LIMIT 10
  `).all();

  success(res, {
    stats,
    recent_calls: recentCalls,
    top_endpoints: topEndpoints,
  });
});

router.post('/announcements', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { city_id, line_id, type = 'notice', title, content, effective_from, effective_to, is_published = 1 } = req.body;

  if (!title || !content) {
    return fail(res, '标题和内容为必填');
  }

  const validTypes = ['notice', 'warning', 'diversion', 'emergency'];
  if (!validTypes.includes(type)) {
    return fail(res, '无效的公告类型');
  }

  const result = db.prepare(`
    INSERT INTO announcements (city_id, line_id, type, title, content, effective_from, effective_to, is_published, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    city_id || null, line_id || null, type, title, content,
    effective_from || null, effective_to || null,
    is_published ? 1 : 0,
    'admin',
  );

  success(res, { id: result.lastInsertRowid }, '公告创建成功', 201);
});

router.put('/announcements/:id', (_req: Request, res: Response) => {
  const db = getDb();
  const { id } = _req.params;
  const { title, content, type, effective_from, effective_to, is_published } = _req.body;

  const existing = db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!existing) {
    return notFound(res, '公告不存在');
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (content !== undefined) { updates.push('content = ?'); params.push(content); }
  if (type !== undefined) { updates.push('type = ?'); params.push(type); }
  if (effective_from !== undefined) { updates.push('effective_from = ?'); params.push(effective_from || null); }
  if (effective_to !== undefined) { updates.push('effective_to = ?'); params.push(effective_to || null); }
  if (is_published !== undefined) { updates.push('is_published = ?'); params.push(is_published ? 1 : 0); }

  if (updates.length === 0) {
    return fail(res, '没有需要更新的字段');
  }

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE announcements SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  success(res, { message: '更新成功' });
});

router.delete('/announcements/:id', (_req: Request, res: Response) => {
  const db = getDb();
  const { id } = _req.params;

  const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  if (result.changes === 0) {
    return notFound(res, '公告不存在');
  }

  success(res, { message: '删除成功' });
});

router.post('/diversions', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { line_id, title, description, original_stations, diverted_stations, effective_from, effective_to, status = 'active' } = req.body;

  if (!line_id || !title || !effective_from) {
    return fail(res, '线路ID、标题和生效时间为必填');
  }

  const result = db.prepare(`
    INSERT INTO route_diversions (line_id, title, description, original_stations, diverted_stations, effective_from, effective_to, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    line_id, title, description || null,
    original_stations ? JSON.stringify(original_stations) : null,
    diverted_stations ? JSON.stringify(diverted_stations) : null,
    effective_from, effective_to || null, status,
  );

  success(res, { id: result.lastInsertRowid }, '改线公告创建成功', 201);
});

router.put('/diversions/:id', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { title, description, original_stations, diverted_stations, effective_from, effective_to, status } = req.body;

  const existing = db.prepare('SELECT * FROM route_diversions WHERE id = ?').get(id);
  if (!existing) {
    return notFound(res, '改线记录不存在');
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (description !== undefined) { updates.push('description = ?'); params.push(description); }
  if (original_stations !== undefined) { updates.push('original_stations = ?'); params.push(JSON.stringify(original_stations)); }
  if (diverted_stations !== undefined) { updates.push('diverted_stations = ?'); params.push(JSON.stringify(diverted_stations)); }
  if (effective_from !== undefined) { updates.push('effective_from = ?'); params.push(effective_from); }
  if (effective_to !== undefined) { updates.push('effective_to = ?'); params.push(effective_to || null); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }

  if (updates.length === 0) {
    return fail(res, '没有需要更新的字段');
  }

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE route_diversions SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  success(res, { message: '更新成功' });
});

router.get('/feedbacks', (_req: Request, res: Response) => {
  const db = getDb();
  const { status, page = 1, page_size = 20 } = _req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let countQuery = 'SELECT COUNT(*) as total FROM feedbacks';
  let query = `
    SELECT f.*, u.nickname as user_nickname, u.user_token,
      l.line_no, l.name as line_name, s.name as station_name
    FROM feedbacks f
    LEFT JOIN users u ON f.user_id = u.id
    LEFT JOIN lines l ON f.line_id = l.id
    LEFT JOIN stations s ON f.station_id = s.id
  `;
  const params: unknown[] = [];
  const countParams: unknown[] = [];

  if (status) {
    query += ' WHERE f.status = ?';
    params.push(status);
    countQuery += ' WHERE status = ?';
    countParams.push(status);
  }

  const totalRow = db.prepare(countQuery).get(...countParams) as { total: number };

  query += ' ORDER BY f.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(page_size), offset);

  const feedbacks = db.prepare(query).all(...params);

  success(res, {
    list: feedbacks,
    total: totalRow.total,
    page: Number(page),
    page_size: Number(page_size),
  });
});

router.put('/feedbacks/:id/reply', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { reply, status = 'replied' } = req.body;

  if (!reply) {
    return fail(res, '回复内容为必填');
  }

  const existing = db.prepare('SELECT * FROM feedbacks WHERE id = ?').get(id);
  if (!existing) {
    return notFound(res, '反馈不存在');
  }

  db.prepare(`
    UPDATE feedbacks
    SET reply = ?, status = ?, replied_by = ?, replied_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(reply, status, 'admin', id);

  success(res, { message: '回复成功' });
});

router.put('/feedbacks/:id/status', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { status } = req.body;

  const validStatuses = ['pending', 'processing', 'replied', 'resolved', 'closed'];
  if (!validStatuses.includes(status)) {
    return fail(res, '无效的状态值');
  }

  const result = db.prepare(`
    UPDATE feedbacks SET status = ?, updated_at = datetime('now') WHERE id = ?
  `).run(status, id);

  if (result.changes === 0) {
    return notFound(res, '反馈不存在');
  }

  success(res, { message: '状态更新成功' });
});

router.get('/api-calls', (_req: Request, res: Response) => {
  const db = getDb();
  const { endpoint, method, status_code, start_date, end_date, page = 1, page_size = 50 } = _req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let where: string[] = [];
  let params: unknown[] = [];

  if (endpoint) { where.push('endpoint LIKE ?'); params.push(`%${endpoint}%`); }
  if (method) { where.push('method = ?'); params.push(method); }
  if (status_code) { where.push('status_code = ?'); params.push(Number(status_code)); }
  if (start_date) { where.push('created_at >= ?'); params.push(start_date); }
  if (end_date) { where.push('created_at <= ?'); params.push(end_date); }

  const whereStr = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const countQuery = `SELECT COUNT(*) as total FROM api_calls${whereStr}`;
  const totalRow = db.prepare(countQuery).get(...params) as { total: number };

  const query = `SELECT * FROM api_calls${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(page_size), offset);

  const calls = db.prepare(query).all(...params);

  success(res, {
    list: calls,
    total: totalRow.total,
    page: Number(page),
    page_size: Number(page_size),
  });
});

router.get('/api-stats', (_req: Request, res: Response) => {
  const db = getDb();
  const { days = 7 } = _req.query;

  const byDay = db.prepare(`
    SELECT
      date(created_at) as day,
      COUNT(*) as total_calls,
      AVG(response_time_ms) as avg_response_time,
      SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
    FROM api_calls
    WHERE created_at >= date('now', ?)
    GROUP BY date(created_at)
    ORDER BY day DESC
  `).all(`-${days} days`);

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_calls,
      AVG(response_time_ms) as avg_response_time,
      MAX(response_time_ms) as max_response_time,
      SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as client_errors,
      SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as server_errors
    FROM api_calls
    WHERE created_at >= date('now', ?)
  `).get(`-${days} days`);

  success(res, {
    period_days: Number(days),
    summary,
    by_day: byDay,
  });
});

router.post('/vehicle/update', (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { vehicle_id, current_station_seq, next_station_seq, latitude, longitude, status, current_passengers } = req.body;

  if (!vehicle_id) {
    return fail(res, '车辆ID为必填');
  }

  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(vehicle_id);
  if (!existing) {
    return notFound(res, '车辆不存在');
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (current_station_seq !== undefined) { updates.push('current_station_seq = ?'); params.push(current_station_seq); }
  if (next_station_seq !== undefined) { updates.push('next_station_seq = ?'); params.push(next_station_seq); }
  if (latitude !== undefined) { updates.push('latitude = ?'); params.push(latitude); }
  if (longitude !== undefined) { updates.push('longitude = ?'); params.push(longitude); }
  if (status !== undefined) { updates.push('status = ?'); params.push(status); }
  if (current_passengers !== undefined) { updates.push('current_passengers = ?'); params.push(current_passengers); }

  if (updates.length === 0) {
    return fail(res, '没有需要更新的字段');
  }

  updates.push("last_updated = datetime('now')");
  params.push(vehicle_id);

  db.prepare(`UPDATE vehicles SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  success(res, { message: '车辆位置更新成功' });
});

router.get('/data-status', (_req: Request, res: Response) => {
  const db = getDb();

  const tables = ['cities', 'lines', 'stations', 'line_stations', 'vehicles', 'announcements'];
  const result: Record<string, { count: number; last_updated?: string }> = {};

  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
    result[table] = { count: row.count };

    try {
      const ts = db.prepare(`SELECT MAX(updated_at) as last_update FROM ${table}`).get() as { last_update?: string };
      if (ts.last_update) {
        result[table].last_updated = ts.last_update;
      }
    } catch (_e) {
      // ignore
    }
  }

  success(res, {
    tables: result,
    last_data_sync: new Date().toISOString(),
  });
});

export default router;
