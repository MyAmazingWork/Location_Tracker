// db.js
import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONN_LIMIT || 10),
  queueLimit: 0,
  supportBigNumbers: true,
});

export async function ensureSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query("SET SESSION sql_mode = 'STRICT_ALL_TABLES'");

    await conn.query(`
      CREATE TABLE IF NOT EXISTS employee_live_location (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        latitude DECIMAL(10,6) NOT NULL,
        longitude DECIMAL(10,6) NOT NULL,
        gps_status ENUM('on','off') NOT NULL DEFAULT 'on',
        last_update TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT uniq_emp UNIQUE (employee_id),
        INDEX idx_last_update (last_update),
        INDEX idx_emp (employee_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS employee_location_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        latitude DECIMAL(10,6) NOT NULL,
        longitude DECIMAL(10,6) NOT NULL,
        gps_status ENUM('on','off') NOT NULL DEFAULT 'on',
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_emp_time (employee_id, recorded_at),
        INDEX idx_recorded_at (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE OR REPLACE VIEW v_employee_latest AS
      SELECT ell.employee_id, ell.latitude, ell.longitude, ell.gps_status, ell.last_update
      FROM employee_live_location ell;
    `);
  } finally {
    conn.release();
  }
}
