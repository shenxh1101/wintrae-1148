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

router.get('/dashboard', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { city_code } = req.query;

  const favLines = db.prepare(`
    SELECT l.id, l.line_no, l.name, l.type, l.direction, l.color,
           l.start_station, l.end_station, l.first_bus, l.last_bus,
           l.ticket_price, l.interval_minutes, l.status,
           c.code as city_code, c.name as city_name,
           f.created_at as favorited_at
    FROM favorites f
    JOIN lines l ON CAST(f.target_id AS INTEGER) = l.id
    JOIN cities c ON l.city_id = c.id
    WHERE f.user_id = ? AND f.type = 'line'
    ORDER BY f.updated_at DESC
    LIMIT 20
  `).all(req.userId) as Array<Record<string, unknown>>;

  const favLineIds = favLines.map(l => l.id);

  const lineStationsMap: Record<string, { station_id: number; station_name: string; sequence: number }[]> = {};
  if (favLineIds.length > 0) {
    const placeholders = favLineIds.map(() => '?').join(',');
    const ls = db.prepare(`
      SELECT ls.line_id, ls.station_id, s.name as station_name, ls.sequence
      FROM line_stations ls
      JOIN stations s ON ls.station_id = s.id
      WHERE ls.line_id IN (${placeholders})
      ORDER BY ls.line_id, ls.sequence
    `).all(...favLineIds) as Array<Record<string, unknown>>;
    for (const row of ls) {
      const key = String(row.line_id);
      if (!lineStationsMap[key]) lineStationsMap[key] = [];
      lineStationsMap[key].push({
        station_id: Number(row.station_id),
        station_name: String(row.station_name),
        sequence: Number(row.sequence),
      });
    }
  }

  const lineArrivalMap: Record<string, Array<Record<string, unknown>>> = {};
  if (favLineIds.length > 0) {
    const placeholders = favLineIds.map(() => '?').join(',');
    const arrivals = db.prepare(`
      SELECT
        v.id as vehicle_id, v.plate_no, v.current_passengers, v.capacity,
        v.line_id, v.direction, v.current_station_seq, v.next_station_seq,
        s_curr.name as current_station_name,
        s_next.name as next_station_name,
        l.interval_minutes, l.line_no,
        CASE
          WHEN v.capacity = 0 THEN 'unknown'
          WHEN v.current_passengers / v.capacity < 0.3 THEN 'empty'
          WHEN v.current_passengers / v.capacity < 0.6 THEN 'comfortable'
          WHEN v.current_passengers / v.capacity < 0.85 THEN 'crowded'
          ELSE 'full'
        END as crowd_level,
        ROUND(CASE WHEN v.capacity > 0 THEN v.current_passengers * 100.0 / v.capacity ELSE 0 END, 1) as crowd_percentage,
        v.latitude, v.longitude
      FROM vehicles v
      JOIN lines l ON v.line_id = l.id
      LEFT JOIN line_stations ls_curr ON ls_curr.line_id = v.line_id AND ls_curr.direction = v.direction AND ls_curr.sequence = v.current_station_seq
      LEFT JOIN stations s_curr ON s_curr.id = ls_curr.station_id
      LEFT JOIN line_stations ls_next ON ls_next.line_id = v.line_id AND ls_next.direction = v.direction AND ls_next.sequence = v.next_station_seq
      LEFT JOIN stations s_next ON s_next.id = ls_next.station_id
      WHERE v.line_id IN (${placeholders}) AND v.status = 'running'
      ORDER BY v.line_id, v.current_station_seq DESC
    `).all(...favLineIds) as Array<Record<string, unknown>>;
    for (const arr of arrivals) {
      const key = String(arr.line_id);
      if (!lineArrivalMap[key]) lineArrivalMap[key] = [];
      lineArrivalMap[key].push(arr);
    }
  }

  const linesWithStatus = favLines.map(line => {
    const lineId = String(line.id);
    const stations = lineStationsMap[lineId] || [];
    const vehicles = lineArrivalMap[lineId] || [];
    const stationsCount = stations.length;

    let nextArrival: Record<string, unknown> | null = null;
    if (vehicles.length > 0 && stations.length >= 2) {
      const v = vehicles[0];
      const dir = Number(v.direction);
      const seq = Number(v.current_station_seq);
      const nextSeq = Number(v.next_station_seq);
      const nextStation = stations.find(s => s.sequence === nextSeq);
      const etaMin = Math.max(1, Number(line.interval_minutes));
      nextArrival = {
        vehicle_id: v.vehicle_id,
        plate_no: v.plate_no,
        current_station_name: v.current_station_name,
        current_station_seq: seq,
        next_station_name: nextStation?.station_name || v.next_station_name,
        next_station_seq: nextSeq,
        direction: dir,
        eta_minutes: etaMin,
        eta_text: etaMin <= 1 ? '即将到站' : `${etaMin}分钟后`,
        crowd_level: v.crowd_level,
        crowd_percentage: v.crowd_percentage,
        latitude: v.latitude,
        longitude: v.longitude,
      };
    }

    const isActive = line.status === 'active';
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;
    let operationStatus = 'operating';
    if (line.first_bus && line.last_bus) {
      if (currentTime < String(line.first_bus)) operationStatus = 'not_started';
      else if (currentTime > String(line.last_bus)) operationStatus = 'ended';
    }
    if (!isActive) operationStatus = 'suspended';

    return {
      ...line,
      stations_count: stationsCount,
      operation_status: operationStatus,
      is_active: isActive,
      next_arrival: nextArrival,
      first_station: stations[0]?.station_name || line.start_station,
      last_station: stations[stations.length - 1]?.station_name || line.end_station,
    };
  });

  const favStations = db.prepare(`
    SELECT s.id, s.name, s.address, s.latitude, s.longitude, s.is_transfer,
           c.code as city_code, c.name as city_name,
           f.created_at as favorited_at
    FROM favorites f
    JOIN stations s ON CAST(f.target_id AS INTEGER) = s.id
    JOIN cities c ON s.city_id = c.id
    WHERE f.user_id = ? AND f.type = 'station'
    ORDER BY f.updated_at DESC
    LIMIT 10
  `).all(req.userId) as Array<Record<string, unknown>>;

  const favStationIds = favStations.map(s => s.id);

  const stationReminders: Record<string, Array<Record<string, unknown>>> = {};
  if (favStationIds.length > 0) {
    const placeholders = favStationIds.map(() => '?').join(',');
    const reminders = db.prepare(`
      SELECT r.*, l.line_no, l.name as line_name, l.color
      FROM arrival_reminders r
      JOIN lines l ON r.line_id = l.id
      WHERE r.user_id = ? AND r.station_id IN (${placeholders}) AND r.is_enabled = 1
      ORDER BY r.start_time
    `).all(req.userId, ...favStationIds) as Array<Record<string, unknown>>;
    for (const r of reminders) {
      const key = String(r.station_id);
      if (!stationReminders[key]) stationReminders[key] = [];
      stationReminders[key].push(r);
    }
  }

  const stationsWithReminders = favStations.map(s => ({
    ...s,
    reminders: stationReminders[String(s.id)] || [],
  }));

  let annQuery = `
    SELECT a.*, c.code as city_code, c.name as city_name,
           l.line_no, l.name as line_name, l.color as line_color
    FROM announcements a
    LEFT JOIN cities c ON a.city_id = c.id
    LEFT JOIN lines l ON a.line_id = l.id
    WHERE a.is_published = 1
      AND (a.effective_from IS NULL OR a.effective_from <= datetime('now'))
      AND (a.effective_to IS NULL OR a.effective_to >= datetime('now'))
  `;
  const annParams: unknown[] = [];

  if (city_code) {
    annQuery += ' AND (c.code = ? OR a.city_id IS NULL)';
    annParams.push(city_code);
  }

  if (favLineIds.length > 0) {
    const placeholders = favLineIds.map(() => '?').join(',');
    annQuery += ` AND (a.line_id IN (${placeholders}) OR a.line_id IS NULL)`;
    annParams.push(...favLineIds);
  } else {
    annQuery += ' AND a.line_id IS NULL';
  }

  annQuery += ' ORDER BY a.created_at DESC LIMIT 5';
  const announcements = db.prepare(annQuery).all(...annParams);

  success(res, {
    refreshed_at: new Date().toISOString(),
    favorite_lines: linesWithStatus,
    favorite_stations: stationsWithReminders,
    announcements,
    summary: {
      favorite_lines_count: linesWithStatus.length,
      favorite_stations_count: stationsWithReminders.length,
      operating_lines_count: linesWithStatus.filter(l => l.operation_status === 'operating').length,
      announcements_count: announcements.length,
      reminders_count: Object.values(stationReminders).reduce((s, arr) => s + arr.length, 0),
    },
  });
});

export default router;
