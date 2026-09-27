# Rudraksha Farm — V109 Implementation

This package moves from documentation-only foundations to a runnable Node.js production backend foundation.

## Run locally
1. Install Node.js 20+.
2. Copy `.env.example` to `.env` and set strong values.
3. Export the environment variables in your shell (or use your deployment platform's environment settings).
4. Run `npm start`.
5. Open `http://localhost:3000`.

## Implemented API
- `GET /api/health`
- `GET /api/products`
- `POST /api/orders`
- `GET /api/orders/:id`
- `POST /api/admin/login`
- `GET /api/admin/orders`
- `PATCH /api/admin/orders/:id`
- `GET /api/admin/inventory`
- `PATCH /api/admin/products/:id`

## Important
- Product stock starts at 0 because real inventory was not supplied.
- Payment gateway is NOT live; payment status remains pending until a real provider is integrated.
- WhatsApp is NOT live; credentials are pending.
- Email, hosting, domain and database credentials are not embedded.
- The JSON store is suitable for local/demo validation only. Before public launch, move persistence to PostgreSQL/MySQL or another managed production database and add HTTPS, rate limiting, CSRF/origin controls as appropriate, secure cookie sessions, structured logging and backups.
