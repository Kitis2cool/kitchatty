// db.js
import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'kitchatty'
});

