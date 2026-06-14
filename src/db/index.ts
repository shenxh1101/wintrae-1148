import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.db.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    const logsDir = './data/logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    db = new Database(config.db.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    logger.info('Database connection established', { path: config.db.path });
  }
  return db;
}

export function initTables(): void {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      province TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER NOT NULL,
      line_no TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'normal',
      start_station TEXT NOT NULL,
      end_station TEXT NOT NULL,
      first_bus TEXT NOT NULL,
      last_bus TEXT NOT NULL,
      ticket_price REAL NOT NULL DEFAULT 2.0,
      interval_minutes INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'active',
      direction INTEGER NOT NULL DEFAULT 0,
      total_distance REAL DEFAULT 0,
      total_duration INTEGER DEFAULT 0,
      color TEXT DEFAULT '#1E88E5',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (city_id) REFERENCES cities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_lines_city ON lines(city_id);
    CREATE INDEX IF NOT EXISTS idx_lines_no ON lines(line_no);

    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      is_transfer INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (city_id) REFERENCES cities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_stations_city ON stations(city_id);
    CREATE INDEX IF NOT EXISTS idx_stations_name ON stations(name);
    CREATE INDEX IF NOT EXISTS idx_stations_geo ON stations(latitude, longitude);

    CREATE TABLE IF NOT EXISTS line_stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      station_id INTEGER NOT NULL,
      direction INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL,
      distance_from_start REAL DEFAULT 0,
      travel_seconds INTEGER DEFAULT 120,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (line_id) REFERENCES lines(id),
      FOREIGN KEY (station_id) REFERENCES stations(id),
      UNIQUE(line_id, station_id, direction, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_line_stations_line ON line_stations(line_id);
    CREATE INDEX IF NOT EXISTS idx_line_stations_station ON line_stations(station_id);

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      plate_no TEXT NOT NULL,
      direction INTEGER NOT NULL DEFAULT 0,
      current_station_seq INTEGER,
      next_station_seq INTEGER,
      latitude REAL,
      longitude REAL,
      status TEXT NOT NULL DEFAULT 'running',
      capacity INTEGER NOT NULL DEFAULT 80,
      current_passengers INTEGER DEFAULT 0,
      last_updated TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (line_id) REFERENCES lines(id)
    );

    CREATE INDEX IF NOT EXISTS idx_vehicles_line ON vehicles(line_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_token TEXT UNIQUE NOT NULL,
      nickname TEXT,
      avatar_url TEXT,
      device_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      extra_data TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, type, target_id)
    );

    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id);

    CREATE TABLE IF NOT EXISTS arrival_reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      line_id INTEGER NOT NULL,
      station_id INTEGER NOT NULL,
      direction INTEGER NOT NULL DEFAULT 0,
      minutes_before INTEGER NOT NULL DEFAULT 5,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      weekdays TEXT DEFAULT '1,2,3,4,5',
      start_time TEXT DEFAULT '07:00',
      end_time TEXT DEFAULT '21:00',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (line_id) REFERENCES lines(id),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_user ON arrival_reminders(user_id);

    CREATE TABLE IF NOT EXISTS crowd_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      line_id INTEGER NOT NULL,
      station_id INTEGER,
      vehicle_id INTEGER,
      level TEXT NOT NULL,
      passenger_count INTEGER,
      reported_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (line_id) REFERENCES lines(id)
    );

    CREATE INDEX IF NOT EXISTS idx_crowd_line ON crowd_reports(line_id);

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER,
      line_id INTEGER,
      type TEXT NOT NULL DEFAULT 'notice',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      effective_from TEXT,
      effective_to TEXT,
      is_published INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (city_id) REFERENCES cities(id),
      FOREIGN KEY (line_id) REFERENCES lines(id)
    );

    CREATE INDEX IF NOT EXISTS idx_announcements_city ON announcements(city_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_line ON announcements(line_id);

    CREATE TABLE IF NOT EXISTS route_diversions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      original_stations TEXT,
      diverted_stations TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (line_id) REFERENCES lines(id)
    );

    CREATE TABLE IF NOT EXISTS punctuality_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id INTEGER NOT NULL,
      station_id INTEGER NOT NULL,
      scheduled_arrival TEXT NOT NULL,
      actual_arrival TEXT NOT NULL,
      delay_seconds INTEGER NOT NULL DEFAULT 0,
      vehicle_id INTEGER,
      recorded_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (line_id) REFERENCES lines(id),
      FOREIGN KEY (station_id) REFERENCES stations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_punctuality_line_date ON punctuality_records(line_id, recorded_date);
    CREATE INDEX IF NOT EXISTS idx_punctuality_station ON punctuality_records(station_id);

    CREATE TABLE IF NOT EXISTS feedbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      line_id INTEGER,
      station_id INTEGER,
      images TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reply TEXT,
      replied_by TEXT,
      replied_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_feedbacks_status ON feedbacks(status);

    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_time_ms INTEGER,
      client_ip TEXT,
      user_token TEXT,
      city_code TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_apicalls_time ON api_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_apicalls_endpoint ON api_calls(endpoint);
  `);

  logger.info('Database tables initialized');
}
