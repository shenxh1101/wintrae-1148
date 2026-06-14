import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { success, fail } from '../utils/response';

const router = Router();

router.get('/plan', (req: Request, res: Response) => {
  const db = getDb();
  const { from_station_id, to_station_id, city_code, max_transfers = 2 } = req.query;

  if (!from_station_id || !to_station_id) {
    return fail(res, '起点站和终点站ID为必填');
  }

  if (from_station_id === to_station_id) {
    return success(res, {
      from_station_id,
      to_station_id,
      plans: [],
      message: '起点和终点相同',
    });
  }

  const maxT = Math.min(Number(max_transfers), 3);

  const fromStation = db.prepare('SELECT * FROM stations WHERE id = ?').get(from_station_id) as Record<string, unknown> | undefined;
  const toStation = db.prepare('SELECT * FROM stations WHERE id = ?').get(to_station_id) as Record<string, unknown> | undefined;

  if (!fromStation || !toStation) {
    return fail(res, '站点不存在');
  }

  const fromLines = db.prepare(`
    SELECT DISTINCT l.id, l.line_no, l.name, l.color, l.type, l.interval_minutes, l.ticket_price, ls.direction, ls.sequence
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    WHERE ls.station_id = ? AND l.status = 'active'
  `).all(from_station_id);

  const toLines = db.prepare(`
    SELECT DISTINCT l.id, l.line_no, l.name, l.color, l.type, l.interval_minutes, l.ticket_price, ls.direction, ls.sequence
    FROM line_stations ls
    JOIN lines l ON ls.line_id = l.id
    WHERE ls.station_id = ? AND l.status = 'active'
  `).all(to_station_id);

  interface PlanSegment {
    segment_index: number;
    line_id: number;
    line_no: string;
    line_name: string;
    line_type: string;
    color: string;
    from_station_id: number;
    from_station_name: string;
    to_station_id: number;
    to_station_name: string;
    direction: number;
    stations_count: number;
    travel_seconds: number;
    travel_minutes: number;
    wait_minutes: number;
    duration_minutes: number;
    ticket_price: number;
    interval_minutes: number;
    start_seq: number;
    end_seq: number;
    transfer_wait_minutes?: number;
  }

  interface PlanSummary {
    total_stations: number;
    total_travel_seconds: number;
    total_travel_minutes: number;
    total_wait_minutes: number;
    total_transfer_wait_minutes: number;
    total_duration_minutes: number;
    total_ticket_price: number;
  }

  interface Plan {
    transfers: number;
    total_stations: number;
    total_travel_seconds: number;
    total_travel_minutes: number;
    total_wait_minutes: number;
    total_transfer_wait_minutes: number;
    total_duration_minutes: number;
    ticket_price: number;
    summary: PlanSummary;
    segments: PlanSegment[];
    walk_distance?: { transfer: number; from_start: number; to_end: number };
  }

  const plans: Plan[] = [];

  type LineInfo = {
    id: number;
    line_no: string;
    name: string;
    color: string;
    type: string;
    interval_minutes: number;
    ticket_price: number;
    direction: number;
    sequence: number;
  };

  function calculateSegmentDuration(
    lineId: number,
    direction: number,
    startSeq: number,
    endSeq: number,
    intervalMinutes: number,
  ): { travel_seconds: number; travel_minutes: number; wait_minutes: number; duration_minutes: number } {
    const segments = db.prepare(`
      SELECT travel_seconds FROM line_stations
      WHERE line_id = ? AND direction = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence
    `).all(lineId, direction, startSeq, endSeq) as Array<{ travel_seconds: number }>;

    const totalTravelSeconds = segments.reduce((acc, s) => acc + (s.travel_seconds || 90), 0);
    const travelMinutes = Math.ceil(totalTravelSeconds / 60);
    const waitMinutes = Math.ceil(intervalMinutes / 2);
    return {
      travel_seconds: totalTravelSeconds,
      travel_minutes: travelMinutes,
      wait_minutes: waitMinutes,
      duration_minutes: travelMinutes + waitMinutes,
    };
  }

  function buildPlan(
    transfers: number,
    segments: PlanSegment[],
  ): Plan {
    const totalStations = segments.reduce((acc, s) => acc + s.stations_count, 0);
    const totalTravelSeconds = segments.reduce((acc, s) => acc + s.travel_seconds, 0);
    const totalTravelMinutes = segments.reduce((acc, s) => acc + s.travel_minutes, 0);
    const totalWaitMinutes = segments.reduce((acc, s) => acc + s.wait_minutes, 0);
    const totalTransferWaitMinutes = segments.reduce((acc, s) => acc + (s.transfer_wait_minutes || 0), 0);
    const totalPrice = segments.reduce((acc, s) => acc + s.ticket_price, 0);
    const totalDuration = totalTravelMinutes + totalWaitMinutes;

    return {
      transfers,
      total_stations: totalStations,
      total_travel_seconds: totalTravelSeconds,
      total_travel_minutes: totalTravelMinutes,
      total_wait_minutes: totalWaitMinutes,
      total_transfer_wait_minutes: totalTransferWaitMinutes,
      total_duration_minutes: totalDuration,
      ticket_price: totalPrice,
      summary: {
        total_stations: totalStations,
        total_travel_seconds: totalTravelSeconds,
        total_travel_minutes: totalTravelMinutes,
        total_wait_minutes: totalWaitMinutes,
        total_transfer_wait_minutes: totalTransferWaitMinutes,
        total_duration_minutes: totalDuration,
        total_ticket_price: totalPrice,
      },
      segments,
    };
  }

  for (const fromLine of fromLines as Array<LineInfo>) {
    for (const toLine of toLines as Array<LineInfo>) {
      if (fromLine.id === toLine.id && fromLine.direction === toLine.direction) {
        if (fromLine.sequence < toLine.sequence) {
          const stationCount = toLine.sequence - fromLine.sequence;
          const segInfo = calculateSegmentDuration(
            fromLine.id, fromLine.direction, fromLine.sequence, toLine.sequence, fromLine.interval_minutes,
          );
          const segment: PlanSegment = {
            segment_index: 0,
            line_id: fromLine.id,
            line_no: fromLine.line_no,
            line_name: fromLine.name,
            line_type: fromLine.type,
            color: fromLine.color,
            from_station_id: Number(from_station_id),
            from_station_name: String(fromStation.name),
            to_station_id: Number(to_station_id),
            to_station_name: String(toStation.name),
            direction: fromLine.direction,
            stations_count: stationCount,
            travel_seconds: segInfo.travel_seconds,
            travel_minutes: segInfo.travel_minutes,
            wait_minutes: segInfo.wait_minutes,
            duration_minutes: segInfo.duration_minutes,
            ticket_price: Number(fromLine.ticket_price),
            interval_minutes: fromLine.interval_minutes,
            start_seq: fromLine.sequence,
            end_seq: toLine.sequence,
          };
          plans.push(buildPlan(0, [segment]));
        }
      } else if (maxT >= 1) {
        const fromLineStations = db.prepare(`
          SELECT s.id, s.name, ls.sequence, ls.travel_seconds
          FROM line_stations ls JOIN stations s ON ls.station_id = s.id
          WHERE ls.line_id = ? AND ls.direction = ? AND ls.sequence >= ?
          ORDER BY ls.sequence
        `).all(fromLine.id, fromLine.direction, fromLine.sequence) as Array<{ id: number; name: string; sequence: number; travel_seconds: number }>;

        const toLineStations = db.prepare(`
          SELECT s.id, s.name, ls.sequence, ls.travel_seconds
          FROM line_stations ls JOIN stations s ON ls.station_id = s.id
          WHERE ls.line_id = ? AND ls.direction = ? AND ls.sequence <= ?
          ORDER BY ls.sequence
        `).all(toLine.id, toLine.direction, toLine.sequence) as Array<{ id: number; name: string; sequence: number; travel_seconds: number }>;

        for (const fs of fromLineStations) {
          for (const ts of toLineStations) {
            if (fs.id === ts.id) {
              const seg1Count = fs.sequence - fromLine.sequence;
              const seg2Count = toLine.sequence - ts.sequence;
              if (seg1Count > 0 && seg2Count > 0) {
                const seg1Info = calculateSegmentDuration(
                  fromLine.id, fromLine.direction, fromLine.sequence, fs.sequence, fromLine.interval_minutes,
                );
                const seg2Info = calculateSegmentDuration(
                  toLine.id, toLine.direction, ts.sequence, toLine.sequence, toLine.interval_minutes,
                );
                const transferWait = Math.max(3, Math.ceil(toLine.interval_minutes / 2));
                const seg2WaitMinutes = seg2Info.wait_minutes + transferWait;
                const seg2DurationMinutes = seg2Info.travel_minutes + seg2WaitMinutes;

                const segments: PlanSegment[] = [
                  {
                    segment_index: 0,
                    line_id: fromLine.id,
                    line_no: fromLine.line_no,
                    line_name: fromLine.name,
                    line_type: fromLine.type,
                    color: fromLine.color,
                    from_station_id: Number(from_station_id),
                    from_station_name: String(fromStation.name),
                    to_station_id: fs.id,
                    to_station_name: fs.name,
                    direction: fromLine.direction,
                    stations_count: seg1Count,
                    travel_seconds: seg1Info.travel_seconds,
                    travel_minutes: seg1Info.travel_minutes,
                    wait_minutes: seg1Info.wait_minutes,
                    duration_minutes: seg1Info.duration_minutes,
                    ticket_price: Number(fromLine.ticket_price),
                    interval_minutes: fromLine.interval_minutes,
                    start_seq: fromLine.sequence,
                    end_seq: fs.sequence,
                  },
                  {
                    segment_index: 1,
                    line_id: toLine.id,
                    line_no: toLine.line_no,
                    line_name: toLine.name,
                    line_type: toLine.type,
                    color: toLine.color,
                    from_station_id: ts.id,
                    from_station_name: ts.name,
                    to_station_id: Number(to_station_id),
                    to_station_name: String(toStation.name),
                    direction: toLine.direction,
                    stations_count: seg2Count,
                    travel_seconds: seg2Info.travel_seconds,
                    travel_minutes: seg2Info.travel_minutes,
                    wait_minutes: seg2WaitMinutes,
                    duration_minutes: seg2DurationMinutes,
                    ticket_price: Number(toLine.ticket_price),
                    interval_minutes: toLine.interval_minutes,
                    start_seq: ts.sequence,
                    end_seq: toLine.sequence,
                    transfer_wait_minutes: transferWait,
                  },
                ];

                plans.push(buildPlan(1, segments));
              }
              break;
            }
          }
        }
      }
    }
  }

  plans.sort((a, b) => {
    if (a.transfers !== b.transfers) return a.transfers - b.transfers;
    return a.total_duration_minutes - b.total_duration_minutes;
  });

  success(res, {
    from_station: { id: Number(from_station_id), name: fromStation.name as string },
    to_station: { id: Number(to_station_id), name: toStation.name as string },
    plans: plans.slice(0, 10),
    total_found: Math.min(plans.length, 10),
  });
});

router.get('/announcements', (req: Request, res: Response) => {
  const db = getDb();
  const { city_code, line_id, type, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  let query = `
    SELECT a.*, c.code as city_code, c.name as city_name, l.line_no, l.name as line_name
    FROM announcements a
    LEFT JOIN cities c ON a.city_id = c.id
    LEFT JOIN lines l ON a.line_id = l.id
    WHERE a.is_published = 1
  `;
  const params: unknown[] = [];
  const countParams: unknown[] = [];

  if (city_code) {
    query += ' AND (c.code = ? OR a.city_id IS NULL)';
    params.push(city_code);
    countParams.push(city_code);
  }
  if (line_id) {
    query += ' AND (a.line_id = ? OR a.line_id IS NULL)';
    params.push(line_id);
    countParams.push(line_id);
  }
  if (type) {
    query += ' AND a.type = ?';
    params.push(type);
    countParams.push(type);
  }

  query += " AND (a.effective_from IS NULL OR a.effective_from <= datetime('now'))";
  query += " AND (a.effective_to IS NULL OR a.effective_to >= datetime('now'))";

  const countQuery = query.replace(
    'SELECT a.*, c.code as city_code, c.name as city_name, l.line_no, l.name as line_name',
    'SELECT COUNT(*) as total',
  );
  const totalRow = db.prepare(countQuery).get(...countParams) as { total: number };

  query += ' ORDER BY a.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(page_size), offset);

  const announcements = db.prepare(query).all(...params);

  success(res, {
    list: announcements,
    total: totalRow.total,
    page: Number(page),
    page_size: Number(page_size),
  });
});

router.get('/diversions', (req: Request, res: Response) => {
  const db = getDb();
  const { line_id, city_code, active_only = '1' } = req.query;

  let query = `
    SELECT rd.*, l.line_no, l.name as line_name, l.color, c.code as city_code, c.name as city_name
    FROM route_diversions rd
    JOIN lines l ON rd.line_id = l.id
    JOIN cities c ON l.city_id = c.id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (active_only === '1') {
    query += " AND rd.status = 'active' AND (rd.effective_to IS NULL OR rd.effective_to >= datetime('now'))";
  }
  if (line_id) {
    query += ' AND rd.line_id = ?';
    params.push(line_id);
  }
  if (city_code) {
    query += ' AND c.code = ?';
    params.push(city_code);
  }

  query += ' ORDER BY rd.created_at DESC';

  const diversions = db.prepare(query).all(...params);

  success(res, diversions);
});

router.get('/announcements/:id', (req: Request, res: Response) => {
  const db = getDb();
  const { id } = req.params;

  const announcement = db.prepare(`
    SELECT a.*, c.code as city_code, c.name as city_name, l.line_no, l.name as line_name
    FROM announcements a
    LEFT JOIN cities c ON a.city_id = c.id
    LEFT JOIN lines l ON a.line_id = l.id
    WHERE a.id = ?
  `).get(id);

  if (!announcement) {
    return fail(res, '公告不存在', 404);
  }

  success(res, announcement);
});

export default router;
