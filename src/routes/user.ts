import { Router, Response } from 'express';
import { getDb } from '../db';
import { success, fail, notFound } from '../utils/response';
import { AuthRequest, requireUser } from '../middleware/auth';

const router = Router();

router.get('/favorites', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { type } = req.query;

  let query = `
    SELECT f.*,
      CASE f.type
        WHEN 'line' THEN l.line_no
        WHEN 'station' THEN s.name
        ELSE ''
      END as target_name,
      CASE f.type
        WHEN 'line' THEN l.name
        WHEN 'station' THEN s.address
        ELSE ''
      END as target_desc
    FROM favorites f
    LEFT JOIN lines l ON f.type = 'line' AND CAST(f.target_id AS INTEGER) = l.id
    LEFT JOIN stations s ON f.type = 'station' AND CAST(f.target_id AS INTEGER) = s.id
    WHERE f.user_id = ?
  `;
  const params: unknown[] = [req.userId];

  if (type) {
    query += ' AND f.type = ?';
    params.push(type);
  }

  query += ' ORDER BY f.updated_at DESC';

  const favorites = db.prepare(query).all(...params);

  success(res, favorites);
});

router.post('/favorites', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { type, target_id, extra_data } = req.body;

  if (!type || !target_id) {
    return fail(res, '收藏类型和目标ID为必填');
  }

  const validTypes = ['line', 'station'];
  if (!validTypes.includes(type)) {
    return fail(res, '无效的收藏类型');
  }

  const existing = db.prepare(
    'SELECT id FROM favorites WHERE user_id = ? AND type = ? AND target_id = ?',
  ).get(req.userId, type, String(target_id));

  if (existing) {
    db.prepare('UPDATE favorites SET updated_at = datetime(\'now\') WHERE id = ?').run((existing as { id: number }).id);
    return success(res, { id: (existing as { id: number }).id, message: '已收藏' });
  }

  const result = db.prepare(`
    INSERT INTO favorites (user_id, type, target_id, extra_data)
    VALUES (?, ?, ?, ?)
  `).run(req.userId, type, String(target_id), extra_data ? JSON.stringify(extra_data) : null);

  success(res, { id: result.lastInsertRowid }, '收藏成功', 201);
});

router.delete('/favorites/:type/:target_id', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { type, target_id } = req.params;

  const result = db.prepare(
    'DELETE FROM favorites WHERE user_id = ? AND type = ? AND target_id = ?',
  ).run(req.userId, type, target_id);

  if (result.changes === 0) {
    return notFound(res, '收藏不存在');
  }

  success(res, { message: '取消收藏成功' });
});

router.get('/favorites/lines', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();

  const lines = db.prepare(`
    SELECT l.*, c.code as city_code, c.name as city_name,
           f.created_at as favorited_at, f.extra_data
    FROM favorites f
    JOIN lines l ON CAST(f.target_id AS INTEGER) = l.id
    JOIN cities c ON l.city_id = c.id
    WHERE f.user_id = ? AND f.type = 'line'
    ORDER BY f.updated_at DESC
  `).all(req.userId);

  success(res, lines);
});

router.get('/favorites/stations', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();

  const stations = db.prepare(`
    SELECT s.*, c.code as city_code, c.name as city_name,
           f.created_at as favorited_at, f.extra_data
    FROM favorites f
    JOIN stations s ON CAST(f.target_id AS INTEGER) = s.id
    JOIN cities c ON s.city_id = c.id
    WHERE f.user_id = ? AND f.type = 'station'
    ORDER BY f.updated_at DESC
  `).all(req.userId);

  success(res, stations);
});

router.get('/reminders', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();

  const reminders = db.prepare(`
    SELECT r.*,
      l.line_no, l.name as line_name, l.color,
      s.name as station_name, s.address
    FROM arrival_reminders r
    JOIN lines l ON r.line_id = l.id
    JOIN stations s ON r.station_id = s.id
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(req.userId);

  success(res, reminders);
});

router.post('/reminders', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const {
    line_id, station_id, direction = 0,
    minutes_before = 5, is_enabled = 1,
    weekdays = '1,2,3,4,5', start_time = '07:00', end_time = '21:00',
  } = req.body;

  if (!line_id || !station_id) {
    return fail(res, '线路ID和站点ID为必填');
  }

  const result = db.prepare(`
    INSERT INTO arrival_reminders
      (user_id, line_id, station_id, direction, minutes_before, is_enabled, weekdays, start_time, end_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.userId, line_id, station_id, direction,
    minutes_before, is_enabled ? 1 : 0, weekdays, start_time, end_time,
  );

  success(res, { id: result.lastInsertRowid }, '提醒创建成功', 201);
});

router.put('/reminders/:id', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const reminder = db.prepare('SELECT * FROM arrival_reminders WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!reminder) {
    return notFound(res, '提醒不存在');
  }

  const allowedFields = ['minutes_before', 'is_enabled', 'weekdays', 'start_time', 'end_time', 'direction'];
  const updates: string[] = [];
  const params: unknown[] = [];

  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      if (field === 'is_enabled') {
        params.push(req.body[field] ? 1 : 0);
      } else {
        params.push(req.body[field]);
      }
    }
  }

  if (updates.length === 0) {
    return fail(res, '没有需要更新的字段');
  }

  updates.push("updated_at = datetime('now')");
  params.push(id, req.userId);

  db.prepare(`UPDATE arrival_reminders SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);

  success(res, { message: '更新成功' });
});

router.delete('/reminders/:id', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const result = db.prepare('DELETE FROM arrival_reminders WHERE id = ? AND user_id = ?').run(id, req.userId);

  if (result.changes === 0) {
    return notFound(res, '提醒不存在');
  }

  success(res, { message: '删除成功' });
});

router.post('/feedback', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { type, title, content, line_id, station_id, images } = req.body;

  if (!type || !title || !content) {
    return fail(res, '反馈类型、标题和内容为必填');
  }

  const validTypes = ['delay', 'crowd', 'route_error', 'station_error', 'vehicle_issue', 'other'];
  if (!validTypes.includes(type)) {
    return fail(res, '无效的反馈类型');
  }

  const result = db.prepare(`
    INSERT INTO feedbacks (user_id, type, title, content, line_id, station_id, images)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.userId, type, title, content,
    line_id || null, station_id || null,
    images ? JSON.stringify(images) : null,
  );

  success(res, {
    id: result.lastInsertRowid,
    status: 'pending',
  }, '反馈提交成功', 201);
});

router.get('/feedback', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { status, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let countQuery = 'SELECT COUNT(*) as total FROM feedbacks WHERE user_id = ?';
  let query = `
    SELECT f.*,
      l.line_no, l.name as line_name,
      s.name as station_name
    FROM feedbacks f
    LEFT JOIN lines l ON f.line_id = l.id
    LEFT JOIN stations s ON f.station_id = s.id
    WHERE f.user_id = ?
  `;
  const params: unknown[] = [req.userId];
  const countParams: unknown[] = [req.userId];

  if (status) {
    query += ' AND f.status = ?';
    params.push(status);
    countQuery += ' AND status = ?';
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

router.get('/feedback/:id', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const feedback = db.prepare(`
    SELECT f.*,
      l.line_no, l.name as line_name,
      s.name as station_name
    FROM feedbacks f
    LEFT JOIN lines l ON f.line_id = l.id
    LEFT JOIN stations s ON f.station_id = s.id
    WHERE f.id = ? AND f.user_id = ?
  `).get(id, req.userId);

  if (!feedback) {
    return notFound(res, '反馈不存在');
  }

  success(res, feedback);
});

router.get('/profile', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();

  const user = db.prepare('SELECT id, user_token, nickname, avatar_url, created_at, last_login FROM users WHERE id = ?').get(req.userId);

  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM favorites WHERE user_id = ?) as favorites_count,
      (SELECT COUNT(*) FROM arrival_reminders WHERE user_id = ?) as reminders_count,
      (SELECT COUNT(*) FROM feedbacks WHERE user_id = ?) as feedbacks_count,
      (SELECT COUNT(*) FROM crowd_reports WHERE user_id = ?) as reports_count
  `).get(req.userId, req.userId, req.userId, req.userId);

  success(res, {
    ...(user as object),
    ...(stats as object),
  });
});

export default router;
