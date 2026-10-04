-- Rudraksha Farm production PostgreSQL schema
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pack TEXT NOT NULL,
  price INTEGER NOT NULL,
  stock INTEGER NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  customer JSONB NOT NULL,
  items JSONB NOT NULL,
  subtotal INTEGER NOT NULL,
  shipping INTEGER NOT NULL,
  total INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'received',
  cashfree_order_id TEXT,
  cashfree_environment TEXT,
  payment_session_id TEXT,
  inventory_deducted BOOLEAN NOT NULL DEFAULT FALSE,
  coupon_code TEXT,
  discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  order_access_token TEXT UNIQUE,
  courier TEXT,
  tracking_number TEXT,
  dispatched_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  phone TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  password_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_action TEXT NOT NULL,
  order_id TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value NUMERIC(10,2) NOT NULL CHECK (value > 0),
  min_subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS order_notifications (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  channel TEXT NOT NULL DEFAULT 'internal'
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coupons_active ON coupons(active,expires_at);
CREATE INDEX IF NOT EXISTS idx_order_notifications_order ON order_notifications(order_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_access_token ON orders(order_access_token);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders ((customer->>'phone'));
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_phone ON customer_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires_at ON customer_sessions(expires_at);
