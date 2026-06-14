import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, notFound, fail } from '../utils/response';
import { haversineDistance, formatDistance } from '../utils/geo';
import { config } from '../config';

const router = Router();

router.get('/search', (req: Request, res: Response) => {
  const db = getDb();
  const { city_code, keyword, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let query = `
    SELECT DISTINCT s.*, c.code as city_code, c.name as city_name
    FROM stations s
    JOIN cities c ON s.city_id = c.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (city_code) {
    query += ' AND c.code = ?';
    params.push(city_code);
  }
  if (keyword) {
    query += ' AND (s.name LIKE ? OR s.address LIKE ?)';
    const kw = `%${keyword}%`;
    params.push(kw, kw);
  }

  const countQuery = query.replace('SELECT DISTINCT s.*, c.code as city_code, c.name as city_name', 'SELECT COUNT(DISTINCT s.id) as total');
  const totalRow = db.prepare(countQuery).get(...params) as { total: number };

  query += ' ORDER BY s.name LIMIT ? OFFSET ?';
  params.push(Number(page_size), offset);

  const stations = db.prepare(query).all(...params);

  success(res, {
    list: stations,
    total: totalRow.total,
    page: Number(page),
    page_size: Number(page_size),
  });
});

router.get('/nearby', (req: Request, res: Response) => {
  const db = getDb();
  const { latitude, longitude, radius, city_code, limit = 20 } = req.query;

  if (!latitude || !longitude) {
    return fail(res, '经纬度参数缺失');
  }

  const lat = parseFloat(latitude as string);
  const lon = parseFloat(longitude as string);
  const r = Math.min(Number(radius || config.geo.defaultRadius), config.geo.maxRadius);

  const latDelta = r / 111320;
  const lonDelta = r / (111320 * Math.cos((lat * Math.PI) / 180));

  let query = `
    SELECT s.*, c.code as city_code, c.name as city_name
    FROM stations s
    JOIN cities c ON s.city_id = c.id
    WHERE s.latitude BETWEEN ? AND ?
      AND s.longitude BETWEEN ? AND ?
  `;
  const params: unknown[] = [lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta];

  if (city_code) {
    query += ' AND c.code = ?';
    params.push(city_code);
  }

  query += ' LIMIT 200';

  const stations = db.prepare(query).all(...params) as Array<{
    id: number;
    name: string;
    latitude: number;
    longitude: number;
    [key: string]: unknown;
  }>;

  const stationsWithDistance = stations
    .map((s) => ({
      ...s,
      distance: Math.round(haversineDistance(lat, lon, s.latitude, s.longitude)),
    }))
    .filter((s) => s.distance <= r)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Number(limit))
    .map((s) => ({
      ...s,
      distance_formatted: formatDistance(s.distance),
    }));

  success(res, {
    latitude: lat,
    longitude: lon,
    radius: r,
    stations: stationsWithDistance,
  });
});

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const station = db.prepare(`
    SELECT s.*, c.code as city_code, c.name as city_name
    FROM stations s JOIN cities c ON s.city_id = c.id
    WHERE s.id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!station) {
    return notFound(res, '站点不存在');
  }

  const passingLines = db.prepare(`
    SELECT l.id, l.line_no, l.name, l.type, l.start_station, l.end_station,
           l.first_bus, l.last_bus, l.color, ls.direction, ls.sequence
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    WHERE ls.station_id = ? AND l.status = 'active'
    ORDER BY l.line_no
  `).all(id);

  success(res, {
    ...station,
    passing_lines: passingLines,
  });
});

router.get('/:id/lines', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const lines = db.prepare(`
    SELECT l.id, l.line_no, l.name, l.type, l.start_station, l.end_station,
           l.first_bus, l.last_bus, l.color, ls.direction, ls.sequence,
           l.interval_minutes, l.ticket_price
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    WHERE ls.station_id = ? AND l.status = 'active'
    ORDER BY l.line_no
  `).all(id);

  success(res, lines);
});

router.get('/:id/arrivals', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(id);
  if (!station) {
    return notFound(res, '站点不存在');
  }

  const arrivals = db.prepare(`
    SELECT 
      v.id as vehicle_id,
      v.plate_no,
      v.status,
      v.current_passengers,
      v.capacity,
      l.id as line_id,
      l.line_no,
      l.name,
      l.color,
      l.start_station,
      l.end_station,
      v.direction,
      ls.sequence as target_station_seq,
      v.current_station_seq,
      (ls.sequence - v.current_station_seq) as stations_remaining,
      CASE
        WHEN ls.sequence <= v.current_station_seq THEN 0
        ELSE (ls.sequence - v.current_station_seq) * l.interval_minutes * 60
      END as eta_seconds,
      CASE
        WHEN ls.sequence <= v.current_station_seq THEN '即将到站'
        WHEN (ls.sequence - v.current_station_seq) <= 2 THEN '即将到站'
        ELSE CAST(((ls.sequence - v.current_station_seq) * l.interval_minutes) AS TEXT) || '分钟后'
      END as eta_text,
      CASE
        WHEN v.capacity = 0 THEN 'unknown'
        WHEN v.current_passengers / v.capacity < 0.3 THEN 'empty'
        WHEN v.current_passengers / v.capacity < 0.6 THEN 'comfortable'
        WHEN v.current_passengers / v.capacity < 0.85 THEN 'crowded'
        ELSE 'full'
      END as crowd_level
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    JOIN vehicles v ON v.line_id = l.id AND v.direction = ls.direction
    WHERE ls.station_id = ? AND v.status = 'running'
      AND ls.sequence >= v.current_station_seq
    ORDER BY v.direction, eta_seconds ASC
  `).all(id);

  success(res, {
    station_id: id,
    arrivals,
    refreshed_at: new Date().toISOString(),
  });
});

export default router;
