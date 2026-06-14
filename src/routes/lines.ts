import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, notFound } from '../utils/response';
import { optionalUser } from '../middleware/auth';
import { haversineDistance, formatDistance } from '../utils/geo';

const router = Router();

router.get('/cities', (_req: Request, res: Response) => {
  const db = getDb();
  const cities = db.prepare('SELECT id, code, name, province FROM cities ORDER BY name').all();
  success(res, cities);
});

router.get('/search', (req: Request, res: Response) => {
  const db = getDb();
  const { city_code, keyword, type, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let query = `
    SELECT DISTINCT l.*, c.code as city_code, c.name as city_name
    FROM lines l
    JOIN cities c ON l.city_id = c.id
    WHERE l.status = 'active'
  `;
  const params: unknown[] = [];

  if (city_code) {
    query += ' AND c.code = ?';
    params.push(city_code);
  }
  if (keyword) {
    query += ' AND (l.line_no LIKE ? OR l.name LIKE ? OR l.start_station LIKE ? OR l.end_station LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (type && type !== 'all') {
    query += ' AND l.type = ?';
    params.push(type);
  }

  const countQuery = query.replace('SELECT DISTINCT l.*, c.code as city_code, c.name as city_name', 'SELECT COUNT(DISTINCT l.id) as total');
  const totalRow = db.prepare(countQuery).get(...params) as { total: number };

  query += ' ORDER BY l.line_no LIMIT ? OFFSET ?';
  params.push(Number(page_size), offset);

  const lines = db.prepare(query).all(...params);

  success(res, {
    list: lines,
    total: totalRow.total,
    page: Number(page),
    page_size: Number(page_size),
  });
});

router.get('/:id', optionalUser, (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { direction = 0 } = req.query;

  const line = db.prepare(`
    SELECT l.*, c.code as city_code, c.name as city_name
    FROM lines l JOIN cities c ON l.city_id = c.id
    WHERE l.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!line) {
    return notFound(res, '线路不存在');
  }

  const stations = db.prepare(`
    SELECT s.*, ls.sequence, ls.distance_from_start, ls.travel_seconds
    FROM line_stations ls
    JOIN stations s ON ls.station_id = s.id
    WHERE ls.line_id = ? AND ls.direction = ?
    ORDER BY ls.sequence
  `).all(id, direction);

  const diversions = db.prepare(`
    SELECT * FROM route_diversions
    WHERE line_id = ? AND status = 'active'
    AND (effective_to IS NULL OR effective_to > datetime('now'))
    ORDER BY created_at DESC
  `).all(id);

  success(res, {
    ...line,
    stations,
    active_diversions: diversions,
  });
});

router.get('/:id/stations', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { direction = 0 } = req.query;

  const stations = db.prepare(`
    SELECT s.id, s.name, s.address, s.latitude, s.longitude, s.is_transfer,
           ls.sequence, ls.distance_from_start, ls.travel_seconds,
           CASE WHEN ls.distance_from_start = 0 THEN '起点'
                WHEN ls.sequence = (SELECT MAX(sequence) FROM line_stations WHERE line_id = ? AND direction = ?) THEN '终点'
                ELSE '中途' END as station_type
    FROM line_stations ls
    JOIN stations s ON ls.station_id = s.id
    WHERE ls.line_id = ? AND ls.direction = ?
    ORDER BY ls.sequence
  `).all(id, direction, id, direction);

  success(res, stations);
});

router.get('/:id/schedule', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!line) {
    return notFound(res, '线路不存在');
  }

  const stationCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM line_stations WHERE line_id = ? AND direction = 0',
  ).get(id) as { cnt: number };

  const schedules: { direction: number; first_bus: string; last_bus: string; interval: number; stations_count: number }[] = [];

  for (let dir = 0; dir <= 1; dir++) {
    const stations = db.prepare(`
      SELECT sequence, travel_seconds FROM line_stations
      WHERE line_id = ? AND direction = ? ORDER BY sequence
    `).all(id, dir) as { sequence: number; travel_seconds: number }[];

    const totalSeconds = stations.reduce((acc, s) => acc + (s.travel_seconds || 0), 0);
    const totalMinutes = Math.ceil(totalSeconds / 60);

    const dirInfo = dir === 0 ? line : (db.prepare('SELECT * FROM lines WHERE id = ?').get(id) as Record<string, unknown>);
    schedules.push({
      direction: dir,
      first_bus: String(dirInfo.first_bus || '06:00'),
      last_bus: String(dirInfo.last_bus || '22:00'),
      interval: Number(line.interval_minutes || 10),
      stations_count: stationCount.cnt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(totalMinutes ? { total_duration_minutes: totalMinutes } as any : {}),
    });
  }

  success(res, {
    line_id: id,
    ticket_price: line.ticket_price,
    schedules,
  });
});

export default router;
