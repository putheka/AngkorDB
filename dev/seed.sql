-- AngkorDB dev fixture.
-- Re-runnable: drops and recreates the `public` and `billing` schemas.
-- Covers: tricky data types, NULLs, unicode, tables without PK, composite PK,
-- unique-index-only identity, FK chain across schemas, view, matview,
-- functions (incl. $$ bodies with semicolons), sequence, trigger, 1M-row table.

\set ON_ERROR_STOP on
SET client_min_messages = warning;

BEGIN;

DROP SCHEMA IF EXISTS billing CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
CREATE SCHEMA billing;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
CREATE TYPE public.user_status AS ENUM ('active', 'invited', 'suspended');

-- ---------------------------------------------------------------------------
-- users: every tricky type in one table
-- ---------------------------------------------------------------------------
CREATE TABLE public.users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uuid           uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  email          citext NOT NULL UNIQUE,
  name           varchar(100),
  country        char(2),
  status         public.user_status NOT NULL DEFAULT 'active',
  is_admin       boolean NOT NULL DEFAULT false,
  balance        numeric(20, 6) NOT NULL DEFAULT 0,
  big_counter    bigint,
  rating         double precision,
  tags           text[],
  scores         integer[],
  profile        jsonb,
  settings       json,
  avatar         bytea,
  last_ip        inet,
  session_length interval,
  birthday       date,
  wake_time      time,
  active_period  tstzrange,
  bio            text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamp
);
COMMENT ON TABLE public.users IS 'Every tricky Postgres type in one place';
COMMENT ON COLUMN public.users.big_counter IS 'Values above 2^53 to catch JS float precision loss';

INSERT INTO public.users
  (email, name, country, status, is_admin, balance, big_counter, rating, tags, scores,
   profile, settings, avatar, last_ip, session_length, birthday, wake_time, active_period, bio)
VALUES
  ('dara@example.com', 'Dara Sok', 'KH', 'active', true, 1234.567891, 9007199254740993, 4.75,
   ARRAY['admin', 'early-adopter'], ARRAY[10, 20, 30],
   '{"theme": "dark", "langs": ["km", "en"], "address": {"city": "Phnom Penh", "zip": null}}',
   '{"notify": true}', '\xdeadbeef', '203.0.113.7', '2 hours 30 minutes', '1990-04-14', '06:30',
   '[2026-01-01 00:00+07, 2026-12-31 23:59+07)', 'Plain bio'),
  ('sophea@example.com', 'សុភា ចាន់', 'KH', 'invited', false, 0, NULL, NULL,
   ARRAY['ខ្មែរ', 'unicode'], NULL, '{"note": "Khmer name + emoji 🙏"}', NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, 'សួស្តី — Khmer text'),
  ('quote@example.com', 'O''Brien "Quotes"', 'IE', 'active', false, -42.5, -1, -0.000001,
   ARRAY['has,comma', 'has"quote', 'has space'], ARRAY[]::integer[], '[]', '[]', '\x', '::1',
   '-1 day', '2000-02-29', '23:59:59', 'empty',
   E'Line one\nLine two\n\tTabbed line'),
  ('nulls@example.com', NULL, NULL, 'suspended', false, 0, NULL, NULL, NULL, NULL, NULL,
   NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  ('long@example.com', repeat('Long name ', 10), 'US', 'active', false, 99999999999999.999999,
   9223372036854775807, 1e308, ARRAY(SELECT 'tag' || g FROM generate_series(1, 30) g),
   ARRAY(SELECT g FROM generate_series(1, 50) g),
   jsonb_build_object('nested', jsonb_build_object('deep', jsonb_build_object('deeper', true)),
                      'list', (SELECT jsonb_agg(g) FROM generate_series(1, 100) g)),
   NULL, decode(repeat('ab', 512), 'hex'), '10.0.0.0/8', '1 year 2 mons 3 days', '1970-01-01',
   '00:00', '[2020-01-01,)', repeat('Very long text. ', 500));

INSERT INTO public.users (email, name, country, status, balance, rating, profile)
SELECT
  'user' || g || '@example.com',
  'User ' || g,
  (ARRAY['KH', 'TH', 'VN', 'US', 'FR'])[1 + g % 5],
  (ARRAY['active', 'invited', 'suspended'])[1 + g % 3]::public.user_status,
  round((random() * 10000)::numeric, 6),
  CASE WHEN g % 7 = 0 THEN NULL ELSE round((random() * 5)::numeric, 2) END,
  jsonb_build_object('seq', g)
FROM generate_series(1, 200) g;

-- ---------------------------------------------------------------------------
-- FK chain: users → orders → order_items (composite PK)
-- ---------------------------------------------------------------------------
CREATE TABLE public.orders (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending', 'paid', 'shipped', 'cancelled')),
  total      numeric(12, 2) NOT NULL DEFAULT 0,
  placed_at  timestamptz NOT NULL DEFAULT now(),
  note       text
);
CREATE INDEX orders_user_id_idx ON public.orders (user_id);
CREATE INDEX orders_open_idx ON public.orders (placed_at) WHERE status IN ('pending', 'paid');

INSERT INTO public.orders (user_id, status, total, placed_at, note)
SELECT
  1 + (g % 205),
  (ARRAY['pending', 'paid', 'shipped', 'cancelled'])[1 + g % 4],
  round((random() * 500)::numeric, 2),
  now() - (g || ' hours')::interval,
  CASE WHEN g % 10 = 0 THEN 'Gift wrap' END
FROM generate_series(1, 1000) g;

CREATE TABLE public.order_items (
  order_id    bigint NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  line_no     smallint NOT NULL,
  product_sku text NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  unit_price  numeric(12, 2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

INSERT INTO public.order_items (order_id, line_no, product_sku, qty, unit_price)
SELECT o.id, l, 'SKU-' || lpad((o.id * l % 997)::text, 4, '0'), 1 + (o.id + l) % 5,
       round((5 + random() * 95)::numeric, 2)
FROM public.orders o
CROSS JOIN generate_series(1, 3) l;

-- ---------------------------------------------------------------------------
-- Identity edge cases (ANG-8 D2)
-- ---------------------------------------------------------------------------
-- No primary key, no unique index → ctid fallback. Contains exact duplicate rows.
CREATE TABLE public.event_log (
  occurred_at timestamptz NOT NULL,
  level       text NOT NULL,
  message     text,
  payload     jsonb
);
INSERT INTO public.event_log VALUES
  ('2026-11-01 10:00+07', 'info', 'App started', '{"pid": 42}'),
  ('2026-11-01 10:00+07', 'info', 'App started', '{"pid": 42}'),
  ('2026-11-01 10:05+07', 'warn', 'Slow query', '{"ms": 1834}'),
  ('2026-11-01 10:06+07', 'error', NULL, NULL);

-- No primary key, but a NOT NULL unique column → unique-index fallback.
CREATE TABLE public.app_settings (
  key   text NOT NULL,
  value text,
  CONSTRAINT app_settings_key_uniq UNIQUE (key)
);
INSERT INTO public.app_settings VALUES ('theme', 'system'), ('page_size', '500'), ('beta', NULL);

-- Short varchar to test overflow errors (ANG-8 D7).
CREATE TABLE public.short_codes (
  code  varchar(3) PRIMARY KEY,
  label text
);
INSERT INTO public.short_codes VALUES ('KH', 'Cambodia'), ('TH', 'Thailand'), ('USA', 'United States');

-- ---------------------------------------------------------------------------
-- Functions and trigger
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- SQL function
CREATE FUNCTION public.order_total(p_order_id bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(qty * unit_price), 0) FROM public.order_items WHERE order_id = p_order_id;
$$;

-- Dollar-quoted body with a custom tag and semicolons inside (statement-splitter test).
CREATE FUNCTION public.greet(p_name text DEFAULT 'world') RETURNS text
LANGUAGE plpgsql AS $body$
DECLARE
  msg text := 'Hello; ' || p_name || '! -- not a comment';
BEGIN
  RETURN msg || ' /* not a comment either */';
END;
$body$;

-- ---------------------------------------------------------------------------
-- billing schema: cross-schema FK, sequence, matview
-- ---------------------------------------------------------------------------
CREATE SEQUENCE billing.invoice_no_seq START 1000 INCREMENT 1;

CREATE TABLE billing.invoices (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no integer NOT NULL UNIQUE DEFAULT nextval('billing.invoice_no_seq'),
  order_id   bigint NOT NULL REFERENCES public.orders (id),
  amount     numeric(12, 2) NOT NULL,
  currency   char(3) NOT NULL DEFAULT 'USD',
  issued_on  date NOT NULL DEFAULT current_date,
  paid       boolean NOT NULL DEFAULT false
);

INSERT INTO billing.invoices (order_id, amount, currency, issued_on, paid)
SELECT id, total, (ARRAY['USD', 'KHR'])[1 + id % 2], placed_at::date, status IN ('paid', 'shipped')
FROM public.orders
WHERE status <> 'cancelled';

CREATE MATERIALIZED VIEW billing.monthly_revenue AS
SELECT date_trunc('month', issued_on)::date AS month, currency, sum(amount) AS revenue, count(*) AS invoices
FROM billing.invoices
WHERE paid
GROUP BY 1, 2;

-- ---------------------------------------------------------------------------
-- View
-- ---------------------------------------------------------------------------
CREATE VIEW public.user_order_totals AS
SELECT u.id AS user_id, u.email, count(o.id) AS orders, coalesce(sum(o.total), 0) AS total_spent
FROM public.users u
LEFT JOIN public.orders o ON o.user_id = u.id
GROUP BY u.id, u.email;

-- ---------------------------------------------------------------------------
-- Big table: 1M rows for grid / paging / export performance
-- ---------------------------------------------------------------------------
CREATE TABLE public.metrics_big (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at timestamptz NOT NULL,
  sensor      text NOT NULL,
  value       double precision,
  meta        jsonb
);

INSERT INTO public.metrics_big (recorded_at, sensor, value, meta)
SELECT
  timestamptz '2026-01-01 00:00+00' + (g || ' seconds')::interval,
  'sensor-' || (g % 50),
  CASE WHEN g % 97 = 0 THEN NULL ELSE random() * 100 END,
  CASE WHEN g % 1000 = 0 THEN jsonb_build_object('calibrated', true) END
FROM generate_series(1, 1000000) g;

CREATE INDEX metrics_big_recorded_at_idx ON public.metrics_big (recorded_at);

COMMIT;

-- Fill planner stats so pg_class.reltuples row estimates are real (ANG-8 D5).
ANALYZE;
