import mysql from 'mysql2/promise';

const host = process.env.DOLT_HOST ?? 'dolt';
const port = parseInt(process.env.DOLT_PORT ?? '3306', 10);

export const pool = mysql.createPool({
  host,
  port,
  user: 'root',
  database: 'shardworks',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: false,
});
