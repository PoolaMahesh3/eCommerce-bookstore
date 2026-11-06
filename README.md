# Bookstore Backend

eCommerce bookstore backend: catalog and search, cart, checkout saga, payments, inventory, fulfillment, digital delivery, reviews and notifications.

It is a **modular monolith**: each module owns its tables and talks to the others through services or the transactional-outbox event bus. That keeps the seams in the right places to split into microservices later.

- Stack: TypeScript on Node.js 24+ (native type stripping, no build step), Fastify 5, `jose` for JWT, `node:sqlite` with FTS5.
- Only two runtime dependencies: `fastify` and `jose`.

## Run

```powershell
npm install
npm run gen-env > .env     # random dev secrets, binds 127.0.0.1
npm start
npm test                   # 32 tests
npm run typecheck
```

`.env` is git-ignored. In production, inject secrets from Vault or IBM Key Protect and see `.env.example` for all settings.

## Modules

| Module | File | Notes |
|---|---|---|
| Auth / RBAC | `src/auth.ts` | scrypt passwords, HS256 JWT built in; **OIDC** (JWKS, RS256/ES256/PS256) when `OIDC_*` is set. Roles: `customer`, `catalog_admin`, `order_admin`, `support`, `admin`. |
| Catalog + search | `src/catalog.ts` | Book → Edition (ISBN-13 checksum, format, price). FTS5 search, filters, autocomplete, cursor pagination. User text is quoted per token so it cannot inject FTS operators. |
| Cart + pricing | `src/cart.ts` | Server-side re-pricing and coupons. Clients never send prices. |
| Inventory | `src/inventory.ts` | Atomic conditional reservations (no oversell), commit, release, restock. |
| Orders (saga) | `src/orders.ts` | Idempotent checkout, state machine, cancel, reservation expiry. |
| Payments | `src/payments.ts` | Provider interface (simulated PSP), HMAC-signed webhook with timestamp tolerance, replay-safe, amount check, refunds. |
| Fulfillment, digital, notifications | `src/fulfillment.ts` | Event consumers; entitlements and short-lived, user-bound download links. |
| Reviews + recommendations | `src/reviews.ts` | Verified-purchase reviews; "also bought" from co-purchases. |
| Event bus | `src/events.ts` | Transactional outbox, idempotent consumers, dead-lettering after 5 attempts. |

## Checkout flow

1. `POST /v1/checkout` with an `Idempotency-Key` header. Replays return the same order, and the same key with a different body returns `422`.
2. In one DB transaction: re-price the cart, create the order, and reserve stock. Any shortfall rolls everything back (`409 INSUFFICIENT_STOCK`).
3. Create the payment intent. If the provider fails, the stock is released, the order is marked `FAILED`, and the client gets `502`.
4. The provider calls `POST /v1/payments/webhook`. It is verified, then `payment.captured` is published, which commits stock and sets the order to `PAID`. Fulfillment, digital delivery and notifications consume `order.paid`.
5. Unpaid orders expire after `RESERVATION_TTL_SEC` and their stock is released. A payment that succeeds after the order was closed is queued for refund.

States: `PENDING → PAID → PACKED → SHIPPED → DELIVERED`, plus `CANCELLED`, `REFUNDED`, `FAILED`. Digital-only orders go straight to `DELIVERED`.

## API (`/v1`)

```
POST /auth/register | /auth/login          GET /me
GET  /books?query&category&author&format&minPrice&maxPrice&sort&limit&cursor
GET  /books/:id        /editions/:isbn      /search/suggest?q=
GET  /books/:id/reviews | POST same         GET /books/:id/also-bought
GET  /cart             PUT|DELETE /cart/items/:editionId
POST /checkout         GET /orders  /orders/:id     POST /orders/:id/cancel
POST /payments/webhook                      (HMAC: x-webhook-timestamp, x-webhook-signature)
GET  /library          POST /library/:editionId/download-link    GET /downloads/:token
GET  /notifications
Admin: POST /admin/books  PUT /admin/books/:id  POST /admin/books/:id/editions
       PATCH /admin/editions/:id  PATCH /admin/inventory/:editionId  POST /admin/coupons
       GET /admin/orders  PATCH /admin/orders/:id/status
GET  /healthz  /readyz
```

Errors use one envelope, `{code, message, traceId}`, and never include internals.

Webhook signature: `HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<raw body>")`, hex-encoded. Timestamps must be within 5 minutes.

## Security controls

- **Secrets:** required from the environment, with minimum lengths. The app refuses to start without them or with a wildcard `HOST`. `.gitignore` excludes `.env` and database files.
- **Authentication:** passwords use scrypt with constant-time verification and a dummy hash for unknown users. JWTs pin the algorithm, issuer and audience. Login and registration have a stricter rate limit.
- **Authorization:** RBAC is checked on every route. Orders and downloads are owner-scoped, and other users get `404`.
- **Data protection:** shipping addresses are encrypted with AES-256-GCM. Card data never reaches this service, because the provider tokenizes it (PCI SAQ-A). Client secrets are encrypted at rest.
- **Input handling:** allowlist validation rejects unknown fields. All SQL is parameterized. Pagination is bounded. Body size is capped at 256 KB. Request timeouts are set.
- **Responses:** security headers are set, private data is `no-store`, and `Authorization`, webhook signatures and download tokens are redacted from logs.
- **TLS:** terminate at the gateway or set `TLS_CERT_FILE` and `TLS_KEY_FILE` (TLS 1.2 or higher).
- **Supply chain:** `package-lock.json` is committed, and `npm audit` reports 0 vulnerabilities at the time of writing.

## Limits of this implementation

Be aware of these before using it for real traffic:

- **Database:** SQLite is a single-writer, single-node store. It's used for zero-setup and for race-free reservations. For production, move to PostgreSQL. The conditional `UPDATE ... WHERE on_hand - reserved >= ?` pattern stays the same, but transactions then need real isolation and `SELECT ... FOR UPDATE`.
- **Event bus:** the outbox relay is in-process. Replace `EventBus.dispatch()` with a Kafka publisher to scale out. Producers and consumers are unchanged.
- **Payments:** `SimulatedProvider` stands in for Stripe or Adyen. Implement `PaymentProvider` and keep the webhook verification shown here.
- **Search:** FTS5 stands in for OpenSearch. Use the same `books` data as the source of truth.
- **Rate limiting** is in-memory per instance. Enforce it at the API gateway or back it with Redis.
- **Scope not built:** email and SMS sending (notifications are stored only), real object storage for downloads (the endpoint returns a stub), MFA (delegate to your IdP), and multi-warehouse stock.
- **Dockerfile:** written to the repo's policy (Red Hat UBI minimal, non-root) but **not built or run here**, because there is no container runtime on this machine. Confirm the image tag exists in your registry, and set `HOST` to the pod IP at deploy time.
