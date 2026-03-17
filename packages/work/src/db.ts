import mysql from 'mysql2/promise';

const host = process.env.DOLT_HOST ?? 'dolt';
const port = parseInt(process.env.DOLT_PORT ?? '3306', 10);
const user = process.env.DOLT_USER ?? 'root';
const password = process.env.DOLT_PASSWORD ?? undefined;
const database = process.env.DOLT_DATABASE ?? 'shardworks';

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: false,
});
