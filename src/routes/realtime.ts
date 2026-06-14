import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, notFound, fail } from '../utils/response';
import { AuthRequest, requireUser } from '../middleware/auth';

const router = Router();

router.get('/vehicles/:lineId', (req: Request, res: Response) => {
  const db = getDb();
  const { lineId } = req.params;
  const { direction } = req.query;

  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(lineId);
  if (!line) {
    return notFound(res, '线路不存在');
  }

  let query = `
    SELECT v.*, 
      s1.name as current_station_name,
      s2.name as next_station_name,
      CASE
        WHEN v.capacity = 0 THEN 'unknown'
        WHEN v.current_passengers / v.capacity < 0.3 THEN 'empty'
        WHEN v.current_passengers / v.capacity < 0.6 THEN 'comfortable'
        WHEN v.current_passengers / v.capacity < 0.85 THEN 'crowded'
        ELSE 'full'
      END as crowd_level,
      ROUND(CASE WHEN v.capacity > 0 THEN v.current_passengers * 100.0 / v.capacity ELSE 0 END, 1) as crowd_percentage
    FROM vehicles v
    LEFT JOIN line_stations ls1 ON ls1.line_id = v.line_id AND ls1.direction = v.direction AND ls1.sequence = v.current_station_seq
    LEFT JOIN stations s1 ON s1.id = ls1.station_id
    LEFT JOIN line_stations ls2 ON ls2.line_id = v.line_id AND ls2.direction = v.direction AND ls2.sequence = v.next_station_seq
    LEFT JOIN stations s2 ON s2.id = ls2.station_id
    WHERE v.line_id = ?
  `;
  const params: unknown[] = [lineId];

  if (direction !== undefined) {
    query += ' AND v.direction = ?';
    params.push(Number(direction));
  }

  const vehicles = db.prepare(query).all(...params);

  success(res, {
    line_id: Number(lineId),
    vehicles,
    refreshed_at: new Date().toISOString(),
  });
});

router.get('/arrivals/station/:stationId', (req: Request, res: Response) => {
  const db = getDb();
  const { stationId } = req.params;
  const { line_id } = req.query;

  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stationId);
  if (!station) {
    return notFound(res, '站点不存在');
  }

  let query = `
    SELECT 
      v.id as vehicle_id,
      v.plate_no,
      l.id as line_id,
      l.line_no,
      l.name,
      l.color,
      l.start_station,
      l.end_station,
      v.direction,
      v.current_station_seq,
      v.next_station_seq,
      s_curr.name as current_station_name,
      s_next.name as next_station_name,
      ls.sequence as target_sequence,
      (ls.sequence - v.current_station_seq) as stations_remaining,
      CASE
        WHEN ls.sequence = v.next_station_seq THEN 1
        ELSE (ls.sequence - v.current_station_seq) * l.interval_minutes
      END as eta_minutes,
      CASE
        WHEN v.capacity = 0 THEN 'unknown'
        WHEN v.current_passengers / v.capacity < 0.3 THEN 'empty'
        WHEN v.current_passengers / v.capacity < 0.6 THEN 'comfortable'
        WHEN v.current_passengers / v.capacity < 0.85 THEN 'crowded'
        ELSE 'full'
      END as crowd_level,
      v.latitude,
      v.longitude,
      v.status
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    JOIN vehicles v ON v.line_id = l.id AND v.direction = ls.direction
    LEFT JOIN line_stations ls_curr ON ls_curr.line_id = v.line_id AND ls_curr.direction = v.direction AND ls_curr.sequence = v.current_station_seq
    LEFT JOIN stations s_curr ON s_curr.id = ls_curr.station_id
    LEFT JOIN line_stations ls_next ON ls_next.line_id = v.line_id AND ls_next.direction = v.direction AND ls_next.sequence = v.next_station_seq
    LEFT JOIN stations s_next ON s_next.id = ls_next.station_id
    WHERE ls.station_id = ? AND v.status = 'running'
      AND ls.sequence > v.current_station_seq
  `;
  const params: unknown[] = [stationId];

  if (line_id) {
    query += ' AND l.id = ?';
    params.push(line_id);
  }

  query += ' ORDER BY eta_minutes ASC';

  const rawArrivals = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
  const arrivals = rawArrivals.map((item) => {
    const etaMinutes = Number(item.eta_minutes);
    const stationsRemaining = Number(item.stations_remaining);
    let etaText = '';
    let status = '';
    if (stationsRemaining === 1) {
      etaText = '即将到站';
      status = '到站中';
    } else if (etaMinutes <= 1) {
      etaText = '1分钟内';
      status = '即将到站';
    } else if (etaMinutes <= 3) {
      etaText = `${Math.ceil(etaMinutes)}分钟后`;
      status = '临近到站';
    } else {
      etaText = `${Math.ceil(etaMinutes)}分钟后`;
      status = '行驶中';
    }
    return { ...item, eta_text: etaText, arrival_status: status };
  });

  const stationInfo = station as Record<string, unknown>;
  success(res, {
    station_id: Number(stationId),
    station_name: String(stationInfo.name),
    arrivals,
    refreshed_at: new Date().toISOString(),
  });
});

router.get('/arrivals/line/:lineId', (req: Request, res: Response) => {
  const db = getDb();
  const { lineId } = req.params;
  const { station_id, direction } = req.query;

  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(lineId) as Record<string, unknown> | undefined;
  if (!line) {
    return notFound(res, '线路不存在');
  }

  if (!station_id) {
    return fail(res, '站点ID参数缺失');
  }

  const effectiveDirection = direction !== undefined ? Number(direction) : Number(line.direction || 0);

  const vehicles = db.prepare(`
    SELECT 
      v.id, v.plate_no, v.current_station_seq, v.next_station_seq,
      v.current_passengers, v.capacity, v.latitude, v.longitude,
      ls.sequence as target_sequence,
      s_curr.name as current_station_name,
      s_next.name as next_station_name,
      (ls.sequence - v.current_station_seq) as stations_remaining,
      CASE
        WHEN ls.sequence = v.next_station_seq THEN 1
        ELSE (ls.sequence - v.current_station_seq) * l.interval_minutes
      END as eta_minutes
    FROM vehicles v
    JOIN line_stations ls ON ls.line_id = v.line_id AND ls.direction = v.direction AND ls.station_id = ?
    JOIN lines l ON l.id = v.line_id
    LEFT JOIN line_stations ls_curr ON ls_curr.line_id = v.line_id AND ls_curr.direction = v.direction AND ls_curr.sequence = v.current_station_seq
    LEFT JOIN stations s_curr ON s_curr.id = ls_curr.station_id
    LEFT JOIN line_stations ls_next ON ls_next.line_id = v.line_id AND ls_next.direction = v.direction AND ls_next.sequence = v.next_station_seq
    LEFT JOIN stations s_next ON s_next.id = ls_next.station_id
    WHERE v.line_id = ? AND v.direction = ? AND v.status = 'running'
      AND ls.sequence > v.current_station_seq
    ORDER BY eta_minutes ASC
    LIMIT 3
  `).all(station_id, lineId, effectiveDirection) as Array<Record<string, unknown>>;

  const result = vehicles.map((v) => {
    const etaMinutes = Number(v.eta_minutes);
    const stationsRemaining = Number(v.stations_remaining);
    const crowdPct = v.capacity ? Math.round((Number(v.current_passengers) / Number(v.capacity)) * 100) : 0;
    let crowdLevel = 'unknown';
    if (crowdPct < 30) crowdLevel = 'empty';
    else if (crowdPct < 60) crowdLevel = 'comfortable';
    else if (crowdPct < 85) crowdLevel = 'crowded';
    else crowdLevel = 'full';

    let etaText = '';
    let arrivalStatus = '';
    if (stationsRemaining === 1) {
      etaText = '即将到站';
      arrivalStatus = '到站中';
    } else if (etaMinutes <= 1) {
      etaText = '1分钟内';
      arrivalStatus = '即将到站';
    } else if (etaMinutes <= 3) {
      etaText = `${Math.ceil(etaMinutes)}分钟后`;
      arrivalStatus = '临近到站';
    } else {
      etaText = `${Math.ceil(etaMinutes)}分钟后`;
      arrivalStatus = '行驶中';
    }

    return {
      vehicle_id: v.id,
      plate_no: v.plate_no,
      current_station_name: v.current_station_name,
      next_station_name: v.next_station_name,
      stations_remaining: stationsRemaining,
      eta_minutes: etaMinutes,
      eta_text: etaText,
      arrival_status: arrivalStatus,
      crowd_level: crowdLevel,
      crowd_percentage: crowdPct,
      latitude: v.latitude,
      longitude: v.longitude,
    };
  });

  success(res, {
    line_id: Number(lineId),
    station_id: Number(station_id),
    direction: effectiveDirection,
    upcoming_vehicles: result,
    interval_minutes: Number(line.interval_minutes || 10),
    refreshed_at: new Date().toISOString(),
  });
});

router.post('/crowd/report', requireUser, (req: AuthRequest, res: Response) => {
  const db = getDb();
  const { line_id, station_id, vehicle_id, level, passenger_count } = req.body;

  if (!line_id || !level) {
    return fail(res, '线路ID和拥挤等级为必填');
  }

  const validLevels = ['empty', 'comfortable', 'crowded', 'full'];
  if (!validLevels.includes(level)) {
    return fail(res, '无效的拥挤等级');
  }

  const result = db.prepare(`
    INSERT INTO crowd_reports (user_id, line_id, station_id, vehicle_id, level, passenger_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.userId, line_id, station_id || null, vehicle_id || null, level, passenger_count || null);

  success(res, {
    id: result.lastInsertRowid,
    message: '上报成功',
  }, '上报成功', 201);
});

router.get('/punctuality/:lineId', (req: Request, res: Response) => {
  const db = getDb();
  const { lineId } = req.params;
  const { days = 30 } = req.query;

  const line = db.prepare('SELECT * FROM lines WHERE id = ?').get(lineId);
  if (!line) {
    return notFound(res, '线路不存在');
  }

  const overall = db.prepare(`
    SELECT 
      COUNT(*) as total_trips,
      SUM(CASE WHEN delay_seconds <= 60 THEN 1 ELSE 0 END) as on_time_count,
      AVG(delay_seconds) as avg_delay_seconds,
      MAX(delay_seconds) as max_delay_seconds
    FROM punctuality_records
    WHERE line_id = ? AND recorded_date >= date('now', ?)
  `).get(lineId, `-${days} days`) as {
    total_trips: number;
    on_time_count: number;
    avg_delay_seconds: number | null;
    max_delay_seconds: number | null;
  };

  const byStation = db.prepare(`
    SELECT 
      s.id as station_id,
      s.name as station_name,
      COUNT(*) as total,
      SUM(CASE WHEN p.delay_seconds <= 60 THEN 1 ELSE 0 END) as on_time,
      AVG(p.delay_seconds) as avg_delay
    FROM punctuality_records p
    JOIN stations s ON s.id = p.station_id
    WHERE p.line_id = ? AND p.recorded_date >= date('now', ?)
    GROUP BY p.station_id
    ORDER BY p.station_id
  `).all(lineId, `-${days} days`) as Array<Record<string, unknown>>;

  const byDate = db.prepare(`
    SELECT 
      recorded_date,
      COUNT(*) as total,
      SUM(CASE WHEN delay_seconds <= 60 THEN 1 ELSE 0 END) as on_time,
      AVG(delay_seconds) as avg_delay
    FROM punctuality_records
    WHERE line_id = ? AND recorded_date >= date('now', ?)
    GROUP BY recorded_date
    ORDER BY recorded_date DESC
    LIMIT 30
  `).all(lineId, `-${days} days`);

  const onTimeRate = overall.total_trips > 0
    ? Math.round((overall.on_time_count / overall.total_trips) * 10000) / 100
    : 0;

  success(res, {
    line_id: Number(lineId),
    period_days: Number(days),
    overall: {
      total_trips: overall.total_trips,
      on_time_count: overall.on_time_count,
      on_time_rate: onTimeRate,
      on_time_rate_text: `${onTimeRate}%`,
      avg_delay_seconds: Math.round(overall.avg_delay_seconds || 0),
      max_delay_seconds: overall.max_delay_seconds || 0,
    },
    by_station: byStation.map((s) => ({
      station_id: s.station_id,
      station_name: s.station_name,
      total: s.total,
      on_time: s.on_time,
      on_time_rate: s.total ? Math.round((Number(s.on_time) / Number(s.total)) * 10000) / 100 : 0,
      avg_delay_seconds: Math.round(Number(s.avg_delay || 0)),
    })),
    by_date: byDate,
  });
});

export default router;
