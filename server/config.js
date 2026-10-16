import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Optional .env file in the project root (KEY=value lines).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const dataDir = path.resolve(root, env.DATA_DIR || 'data');
const onVercel = Boolean(env.VERCEL);

export const config = {
  root,
  onVercel,
  dataDir,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  appName: env.APP_NAME || 'Company Mail',
  // Public address of the site, used in unsubscribe links. Empty = taken from the request.
  appUrl: (env.APP_URL || '').replace(/\/+$/, ''),
  // Supabase / PostgreSQL connection string (use the pooler URL on Vercel). Empty = local embedded Postgres.
  databaseUrl: env.DATABASE_URL || '',
  pgPoolMax: Number(env.PG_POOL_MAX || (onVercel ? 3 : 10)),
  // Secret used to encrypt the stored SMTP password and sign unsubscribe links.
  appSecret: env.APP_SECRET || '',
  // First admin account, created automatically when the database has no users.
  adminEmail: (env.ADMIN_EMAIL || 'admin@company.com').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || 'Admin@123',
  sessionHours: Number(env.SESSION_HOURS || 24 * 7),
  cookieSecure: onVercel || env.COOKIE_SECURE === 'true',
  trustProxy: onVercel || env.TRUST_PROXY === 'true',
  // SMTP defaults; an admin can override all of these from the Email settings page.
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    fromName: env.SMTP_FROM_NAME || '',
    fromEmail: env.SMTP_FROM_EMAIL || env.SMTP_USER || '',
  },
  // Vercel limits request bodies to 4.5 MB; attachments travel base64-encoded inside JSON.
  maxAttachmentBytes: 3 * 1024 * 1024,
  maxRecipients: 20000,
  // A bulk batch request stops sending after this long so it never hits the function timeout.
  batchTimeBudgetMs: 40000,
};
