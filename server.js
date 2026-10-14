
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
const dbPath = process.env.DATABASE_PATH || './data/framecut.sqlite';

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

CREATE INDEX IF NOT EXISTS idx_web_sessions_expiry
ON web_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_app_tokens_expiry
ON app_tokens(expires_at);
`);

app.disable('x-powered-by');

// CORS: allow the FrameCut website to call this API.
const allowedOrigins = new Set([
  'https://framecutss.pages.dev'
]);

app.use((req, res, next) => {
  const origin = req.get('Origin');

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization'
    );
  }

  if (req.method === 'OPTIONS') {
    if (!origin || !allowedOrigins.has(origin)) {
      return res.sendStatus(403);
    }

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
      connectSrc: [
        "'self'",
        'https://framecut-subscription-api.onrender.com'
      ],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
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
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && email.length <= 254;
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';

  for (const part of raw.split(';')) {
    const i = part.indexOf('=');

    if (i > -1 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }

  return null;
}

// Cross-site cookies require SameSite=None and Secure in production.
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

  if (!token) {
    return res.status(401).json({
      error: 'Please sign in.'
    });
  }

  const row = db.prepare(`
    SELECT u.id, u.email
    FROM web_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), Date.now());

  if (!row) {
    clearSessionCookie(res);

    return res.status(401).json({
      error: 'Session expired. Please sign in again.'
    });
  }

  req.user = row;
  next();
}

function currentSubscription(userId) {
  return db.prepare(`
    SELECT
      plan,
      status,
      current_period_end,
      current_period_end AS expiresAt
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId) || null;
}

// PayMongo webhook must be mounted before JSON parsing.
app.post(
  '/webhooks/paymongo',
  express.raw({
    type: 'application/json',
    limit: '1mb'
  }),
  (req, res) => {
    const secret = process.env.PAYMONGO_WEBHOOK_SECRET;

    if (!secret) {
      return res.status(503).json({
        error: 'Webhook secret is not configured.'
      });
    }

    const header =
      req.get('Paymongo-Signature') ||
      req.get('X-Paymongo-Signature') ||
      '';

    const parts = Object.fromEntries(
      header.split(',').map(item => {
        const i = item.indexOf('=');

        return i < 0
          ? [item, '']
          : [
              item.slice(0, i).trim(),
              item.slice(i + 1).trim()
            ];
      })
    );

    const timestamp = parts.t;

    if (
      !timestamp ||
      (!parts.te && !parts.li) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    ) {
      return res.status(401).json({
        error: 'Invalid or stale webhook signature.'
      });
    }

    const signed = Buffer.from(
      crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${req.body.toString('utf8')}`)
        .digest('hex')
    );

    const suppliedText =
      process.env.PAYMONGO_LIVE_MODE === 'true'
        ? parts.li
        : parts.te;

    if (!suppliedText) {
      return res.status(401).json({
        error: 'Missing signature for configured mode.'
      });
    }

    const supplied = Buffer.from(suppliedText);

    if (
      signed.length !== supplied.length ||
      !crypto.timingSafeEqual(signed, supplied)
    ) {
      return res.status(401).json({
        error: 'Signature verification failed.'
      });
    }

    let event;

    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({
        error: 'Invalid JSON.'
      });
    }

    const eventId = event?.data?.id || event?.id;

    if (!eventId) {
      return res.status(400).json({
        error: 'Missing event ID.'
      });
    }

    try {
      const already = db.prepare(
        'SELECT event_id FROM webhook_events WHERE event_id = ?'
      ).get(eventId);

      if (already) {
        return res.status(200).json({
          received: true,
          duplicate: true
        });
      }

      const resource =
        event?.data?.attributes?.data ||
        event?.data?.attributes?.resource ||
        event?.data?.attributes ||
        {};

      const type = resource?.type || '';
      const attrs = resource?.attributes || resource;
      const providerSubId = resource?.id || attrs?.subscription_id;
      const status = attrs?.status;

      // Only verified webhooks may update subscription status.
      if (type === 'subscription' && providerSubId && status) {
        const allowed = [
          'active',
          'past_due',
          'unpaid',
          'cancelled',
          'incomplete',
          'incomplete_cancelled'
        ];

        if (allowed.includes(status)) {
          db.prepare(`
            UPDATE subscriptions
            SET status = ?, updated_at = CURRENT_TIMESTAMP
            WHERE provider_subscription_id = ?
          `).run(status, providerSubId);
        }
      }

      db.prepare(
        'INSERT INTO webhook_events(event_id) VALUES(?)'
      ).run(eventId);

      return res.status(200).json({
        received: true
      });
    } catch (error) {
      console.error('Webhook processing error:', error.message);

      return res.status(500).json({
        error: 'Webhook processing failed.'
      });
    }
  }
);

app.use(jsonParser);

app.use(express.static(
  path.join(__dirname, 'public'),
  { extensions: ['html'] }
));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'framecut-subscriptions',
    mode: isProd ? 'production' : 'development'
  });
});

// Register an account.
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (!emailIsValid(email)) {
    return res.status(400).json({
      error: 'Enter a valid email address.'
    });
  }

  if (password.length < 12 || password.length > 200) {
    return res.status(400).json({
      error: 'Use a password between 12 and 200 characters.'
    });
  }

  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({
      error: 'An account with that email already exists.'
    });
  }

  const id = crypto.randomUUID();

  try {
    const hash = await bcrypt.hash(password, 12);

    db.prepare(`
      INSERT INTO users(id, email, password_hash)
      VALUES(?, ?, ?)
    `).run(id, email, hash);

    const token = randomToken();
    const days = Math.max(1, Number(process.env.SESSION_DAYS || 7));

    db.prepare(`
      INSERT INTO web_sessions(token_hash, user_id, expires_at, created_at)
      VALUES(?, ?, ?, ?)
    `).run(
      sha256(token),
      id,
      Date.now() + days * 86400000,
      Date.now()
    );

    setSessionCookie(res, token, days * 86400);

    res.status(201).json({
      user: { id, email },
      subscription: currentSubscription(id)
    });
  } catch (error) {
    console.error(error.message);

    res.status(500).json({
      error: 'Could not create account.'
    });
  }
});

// Log in.
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const user = db.prepare(`
    SELECT id, email, password_hash
    FROM users
    WHERE email = ?
  `).get(email);

  if (
    !user ||
    !(await bcrypt.compare(password, user.password_hash))
  ) {
    return res.status(401).json({
      error: 'Email or password is incorrect.'
    });
  }

  const token = randomToken();
  const days = Math.max(1, Number(process.env.SESSION_DAYS || 7));

  db.prepare(`
    INSERT INTO web_sessions(token_hash, user_id, expires_at, created_at)
    VALUES(?, ?, ?, ?)
  `).run(
    sha256(token),
    user.id,
    Date.now() + days * 86400000,
    Date.now()
  );

  setSessionCookie(res, token, days * 86400);

  res.json({
    user: {
      id: user.id,
      email: user.email
    },
    subscription: currentSubscription(user.id)
  });
});

// Log out.
app.post('/api/auth/logout', (req, res) => {
  const token = getCookie(req, 'fc_session');

  if (token) {
    db.prepare(
      'DELETE FROM web_sessions WHERE token_hash = ?'
    ).run(sha256(token));
  }

  clearSessionCookie(res);

  res.json({ ok: true });
});

// Account information.
app.get('/api/account', requireUser, (req, res) => {
  res.json({
    user: req.user,
    subscription: currentSubscription(req.user.id)
  });
});

// Generate a desktop-app activation token.
app.post('/api/app-token', requireUser, (req, res) => {
  const sub = currentSubscription(req.user.id);

  if (
    !sub ||
    sub.status !== 'active' ||
    (
      sub.current_period_end &&
      Date.parse(sub.current_period_end) < Date.now()
    )
  ) {
    return res.status(403).json({
      error: 'An active subscription is required before generating an app activation token.'
    });
  }

  const token = randomToken();
  const days = Math.max(
    1,
    Math.min(90, Number(process.env.APP_TOKEN_DAYS || 30))
  );

  db.prepare(`
    INSERT INTO app_tokens(token_hash, user_id, expires_at, created_at)
    VALUES(?, ?, ?, ?)
  `).run(
    sha256(token),
    req.user.id,
    Date.now() + days * 86400000,
    Date.now()
  );

  res.json({
    token,
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
    message: 'Copy this token into FrameCut activation. It is shown only once.'
  });
});

// Desktop-app license verification.
app.get('/api/license/status', (req, res) => {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      active: false,
      error: 'Missing bearer token.'
    });
  }

  const row = db.prepare(`
    SELECT u.id
    FROM app_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
      AND t.revoked = 0
      AND t.expires_at > ?
  `).get(sha256(match[1]), Date.now());

  if (!row) {
    return res.status(401).json({
      active: false,
      error: 'Invalid or expired app token.'
    });
  }

  const sub = currentSubscription(row.id);

  const active =
    !!sub &&
    sub.status === 'active' &&
    (
      !sub.current_period_end ||
      Date.parse(sub.current_period_end) > Date.now()
    );

  res.setHeader('Cache-Control', 'no-store');

  res.json({
    active,
    plan: active ? sub.plan : null,
    expiresAt: active ? sub.current_period_end : null
  });
});

// Billing is intentionally disabled until checkout is fully implemented.
app.post('/api/billing/start', requireUser, (_req, res) => {
  if (process.env.PAYMENTS_ENABLED !== 'true') {
    return res.status(503).json({
      error: 'Checkout is not enabled yet. Finish payment-provider onboarding, checkout implementation, and webhook testing first.'
    });
  }

  return res.status(501).json({
    error: 'Payment provider checkout adapter is not yet implemented. Keep PAYMENTS_ENABLED=false until it is complete.'
  });
});

// Serve the website for non-API routes.
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/webhooks/')
  ) {
    return next();
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler.
app.use((err, _req, res, _next) => {
  console.error(err.message);

  res.status(500).json({
    error: 'Unexpected server error.'
  });
});

app.listen(port, () => {
  console.log(`FrameCut subscription starter listening on ${baseUrl}`);
});
