# FrameCut Creator Studio — Website & Subscription API Starter

This is a **development scaffold**, not a production-ready billing system. It includes a responsive landing/pricing page, account registration/login, SQLite storage, cookie sessions, hashed short-lived app tokens, `/api/license/status`, and a PayMongo webhook signature-verification skeleton.

## Payment provider recommendation

For a Philippines-first launch, evaluate PayMongo Subscriptions for recurring PHP billing. Its documentation currently describes cards and Maya for subscriptions, and says the merchant account must be enabled for the feature. Check current eligibility, accepted methods, fees, business documents, payout requirements, and refund/chargeback rules directly with PayMongo. Do not put secret keys in the browser or PowerShell app.

## Run locally

1. Install Node.js 20 or newer.
2. Open this folder in a terminal.
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Leave `PAYMENTS_ENABLED=false` and keep provider secrets blank during local development.
6. Run `npm start` and open `http://localhost:3000`.

The local server creates `data/framecut.sqlite` automatically. Use fake test accounts only.

## API routes

- `POST /api/auth/register` — email/password account creation.
- `POST /api/auth/login` and `POST /api/auth/logout` — cookie-based website sessions.
- `GET /api/account` — current account and subscription state.
- `POST /api/app-token` — issues a short-lived app token only when a subscription record is active.
- `GET /api/license/status` — bearer-token endpoint expected by the PowerShell app.
- `POST /webhooks/paymongo` — raw-body signature verification skeleton with replay-window and duplicate-event checks.
- `POST /api/billing/start` — intentionally fails closed until checkout is implemented.

## Critical unfinished work before public launch

1. **Complete PayMongo checkout.** Create/verify plan IDs, create the customer and subscription, implement the initial invoice PaymentIntent/payment-method authorization flow, and handle redirects by retrieving payment status server-side. PayMongo says subscription billing needs account activation and the initial payment must be completed.
2. **Map webhook events correctly.** Confirm actual subscription/invoice event payloads in your PayMongo test dashboard. Extend the handler to re-fetch the canonical subscription from PayMongo when needed. Never grant access just because a browser says payment succeeded. Ensure subscription and user mapping is written before the first webhook can arrive.
3. **Persist subscription periods.** Update `current_period_end` from verified provider state. Handle `active`, `past_due`, `unpaid`, `cancelled`, invoice-paid/failed, renewals, refunds, disputes, and event ordering/idempotency.
4. **Finish account security.** Add email verification, password reset, CSRF protections for cookie-authenticated POSTs, account deletion, session/device management, audit logs, and a durable production database. SQLite on ephemeral hosting is not appropriate for production.
5. **Finish Windows app integration.** Set `%APPDATA%\FrameCut\subscription.json` to your deployed HTTPS API and account URL. Keep `Enforce` false until tested. Implement a friendly activation flow and verify status on app startup/periodically. Client-side checks alone are not strong DRM.
6. **Legal and operations.** Add Privacy Policy, Terms, cancellation/refund terms, support contact, business identity and tax obligations, backups, monitoring, rate limits, and security review.
7. **Deploy.** Choose a host with persistent database support, set secrets as environment variables, deploy to a temporary HTTPS URL, test PayMongo test mode, then connect a domain you own and repeat end-to-end tests before using live keys.

## Environment variables

See `.env.example`. `PAYMENTS_ENABLED` is intentionally not enough to make checkout work: `/api/billing/start` returns HTTP 501 even if set true until the provider adapter is completed. This prevents a misleading live checkout button.

## Domain

You do not need to purchase a domain before local development. First test on localhost, then deploy to a temporary HTTPS host. Buy a domain through a reputable registrar when ready; connect it through the hosting provider's dashboard and enable HTTPS. Never share passwords, API keys, webhook secrets, or identity documents in chat.
