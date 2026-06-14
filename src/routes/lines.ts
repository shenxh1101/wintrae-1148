import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, notFound, fail } from '../utils/response';
import { optionalUser } from '../middleware/auth';
import { haversineDistance, formatDistance } from '../utils/geo';

const router = Router();

router.get('/cities', (_req: Request, res: Response) => {
  const db = getDb();
  const cities = db.prepare('SELECT id, code, name, province FROM cities ORDER BY name').all();
  success(res, cities);
});

router.post('/batch', (req: Request, res: Response) => {
  const db = getDb();
  const { ids } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return fail(res, '线路ID数组为必填');
  }

  if (ids.length > 50) {
    return fail(res, '批量查询最多支持50条线路');
  }

  const placeholders = ids.map(() => '?').join(',');
  const lines = db.prepare(`
    SELECT 
      l.id, l.line_no, l.name, l.type, l.direction, l.status,
      l.start_station, l.end_station, l.first_bus, l.last_bus,
      l.ticket_price, l.interval_minutes, l.color,
      c.code as city_code, c.name as city_name
    FROM lines l
    JOIN cities c ON l.city_id = c.id
    WHERE l.id IN (${placeholders})
    ORDER BY l.line_no
  `).all(...ids) as Array<Record<string, unknown>>;

  const lineIds = lines.map((l) => l.id);
  const stationCounts: Record<number, number> = {};

  if (lineIds.length > 0) {
    const countPlaceholders = lineIds.map(() => '?').join(',');
    const counts = db.prepare(`
      SELECT line_id, direction, COUNT(*) as cnt
      FROM line_stations
      WHERE line_id IN (${countPlaceholders})
      GROUP BY line_id, direction
    `).all(...lineIds) as Array<{ line_id: number; direction: number; cnt: number }>;

    for (const row of counts) {
      stationCounts[row.line_id] = row.cnt;
    }
  }

  const result = lines.map((line) => {
    const lineId = Number(line.id);
    const stationsCount = stationCounts[lineId] || 0;
    return {
      ...line,
      stations_count: stationsCount,
      is_active: line.status === 'active',
    };
  });

  const notFoundIds = ids.filter((id: unknown) => !lineIds.includes(Number(id)));

  success(res, {
    lines: result,
    requested_count: ids.length,
    returned_count: result.length,
    not_found_ids: notFoundIds,
  });
});

router.get('/search', (req: Request, res: Response) => {
  const db = getDb();
  const { city_code, keyword, type, page = 1, page_size = 20 } = req.query;
  let pageNum = Math.max(1, Number(page));
  const pageSize = Math.max(1, Math.min(100, Number(page_size)));

  const where: string[] = ["l.status = 'active'"];
  const params: unknown[] = [];

  if (city_code) {
    where.push('c.code = ?');
    params.push(city_code);
  }
  if (keyword) {
    where.push('(l.line_no LIKE ? OR l.name LIKE ? OR l.start_station LIKE ? OR l.end_station LIKE ?)');
    const kw = `%${keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (type && type !== 'all') {
    where.push('l.type = ?');
    params.push(type);
  }

  const whereStr = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const countQuery = `
    SELECT COUNT(DISTINCT l.id) as total
    FROM lines l JOIN cities c ON l.city_id = c.id
    ${whereStr}
  `;
  const totalRow = db.prepare(countQuery).get(...params) as { total: number };
  const total = totalRow.total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (pageNum > totalPages) {
    pageNum = totalPages;
  }

  const offset = (pageNum - 1) * pageSize;

  const listQuery = `
    SELECT DISTINCT l.id, l.city_id, l.line_no, l.name, l.type, l.direction,
           l.start_station, l.end_station, l.first_bus, l.last_bus,
           l.ticket_price, l.interval_minutes, l.status, l.color,
           c.code as city_code, c.name as city_name
    FROM lines l JOIN cities c ON l.city_id = c.id
    ${whereStr}
    ORDER BY l.line_no
    LIMIT ? OFFSET ?
  `;
  const listParams = [...params, pageSize, offset];
  const lines = db.prepare(listQuery).all(...listParams);

  success(res, {
    list: lines,
    total,
    page: pageNum,
    page_size: pageSize,
    total_pages: totalPages,
    has_more: pageNum < totalPages,
    has_prev: pageNum > 1,
    page_adjusted: pageNum !== Number(page),
  });
});

router.get('/:id', optionalUser, (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { direction } = req.query;

  const line = db.prepare(`
    SELECT l.*, c.code as city_code, c.name as city_name
    FROM lines l JOIN cities c ON l.city_id = c.id
    WHERE l.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!line) {
    return notFound(res, '线路不存在');
  }

  const effectiveDirection = direction !== undefined ? Number(direction) : Number(line.direction || 0);

  const stations = db.prepare(`
    SELECT s.*, ls.sequence, ls.distance_from_start, ls.travel_seconds,
      CASE WHEN ls.sequence = 1 THEN '起点'
           WHEN ls.sequence = (SELECT MAX(sequence) FROM line_stations WHERE line_id = ? AND direction = ?) THEN '终点'
           ELSE '中途' END as station_type
    FROM line_stations ls
    JOIN stations s ON ls.station_id = s.id
    WHERE ls.line_id = ? AND ls.direction = ?
    ORDER BY ls.sequence
  `).all(id, effectiveDirection, id, effectiveDirection);

  const diversions = db.prepare(`
    SELECT * FROM route_diversions
    WHERE line_id = ? AND status = 'active'
    AND (effective_to IS NULL OR effective_to > datetime('now'))
    ORDER BY created_at DESC
  `).all(id);

  const stationList = stations as Array<{ travel_seconds?: number }>;
  const totalDuration = stationList.reduce(
    (acc, s) => acc + (Number(s.travel_seconds) || 0),
    0,
  );

  success(res, {
    ...line,
    direction: effectiveDirection,
    stations_count: stations.length,
    total_duration_minutes: Math.ceil(totalDuration / 60),
    stations,
    active_diversions: diversions,
  });
});

router.get('/:id/stations', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;
  const { direction } = req.query;

  const line = db.prepare('SELECT direction FROM lines WHERE id = ?').get(id) as { direction?: number } | undefined;
  if (!line) {
    return notFound(res, '线路不存在');
  }

  const effectiveDirection = direction !== undefined ? Number(direction) : Number(line.direction || 0);

  const stations = db.prepare(`
    SELECT s.id, s.name, s.address, s.latitude, s.longitude, s.is_transfer,
           ls.sequence, ls.distance_from_start, ls.travel_seconds,
           CASE WHEN ls.sequence = 1 THEN '起点'
                WHEN ls.sequence = (SELECT MAX(sequence) FROM line_stations WHERE line_id = ? AND direction = ?) THEN '终点'
                ELSE '中途' END as station_type
    FROM line_stations ls
    JOIN stations s ON ls.station_id = s.id
    WHERE ls.line_id = ? AND ls.direction = ?
    ORDER BY ls.sequence
  `).all(id, effectiveDirection, id, effectiveDirection);

  success(res, stations);
});

router.get('/:id/schedule', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!line) {
    return notFound(res, '线路不存在');
  }

  const schedules: Array<{
    direction: number;
    first_bus: string;
    last_bus: string;
    interval: number;
    stations_count: number;
    total_duration_minutes?: number;
    ticket_price: number;
    start_station: string;
    end_station: string;
  }> = [];

  const thisDirection = Number(line.direction || 0);
  const otherDirection = thisDirection === 0 ? 1 : 0;

  for (const dir of [thisDirection, otherDirection]) {
    const stations = db.prepare(`
      SELECT sequence, travel_seconds FROM line_stations
      WHERE line_id = ? AND direction = ? ORDER BY sequence
    `).all(id, dir) as { sequence: number; travel_seconds: number }[];

    if (stations.length === 0) continue;

    const totalSeconds = stations.reduce((acc, s) => acc + (s.travel_seconds || 0), 0);
    const totalMinutes = Math.ceil(totalSeconds / 60);

    const firstStation = db.prepare(`
      SELECT s.name FROM line_stations ls JOIN stations s ON ls.station_id = s.id
      WHERE ls.line_id = ? AND ls.direction = ? ORDER BY ls.sequence LIMIT 1
    `).get(id, dir) as { name: string } | undefined;
    const lastStation = db.prepare(`
      SELECT s.name FROM line_stations ls JOIN stations s ON ls.station_id = s.id
      WHERE ls.line_id = ? AND ls.direction = ? ORDER BY ls.sequence DESC LIMIT 1
    `).get(id, dir) as { name: string } | undefined;

    schedules.push({
      direction: dir,
      first_bus: String(line.first_bus || '06:00'),
      last_bus: String(line.last_bus || '22:00'),
      interval: Number(line.interval_minutes || 10),
      stations_count: stations.length,
      total_duration_minutes: totalMinutes,
      ticket_price: Number(line.ticket_price || 2),
      start_station: firstStation?.name || '',
      end_station: lastStation?.name || '',
    });
  }

  success(res, {
    line_id: id,
    current_direction: thisDirection,
    ticket_price: line.ticket_price,
    schedules,
  });
});

export default router;
