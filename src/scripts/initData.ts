import { getDb, initTables } from '../db';
import { logger } from '../utils/logger';

const cities = [
  { code: 'beijing', name: '北京市', province: '北京市' },
  { code: 'shanghai', name: '上海市', province: '上海市' },
  { code: 'guangzhou', name: '广州市', province: '广东省' },
  { code: 'shenzhen', name: '深圳市', province: '广东省' },
  { code: 'chengdu', name: '成都市', province: '四川省' },
];

const lineTemplates = [
  { no: '1路', name: '1路公交线路', type: 'normal', start: '火车站', end: '人民广场', first: '05:30', last: '23:00', price: 2, interval: 8, color: '#E53935' },
  { no: '2路', name: '2路公交线路', type: 'normal', start: '汽车站', end: '科技园', first: '06:00', last: '22:30', price: 2, interval: 10, color: '#1E88E5' },
  { no: '15路', name: '15路公交', type: 'normal', start: '大学城', end: '市中心', first: '06:30', last: '22:00', price: 2, interval: 12, color: '#43A047' },
  { no: '28路', name: '28路快速公交', type: 'express', start: '机场', end: '中央商务区', first: '05:00', last: '23:30', price: 5, interval: 15, color: '#FB8C00' },
  { no: '101路', name: '101路夜班车', type: 'night', start: '火车站', end: '居民区', first: '23:00', last: '05:00', price: 3, interval: 30, color: '#5E35B1' },
  { no: '地铁1号线', name: '地铁1号线', type: 'metro', start: '东山', end: '西海湾', first: '06:00', last: '23:00', price: 3, interval: 5, color: '#C62828' },
];

interface StationTemplate {
  name: string;
  address?: string;
  lat: number;
  lon: number;
  isTransfer?: number;
}

const baseStations: StationTemplate[] = [
  { name: '火车站', address: '站前街1号', lat: 39.9042, lon: 116.4074, isTransfer: 1 },
  { name: '人民广场', address: '中心路88号', lat: 39.9142, lon: 116.4174 },
  { name: '市政府', address: '行政大街1号', lat: 39.9242, lon: 116.4274 },
  { name: '中心医院', address: '健康路100号', lat: 39.9342, lon: 116.4374, isTransfer: 1 },
  { name: '体育馆', address: '体育路1号', lat: 39.9442, lon: 116.4474 },
  { name: '科技园', address: '创新大道1000号', lat: 39.9542, lon: 116.4574 },
  { name: '大学城', address: '学府路200号', lat: 39.9642, lon: 116.4674, isTransfer: 1 },
  { name: '汽车站', address: '交通路10号', lat: 39.8942, lon: 116.3974 },
  { name: '中央商务区', address: '商务大道888号', lat: 39.9742, lon: 116.4774, isTransfer: 1 },
  { name: '居民区', address: '幸福路500号', lat: 39.8842, lon: 116.3874 },
  { name: '机场', address: '空港路1号', lat: 40.0742, lon: 116.5774 },
  { name: '东山', address: '东山路1号', lat: 39.9942, lon: 116.5074, isTransfer: 1 },
  { name: '市中心', address: '中心大道1号', lat: 39.9442, lon: 116.4274 },
  { name: '西海湾', address: '海滨路1号', lat: 39.8942, lon: 116.3474 },
  { name: '文化公园', address: '文化路50号', lat: 39.9292, lon: 116.4224 },
  { name: '商业街', address: '商业步行街', lat: 39.9192, lon: 116.4124 },
  { name: '美食街', address: '美食大道100号', lat: 39.9092, lon: 116.4024 },
  { name: '高新技术园', address: '科技路300号', lat: 39.9592, lon: 116.4624 },
  { name: '体育中心', address: '体育场路2号', lat: 39.9492, lon: 116.4524 },
  { name: '会展中心', address: '会展路1号', lat: 39.9392, lon: 116.4424, isTransfer: 1 },
];

function initSampleData(): void {
  const db = getDb();
  initTables();

  logger.info('开始初始化示例数据...');

  const cityCount = db.prepare('SELECT COUNT(*) as cnt FROM cities').get() as { cnt: number };
  if (cityCount.cnt > 0) {
    logger.warn('数据库已有数据，跳过初始化。如需重新初始化，请删除 data/bus_service.db 文件');
    return;
  }

  const insertCity = db.prepare('INSERT INTO cities (code, name, province) VALUES (?, ?, ?)');
  const cityIds: Record<string, number> = {};
  for (const city of cities) {
    const r = insertCity.run(city.code, city.name, city.province);
    cityIds[city.code] = r.lastInsertRowid as number;
    logger.info(`已添加城市: ${city.name}`);
  }

  const targetCityId = cityIds['beijing'];

  const insertStation = db.prepare(
    'INSERT INTO stations (city_id, name, address, latitude, longitude, is_transfer) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const stationIds: Record<string, number> = {};
  for (const st of baseStations) {
    const r = insertStation.run(targetCityId, st.name, st.address || null, st.lat, st.lon, st.isTransfer || 0);
    stationIds[st.name] = r.lastInsertRowid as number;
  }
  logger.info(`已添加 ${baseStations.length} 个站点`);

  const insertLine = db.prepare(`
    INSERT INTO lines (city_id, line_no, name, type, start_station, end_station, first_bus, last_bus, ticket_price, interval_minutes, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLineStation = db.prepare(`
    INSERT INTO line_stations (line_id, station_id, direction, sequence, distance_from_start, travel_seconds)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertVehicle = db.prepare(`
    INSERT INTO vehicles (line_id, plate_no, direction, current_station_seq, next_station_seq, latitude, longitude, status, capacity, current_passengers)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `);

  const lineStationConfigs: Array<{ stations: string[]; reverse?: string[] }> = [
    { stations: ['火车站', '美食街', '商业街', '人民广场', '文化公园', '市政府', '中心医院', '会展中心', '体育中心', '体育馆'] },
    { stations: ['汽车站', '火车站', '美食街', '商业街', '人民广场', '文化公园', '市政府', '中心医院', '会展中心', '高新技术园', '科技园'] },
    { stations: ['大学城', '高新技术园', '科技园', '体育馆', '体育中心', '市中心', '文化公园', '市政府', '中心医院'] },
    { stations: ['机场', '东山', '大学城', '科技园', '体育中心', '市中心', '中央商务区'] },
    { stations: ['火车站', '美食街', '商业街', '居民区', '西海湾'] },
    { stations: ['东山', '大学城', '科技园', '会展中心', '中心医院', '市政府', '人民广场', '市中心', '西海湾'] },
  ];

  for (let i = 0; i < lineTemplates.length; i++) {
    const tmpl = lineTemplates[i];
    const cfg = lineStationConfigs[i];

    for (let direction = 0; direction <= 1; direction++) {
      const stationNames = direction === 0 ? cfg.stations : [...cfg.stations].reverse();
      const r = insertLine.run(
        targetCityId,
        tmpl.no + (direction === 1 ? '(回)' : ''),
        tmpl.name,
        tmpl.type,
        stationNames[0],
        stationNames[stationNames.length - 1],
        tmpl.first,
        tmpl.last,
        tmpl.price,
        tmpl.interval,
        tmpl.color,
      );
      const lineId = r.lastInsertRowid as number;

      let distance = 0;
      for (let seq = 0; seq < stationNames.length; seq++) {
        const stationId = stationIds[stationNames[seq]];
        if (stationId) {
          insertLineStation.run(lineId, stationId, direction, seq + 1, distance, 90 + Math.floor(Math.random() * 60));
          distance += 500 + Math.floor(Math.random() * 1000);
        }
      }

      const vehicleCount = 2 + Math.floor(Math.random() * 3);
      for (let v = 0; v < vehicleCount; v++) {
        const seq = 1 + Math.floor(Math.random() * (stationNames.length - 2));
        const stationName = stationNames[seq - 1];
        const station = baseStations.find((s) => s.name === stationName);
        const plateNo = `京A${String(10000 + Math.floor(Math.random() * 89999))}`;
        insertVehicle.run(
          lineId,
          plateNo,
          direction,
          seq,
          seq + 1,
          station ? station.lat + (Math.random() - 0.5) * 0.002 : 39.9,
          station ? station.lon + (Math.random() - 0.5) * 0.002 : 116.4,
          80,
          20 + Math.floor(Math.random() * 50),
        );
      }

      logger.info(`已添加线路: ${tmpl.no} 方向${direction} (${stationNames.length}站, ${vehicleCount}辆车)`);
    }
  }

  const insertAnnouncement = db.prepare(`
    INSERT INTO announcements (city_id, line_id, type, title, content, effective_from, is_published, created_by)
    VALUES (?, ?, ?, ?, ?, datetime('now'), 1, 'system')
  `);

  insertAnnouncement.run(
    targetCityId,
    null,
    'notice',
    '系统公告',
    '欢迎使用公交到站信息查询系统。本系统提供线路查询、实时到站、换乘建议等服务。',
  );
  insertAnnouncement.run(
    targetCityId,
    null,
    'warning',
    '恶劣天气提示',
    '今日部分地区有雨，出行请携带雨具，注意安全。',
  );

  const insertDiversion = db.prepare(`
    INSERT INTO route_diversions (line_id, title, description, effective_from, status)
    VALUES (?, ?, ?, datetime('now'), 'active')
  `);

  const line1 = db.prepare('SELECT id FROM lines WHERE line_no = ?').get('1路') as { id: number } | undefined;
  if (line1) {
    insertDiversion.run(
      line1.id,
      '1路临时绕行通知',
      '因道路施工，1路公交车临时绕行建设路，取消停靠"商业街"站，预计恢复时间另行通知。',
    );
  }

  const insertPunctuality = db.prepare(`
    INSERT INTO punctuality_records (line_id, station_id, scheduled_arrival, actual_arrival, delay_seconds, recorded_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const allLines = db.prepare('SELECT id FROM lines').all() as { id: number }[];
  const allStations = db.prepare('SELECT id FROM stations').all() as { id: number }[];

  for (let d = 0; d < 30; d++) {
    const date = new Date();
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().split('T')[0];

    for (let i = 0; i < 50; i++) {
      const line = allLines[Math.floor(Math.random() * allLines.length)];
      const station = allStations[Math.floor(Math.random() * allStations.length)];
      const delay = Math.floor(Math.random() * 300) - 30;
      const baseHour = 6 + Math.floor(Math.random() * 16);
      const baseMin = Math.floor(Math.random() * 60);
      const scheduled = `${dateStr} ${String(baseHour).padStart(2, '0')}:${String(baseMin).padStart(2, '0')}:00`;
      const actualMin = baseMin + Math.ceil(delay / 60);
      const actual = `${dateStr} ${String(baseHour).padStart(2, '0')}:${String(Math.max(0, actualMin)).padStart(2, '0')}:00`;
      insertPunctuality.run(line.id, station.id, scheduled, actual, Math.max(0, delay), dateStr);
    }
  }

  logger.info('准点率历史数据已生成');
  logger.info('数据初始化完成!');
}

try {
  initSampleData();
  process.exit(0);
} catch (err) {
  logger.error('数据初始化失败', err as Error);
  process.exit(1);
}
