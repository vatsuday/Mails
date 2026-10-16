# Company Mail

Company email website: compose single emails, send personalised bulk emails from Excel / CSV or saved contact lists, and track delivery. Sends through your own SMTP server (Gmail, Google Workspace, Microsoft 365, Zoho, Hostinger, Brevo, SendGrid …).

## Features
- Staff logins; admins manage users and email settings. Staff see only their own sent emails.
- Compose with To / Cc / Bcc, contact suggestions, rich-text editor, attachments (3 MB), signature, drafts.
- Bulk send wizard: upload a file, map columns, personalise with `{{first_name}}`, `{{company|fallback}}`, preview per person, send a test, then send with live progress, pause / resume / cancel and retry of failures.
- Delivery report per recipient with CSV export; unsubscribe links and an unsubscribed list that is always skipped.
- Contact lists, reusable templates, daily sending limit and speed control.

## Run locally
```
npm install
npm start          # http://localhost:3000
```
Without `DATABASE_URL` it uses an embedded Postgres in `data/`. The first admin is created from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (see `.env.example`). Set up sending under **Admin → Email settings**.

`npm run smoke` runs an end-to-end test against a fresh database and a fake SMTP server.

## Deploy (Vercel + Supabase)
Set these environment variables in Vercel, then `vercel deploy --prod`:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase **Transaction pooler** connection string (port 6543) |
| `APP_SECRET` | Long random text. Encrypts the saved SMTP password; never change it later |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account (used only when the database is empty) |
| `APP_TIMEZONE` | e.g. `Asia/Kolkata` |
| `APP_URL` | Optional public address used in unsubscribe links |

Tables are created automatically on first start (all prefixed `em_`, with row level security enabled so Supabase's public API cannot read them).

Bulk emails are sent in batches driven by the sender's browser tab, so keep that tab open until a bulk send finishes; it can be resumed at any time from **Sent & reports**.
