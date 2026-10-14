
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, '');
const frontendUrl = (process.env.FRONTEND_URL || 'https://framecutss.pages.dev').replace(/\/$/, '');
const dbPath = process.env.DATABASE_PATH || './data/framecut.sqlite';

const MONTHLY_PRICE_CENTAVOS = 29900;
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';

fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS web_sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_tokens (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL DEFAULT 'paymongo',
 provider_customer_id TEXT,
 provider_subscription_id TEXT UNIQUE,
 plan TEXT NOT NULL CHECK(plan IN ('monthly','yearly')),
 status TEXT NOT NULL DEFAULT 'inactive',
 current_period_end TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_events (
 event_id TEXT PRIMARY KEY,
 received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_orders (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider_checkout_id TEXT UNIQUE,
 amount INTEGER NOT NULL,
 currency TEXT NOT NULL DEFAULT 'PHP',
 status TEXT NOT NULL DEFAULT 'pending'
   CHECK(status IN ('pending','paid','failed','expired')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry
 ON web_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_app_tokens_expiry
 ON app_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_user
 ON payment_orders(user_id, created_at);
`);

app.disable('x-powered-by');

const allowedOrigins = new Set([frontendUrl]);

app.use((req, res, next) => {
  const origin = req.get('Origin');

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }

  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", baseUrl],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

const billingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

const jsonParser = express.json({ limit: '32kb' });

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }

  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  res.setHeader(
    'Set-Cookie',
    `fc_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=None; Max-Age=${maxAgeSeconds}${isProd ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `fc_session=; Path=/; HttpOnly; SameSite=None; Max-Age=0${isProd ? '; Secure' : ''}`
  );
}

function requireUser(req, res, next) {
  const token = getCookie(req, 'fc_session');

  if (!token) return res.status(401).json({ error: 'Please sign in.' });

  const row = db.prepare(`
    SELECT u.id, u.email
    FROM web_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), Date.now());

  if (!row) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  req.user = row;
  next();
}

function currentSubscription(userId) {
  return db.prepare(`
    SELECT plan, status, current_period_end,
           current_period_end AS expiresAt
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId) || null;
}

/*
 * PayMongo webhook: keep this route BEFORE express.json().
 * This route deliberately fails closed until the actual event payload
 * and signature configuration have been tested.
 */
app.post(
  '/webhooks/paymongo',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(503).json({ error: 'Webhook is not configured.' });
    }

    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Expected raw webhook body.' });
    }

    const header =
      req.get('Paymongo-Signature') ||
      req.get('X-Paymongo-Signature') ||
      '';

    const parts = Object.fromEntries(
      header.split(',').map(part => {
        const i = part.indexOf('=');
        return i < 0
          ? [part.trim(), '']
          : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      })
    );

    const timestamp = parts.t;
    const suppliedText =
      process.env.PAYMONGO_LIVE_MODE === 'true' ? parts.li : parts.te;

    if (
      !timestamp ||
      !/^\d+$/.test(timestamp) ||
      !suppliedText ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    ) {
      return res.status(401).json({ error: 'Invalid webhook signature header.' });
    }

    const bodyText = req.body.toString('utf8');
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${bodyText}`)
      .digest();

    const supplied = Buffer.from(suppliedText, 'hex');

    if (
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(supplied, expected)
    ) {
      return res.status(401).json({ error: 'Signature verification failed.' });
    }

    let event;
    try {
      event = JSON.parse(bodyText);
    } catch {
      return res.status(400).json({ error: 'Invalid webhook JSON.' });
    }

    const eventId = event?.data?.id;
    const eventType = event?.data?.attributes?.type;
    const resource = event?.data?.attributes?.data;
    const attrs = resource?.attributes || {};

    if (!eventId || !eventType) {
      return res.status(400).json({ error: 'Missing event ID or type.' });
    }

    try {
      const processEvent = db.transaction(() => {
        const existing = db.prepare(
          'SELECT event_id FROM webhook_events WHERE event_id = ?'
        ).get(eventId);

        if (existing) return 'duplicate';

        /*
         * Important: payment activation is intentionally NOT implemented
         * here yet. A verified signature proves who sent an event, but
         * does not by itself prove this payment belongs to a particular
         * order. The exact PayMongo event shape and checkout/order linkage
         * must be verified before enabling subscription activation.
         */
        db.prepare(
          'INSERT INTO webhook_events(event_id) VALUES (?)'
        ).run(eventId);

        return 'received';
      });

      const result = processEvent();
      return res.status(200).json({ received: true, result });
    } catch (error) {
      console.error('Webhook processing error:', error.message);
      return res.status(500).json({ error: 'Webhook processing failed.' });
    }
  }
);

app.use(jsonParser);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'framecut-subscriptions',
    mode: isProd ? 'production' : 'development'
  });
});

/* ---------------- Authentication ---------------- */

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!emailIsValid(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (password.length < 12 || password.length > 200) {
    return res.status(400).json({
      error: 'Use a password between 12 and 200 characters.'
    });
  }

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const id = crypto.randomUUID();

  try {
    const hash = await bcrypt.hash(password, 12);

    db.prepare(
      'INSERT INTO users(id, email, password_hash) VALUES (?, ?, ?)'
    ).run(id, email, hash);

    const token = randomToken();
    const days = Math.max(1, Number(process.env.SESSION_DAYS || 7));

    db.prepare(`
      INSERT INTO web_sessions(token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sha256(token), id, Date.now() + days * 86400000, Date.now());

    setSessionCookie(res, token, days * 86400);

    return res.status(201).json({
      user: { id, email },
      subscription: currentSubscription(id)
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const user = db.prepare(
    'SELECT id, email, password_hash FROM users WHERE email = ?'
  ).get(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  const token = randomToken();
  const days = Math.max(1, Number(process.env.SESSION_DAYS || 7));

  db.prepare(`
    INSERT INTO web_sessions(token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sha256(token), user.id, Date.now() + days * 86400000, Date.now());

  setSessionCookie(res, token, days * 86400);

  return res.json({
    user: { id: user.id, email: user.email },
    subscription: currentSubscription(user.id)
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getCookie(req, 'fc_session');

  if (token) {
    db.prepare('DELETE FROM web_sessions WHERE token_hash = ?')
      .run(sha256(token));
  }

  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get('/api/account', requireUser, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    user: req.user,
    subscription: currentSubscription(req.user.id)
  });
});

app.post('/api/app-token', requireUser, (req, res) => {
  const sub = currentSubscription(req.user.id);

  if (
    !sub ||
    sub.status !== 'active' ||
    !sub.current_period_end ||
    !Number.isFinite(Date.parse(sub.current_period_end)) ||
    Date.parse(sub.current_period_end) <= Date.now()
  ) {
    return res.status(403).json({
      error: 'An active subscription is required before generating an app activation token.'
    });
  }

  const token = randomToken();
  const days = Math.max(1, Math.min(90, Number(process.env.APP_TOKEN_DAYS || 30)));
  const expiresAt = Date.now() + days * 86400000;

  db.prepare(`
    INSERT INTO app_tokens(token_hash, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(sha256(token), req.user.id, expiresAt, Date.now());

  return res.json({
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    message: 'Copy this token into FrameCut activation. It is shown only once.'
  });
});

app.get('/api/license/status', (req, res) => {
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ active: false, error: 'Missing bearer token.' });
  }

  const row = db.prepare(`
    SELECT u.id
    FROM app_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND t.revoked = 0 AND t.expires_at > ?
  `).get(sha256(match[1]), Date.now());

  if (!row) {
    return res.status(401).json({ active: false, error: 'Invalid or expired app token.' });
  }

  const sub = currentSubscription(row.id);
  const active = Boolean(
    sub &&
    sub.status === 'active' &&
    sub.current_period_end &&
    Number.isFinite(Date.parse(sub.current_period_end)) &&
    Date.parse(sub.current_period_end) > Date.now()
  );

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    active,
    plan: active ? sub.plan : null,
    expiresAt: active ? sub.current_period_end : null
  });
});

/* ---------------- Billing ---------------- */

/*
 * This route intentionally does NOT create a checkout yet.
 * It keeps billing disabled until:
 * 1. PayMongo checkout request/response fields are confirmed for your account.
 * 2. The webhook's exact event format and order matching are tested.
 * 3. Payment idempotency and expiry renewal are implemented and tested.
 */
app.post('/api/billing/checkout', requireUser, billingLimiter, async (req, res) => {
  if (!PAYMENTS_ENABLED) {
    return res.status(503).json({
      error: 'Checkout is disabled until the PayMongo integration has been tested.'
    });
  }

  const secretKey = process.env.PAYMONGO_SECRET_KEY;

  if (!secretKey) {
    return res.status(503).json({ error: 'Payment provider is not configured.' });
  }

  /*
   * Fail closed rather than accept money with an incomplete webhook.
   * Do not set PAYMENTS_ENABLED=true until this adapter is completed.
   */
  return res.status(503).json({
    error: 'Checkout adapter is not enabled. Complete and test webhook payment verification first.'
  });
});

/* Keep the existing route available for older frontend versions. */
app.post('/api/billing/start', requireUser, (_req, res) => {
  return res.status(503).json({
    error: 'Checkout is disabled until PayMongo integration tests are complete.'
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/webhooks/')) {
    return next();
  }

  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('Server error:', err.message);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

app.listen(port, () => {
  console.log(`FrameCut subscription API listening on ${baseUrl}`);
});
