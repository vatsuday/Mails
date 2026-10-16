// Local / self-hosted server. On Vercel the same app runs from api/index.js instead.
import http from 'node:http';
import { config } from './config.js';
import app from './app.js';
import { ensureFirstAdmin } from './auth.js';

await ensureFirstAdmin();

http.createServer(app).listen(config.port, config.host, () => {
  console.log(`${config.appName} running on http://localhost:${config.port}`);
  console.log(`  Database: ${config.databaseUrl ? 'PostgreSQL (DATABASE_URL)' : 'local embedded Postgres (data/pgdata)'}`);
  console.log(`  SMTP:     ${config.smtp.host ? `${config.smtp.host}:${config.smtp.port} (from .env, can be changed in Admin → Email settings)` : 'not set in .env (set it in Admin → Email settings)'}`);
  if (config.adminPassword === 'Admin@123') console.log(`  First login: ${config.adminEmail} / Admin@123  (change it after logging in)`);
});
