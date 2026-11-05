/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDERS & FULFILMENT — the sixth domain
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ⚠ **THE TRAP: A PARTIAL SHIPMENT IS NOT A FULFILLED ORDER.** An order with
 * four lines and one of them shipped has *a* shipment, and `EXISTS (shipment)`
 * calls it fulfilled. The customer is still waiting for three things. Counting
 * orders with at least one shipment as done overstates fulfilment and, worse,
 * removes exactly the orders somebody needs to chase from the list of orders to
 * chase. `orders_partially_shipped` exists so that set has a name.
 *
 * ⚠ **THE SECOND TRAP: A CANCELLED LINE IS NOT REVENUE.** `SUM(qty * unit_price_cents)`
 * over every line of an order is the obvious total and it is wrong the moment
 * anybody cancels a line — which two orders here have. Order value must exclude
 * `status = 'cancelled'` lines, and the difference is large enough to be visible
 * rather than a rounding argument.
 *
 * ⚠ **THE THIRD: MINOR UNITS.** `unit_price_cents` and `line_discount_cents` are
 * MINOR units (pence); `customers.credit_limit` is MAJOR. This is `finance_demo`'s
 * units trap deliberately reproduced in a third place, because getting it wrong
 * reports a customer as 100× over their credit limit and the number still looks
 * like a number.
 *
 * ⚠ **ALL DATA IS SYNTHETIC** — invented names on RFC 2606 `.example` domains.
 */
import type { DomainSpec } from "./domain.js";

const DDL = `
DROP TABLE IF EXISTS returns, shipments, order_lines, orders, inventory, products, customers, warehouses, org_settings CASCADE;

CREATE TABLE org_settings (
  id                     int PRIMARY KEY,
  default_ship_days      int NOT NULL,
  low_stock_threshold    int NOT NULL,
  backorder_alert_days   int NOT NULL
);

CREATE TABLE warehouses (
  code    text PRIMARY KEY,
  name    text NOT NULL,
  region  text NOT NULL,
  contact_email text NOT NULL
);

CREATE TABLE customers (
  id           int PRIMARY KEY,
  name         text NOT NULL,
  email        text,
  segment      text NOT NULL,
  -- ⚠ MAJOR units. Every money column on an order line is MINOR. See the header.
  credit_limit numeric(12,2) NOT NULL
);

CREATE TABLE products (
  sku          text PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL,
  unit_price_cents int NOT NULL,
  discontinued boolean NOT NULL DEFAULT false
);

CREATE TABLE inventory (
  sku            text REFERENCES products(sku),
  warehouse_code text REFERENCES warehouses(code),
  on_hand        int NOT NULL,
  reserved       int NOT NULL,
  PRIMARY KEY (sku, warehouse_code)
);

CREATE TABLE orders (
  id           int PRIMARY KEY,
  order_code   text UNIQUE NOT NULL,
  customer_id  int REFERENCES customers(id),
  status       text NOT NULL,
  placed_at    timestamptz NOT NULL,
  promised_at  timestamptz,
  channel      text NOT NULL
);

CREATE TABLE order_lines (
  id                  int PRIMARY KEY,
  order_id            int REFERENCES orders(id),
  sku                 text REFERENCES products(sku),
  qty                 int NOT NULL,
  unit_price_cents    int NOT NULL,
  line_discount_cents int NOT NULL DEFAULT 0,
  status              text NOT NULL
);

CREATE TABLE shipments (
  id             int PRIMARY KEY,
  order_id       int REFERENCES orders(id),
  order_line_id  int REFERENCES order_lines(id),
  warehouse_code text REFERENCES warehouses(code),
  shipped_at     timestamptz NOT NULL,
  carrier        text NOT NULL,
  tracking       text
);

CREATE TABLE returns (
  id            int PRIMARY KEY,
  order_line_id int REFERENCES order_lines(id),
  qty           int NOT NULL,
  reason        text NOT NULL,
  received_at   timestamptz NOT NULL
);
`;

const at = (day: number, hour = 10) =>
  `2026-06-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`;

const WAREHOUSES: unknown[][] = [
  ["ldn", "London", "eu", "ldn-dispatch@acme-orders.example"],
  ["ams", "Amsterdam", "eu", "ams-dispatch@acme-orders.example"],
  ["nyc", "New York", "na", "nyc-dispatch@acme-orders.example"],
];

const CUSTOMERS: unknown[][] = [
  [1, "Northwind Traders", "buying@northwind.example", "wholesale", 50000.0],
  [2, "Contoso Ltd", "orders@contoso.example", "wholesale", 25000.0],
  [3, "Fabrikam Inc", "procurement@fabrikam.example", "retail", 5000.0],
  [4, "Tailspin Toys", "shop@tailspin.example", "retail", 2500.0],
  // ⚠ No email. Anything that mails customers must cope rather than send to null.
  [5, "Wingtip Papers", null, "retail", 1000.0],
];

const PRODUCTS: unknown[][] = [
  ["SKU-100", "Ergonomic chair", "furniture", 24900, false],
  ["SKU-101", "Standing desk", "furniture", 49900, false],
  ["SKU-102", "Desk lamp", "lighting", 4500, false],
  ["SKU-103", "Monitor arm", "accessories", 8900, false],
  ["SKU-104", "Cable tray", "accessories", 1900, false],
  ["SKU-105", "Footrest", "accessories", 3200, true],
];

const INVENTORY: unknown[][] = [
  ["SKU-100", "ldn", 12, 4], ["SKU-100", "ams", 3, 3], ["SKU-100", "nyc", 20, 2],
  ["SKU-101", "ldn", 2, 2], ["SKU-101", "ams", 0, 0], ["SKU-101", "nyc", 6, 1],
  ["SKU-102", "ldn", 80, 5], ["SKU-102", "ams", 40, 0], ["SKU-102", "nyc", 55, 3],
  ["SKU-103", "ldn", 4, 4], ["SKU-103", "ams", 9, 1], ["SKU-103", "nyc", 0, 0],
  ["SKU-104", "ldn", 200, 10], ["SKU-104", "ams", 150, 0], ["SKU-104", "nyc", 90, 6],
  ["SKU-105", "ldn", 1, 0], ["SKU-105", "ams", 0, 0], ["SKU-105", "nyc", 0, 0],
];

/**
 * 12 orders.
 *
 * ⚠ **ORD-1003 IS THE PARTIAL-SHIPMENT TRAP**: three lines, one shipped. It has
 * a shipment, so `EXISTS (shipment)` calls it fulfilled while the customer waits
 * for two things.
 *
 * ⚠ **ORD-1005 AND ORD-1009 ARE THE CANCELLED-LINE TRAP**: each carries a
 * cancelled line worth more than the rest of the order, so summing every line
 * roughly doubles their value.
 */
const ORDERS: unknown[][] = [
  [1, "ORD-1001", 1, "open", at(1), at(8), "web"],
  [2, "ORD-1002", 2, "open", at(2), at(9), "edi"],
  [3, "ORD-1003", 1, "open", at(3), at(10), "web"],
  [4, "ORD-1004", 3, "shipped", at(3), at(11), "web"],
  [5, "ORD-1005", 2, "open", at(4), at(12), "phone"],
  [6, "ORD-1006", 4, "open", at(5), at(9), "web"],
  [7, "ORD-1007", 5, "open", at(5), at(13), "web"],
  [8, "ORD-1008", 1, "shipped", at(6), at(14), "edi"],
  [9, "ORD-1009", 3, "open", at(7), at(12), "web"],
  [10, "ORD-1010", 4, "cancelled", at(8), at(16), "web"],
  [11, "ORD-1011", 2, "open", at(9), at(13), "edi"],
  [12, "ORD-1012", 5, "open", at(10), at(30), "web"],
];

const LINES: unknown[][] = [
  // id, order, sku, qty, unit_price_cents, discount_cents, status
  [1, 1, "SKU-100", 2, 24900, 0, "open"],
  [2, 1, "SKU-102", 4, 4500, 0, "open"],
  [3, 2, "SKU-101", 3, 49900, 5000, "open"],
  [4, 3, "SKU-100", 1, 24900, 0, "shipped"],
  [5, 3, "SKU-103", 2, 8900, 0, "open"],
  [6, 3, "SKU-104", 10, 1900, 0, "open"],
  [7, 4, "SKU-102", 6, 4500, 0, "shipped"],
  [8, 5, "SKU-101", 4, 49900, 0, "cancelled"],
  [9, 5, "SKU-104", 5, 1900, 0, "open"],
  [10, 6, "SKU-103", 1, 8900, 0, "open"],
  [11, 7, "SKU-102", 2, 4500, 0, "open"],
  [12, 8, "SKU-100", 1, 24900, 2000, "shipped"],
  [13, 8, "SKU-104", 4, 1900, 0, "shipped"],
  [14, 9, "SKU-101", 2, 49900, 0, "cancelled"],
  [15, 9, "SKU-102", 3, 4500, 0, "open"],
  [16, 10, "SKU-100", 1, 24900, 0, "cancelled"],
  [17, 11, "SKU-105", 2, 3200, 0, "open"],
  [18, 11, "SKU-104", 8, 1900, 0, "open"],
  [19, 12, "SKU-102", 1, 4500, 0, "open"],
];

const SHIPMENTS: unknown[][] = [
  [1, 3, 4, "ldn", at(5), "Parcelforce", "PF-88213"],
  [2, 4, 7, "nyc", at(6), "UPS", "1Z-4421"],
  [3, 8, 12, "ldn", at(8), "Parcelforce", "PF-88999"],
  [4, 8, 13, "ldn", at(8), "Parcelforce", "PF-89000"],
];

const RETURNS: unknown[][] = [
  [1, 7, 2, "damaged in transit", at(12)],
  [2, 12, 1, "wrong item", at(14)],
];

const AS_OF = {
  as_of: { type: "string", required: true, description: "Instant to measure against, ISO-8601." },
};

/**
 * Order value and shipment progress, computed once.
 *
 * ⚠ **`FILTER (WHERE l.status <> 'cancelled')` on the value, and `COUNT` of
 * shipped lines against `COUNT` of live lines for the progress.** Both traps are
 * resolved here, in the catalogue, for the reason the IT Operations domain
 * states — a trap resolved in the catalogue is structurally unreachable.
 */
const SCORED = `
lines_scored AS (
  SELECT o.id, o.order_code, o.status, o.placed_at, o.promised_at, o.channel,
         c.name AS customer_name, c.email AS customer_email, c.segment, c.credit_limit,
         COUNT(l.id) FILTER (WHERE l.status <> 'cancelled')                       AS live_lines,
         COUNT(l.id) FILTER (WHERE l.status = 'cancelled')                        AS cancelled_lines,
         COUNT(s.id)                                                              AS shipped_lines,
         COALESCE(SUM((l.qty * l.unit_price_cents) - l.line_discount_cents)
                  FILTER (WHERE l.status <> 'cancelled'), 0)                      AS order_value_cents,
         COALESCE(SUM((l.qty * l.unit_price_cents) - l.line_discount_cents), 0)   AS naive_value_cents,
         GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - o.placed_at)) / 86400)::int AS age_days,
         CASE WHEN o.promised_at IS NULL THEN NULL
              ELSE (EXTRACT(EPOCH FROM ($1::timestamptz - o.promised_at)) / 86400)::int END AS days_past_promise
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_lines l ON l.order_id = o.id
    LEFT JOIN shipments s ON s.order_line_id = l.id
   GROUP BY o.id, o.order_code, o.status, o.placed_at, o.promised_at, o.channel,
            c.name, c.email, c.segment, c.credit_limit
)`;

export const ORDERS_DOMAIN: DomainSpec = {
  key: "orders",
  workspaceName: "Orders & Fulfilment",
  dbName: "orders_demo",
  roRole: "orders_ro",
  secretEnv: "ORDERS_DB_URL",
  description:
    "Order fulfilment: what has shipped, what has only partly shipped, what is late, and what " +
    "an order is actually worth once the cancelled lines come out of the total.",
  opsServices: ["mail", "chat", "ticketing", "llm"],
  ddl: DDL,
  tables: [
    { table: "org_settings", columns: ["id", "default_ship_days", "low_stock_threshold", "backorder_alert_days"], rows: [[1, 5, 5, 3]] },
    { table: "warehouses", columns: ["code", "name", "region", "contact_email"], rows: WAREHOUSES },
    { table: "customers", columns: ["id", "name", "email", "segment", "credit_limit"], rows: CUSTOMERS },
    { table: "products", columns: ["sku", "name", "category", "unit_price_cents", "discontinued"], rows: PRODUCTS },
    { table: "inventory", columns: ["sku", "warehouse_code", "on_hand", "reserved"], rows: INVENTORY },
    { table: "orders", columns: ["id", "order_code", "customer_id", "status", "placed_at", "promised_at", "channel"], rows: ORDERS },
    { table: "order_lines", columns: ["id", "order_id", "sku", "qty", "unit_price_cents", "line_discount_cents", "status"], rows: LINES },
    { table: "shipments", columns: ["id", "order_id", "order_line_id", "warehouse_code", "shipped_at", "carrier", "tracking"], rows: SHIPMENTS },
    { table: "returns", columns: ["id", "order_line_id", "qty", "reason", "received_at"], rows: RETURNS },
  ],
  queries: [
    {
      name: "orders_past_promise",
      description:
        "Open orders whose promised date has passed and which are not fully shipped. An order " +
        "counts as fully shipped only when EVERY live line has a shipment — a partial shipment " +
        "is not a fulfilled order, and treating it as one removes exactly the orders somebody " +
        "needs to chase from the list of orders to chase.",
      sqlText: `WITH${SCORED}
SELECT order_code, customer_name, customer_email, segment, channel, age_days, days_past_promise,
       live_lines, shipped_lines, (live_lines - shipped_lines) AS lines_outstanding,
       (order_value_cents / 100.0)::float8 AS order_value
  FROM lines_scored
 WHERE status NOT IN ('cancelled')
   AND shipped_lines < live_lines
   AND promised_at IS NOT NULL AND promised_at < $1::timestamptz
 ORDER BY days_past_promise DESC, order_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "orders_partially_shipped",
      description:
        "Orders where SOME but not all live lines have shipped — the set that looks fulfilled to " +
        "anything checking whether a shipment exists, and is not. Disjoint from the " +
        "nothing-shipped case, so the two do not double-count.",
      sqlText: `WITH${SCORED}
SELECT order_code, customer_name, customer_email, segment, age_days,
       live_lines, shipped_lines, (live_lines - shipped_lines) AS lines_outstanding,
       (order_value_cents / 100.0)::float8 AS order_value
  FROM lines_scored
 WHERE status <> 'cancelled'
   AND shipped_lines > 0 AND shipped_lines < live_lines
 ORDER BY (live_lines - shipped_lines) DESC, order_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "order_value_check",
      description:
        "Every open order with its true value and the value a naive sum would report. " +
        "order_value EXCLUDES cancelled lines; naive_value includes them. Where the two differ, " +
        "somebody cancelled a line — and on this dataset the difference is large enough to " +
        "roughly double an order. Money is returned in MAJOR units; the underlying columns are " +
        "minor (cents).",
      sqlText: `WITH${SCORED}
SELECT order_code, customer_name, segment, cancelled_lines,
       (order_value_cents / 100.0)::float8 AS order_value,
       (naive_value_cents / 100.0)::float8 AS naive_value,
       ((naive_value_cents - order_value_cents) / 100.0)::float8 AS overstated_by
  FROM lines_scored
 WHERE status <> 'cancelled'
 ORDER BY (naive_value_cents - order_value_cents) DESC, order_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "stock_below_threshold",
      description:
        "SKUs whose AVAILABLE stock (on hand minus reserved) is at or below the org-wide low " +
        "stock threshold, per warehouse. Available, not on-hand: reserved units are already " +
        "promised to somebody, so counting them as stock is how an order gets accepted that " +
        "cannot be filled. Discontinued SKUs are flagged rather than hidden.",
      sqlText: `
SELECT i.sku, p.name AS product_name, p.category, p.discontinued,
       i.warehouse_code, w.name AS warehouse_name, w.contact_email AS warehouse_email,
       i.on_hand, i.reserved, (i.on_hand - i.reserved) AS available, o.low_stock_threshold
  FROM inventory i
  JOIN products p ON p.sku = i.sku
  JOIN warehouses w ON w.code = i.warehouse_code
  CROSS JOIN org_settings o
 WHERE o.id = 1 AND (i.on_hand - i.reserved) <= o.low_stock_threshold
 ORDER BY (i.on_hand - i.reserved), i.sku, i.warehouse_code`,
      paramOrder: [],
      paramsSchema: {},
    },
    {
      name: "orders_unreachable",
      description:
        "Open, late orders whose customer has no email address — the ones an automated update " +
        "cannot reach. Reporting them is what stops them being silently dropped by every flow " +
        "that mails customers.",
      sqlText: `WITH${SCORED}
SELECT order_code, customer_name, segment, age_days, days_past_promise,
       (order_value_cents / 100.0)::float8 AS order_value
  FROM lines_scored
 WHERE status <> 'cancelled' AND customer_email IS NULL
   AND shipped_lines < live_lines
 ORDER BY order_code`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
    {
      name: "fulfilment_summary",
      description:
        "One row per channel: open orders, how many fully shipped, how many partly shipped, how " +
        "many past their promised date, and the total true value outstanding. The read a digest " +
        "is built from.",
      sqlText: `WITH${SCORED}
SELECT channel,
       COUNT(*) FILTER (WHERE status <> 'cancelled')                                     AS orders,
       COUNT(*) FILTER (WHERE status <> 'cancelled' AND shipped_lines = live_lines)      AS fully_shipped,
       COUNT(*) FILTER (WHERE status <> 'cancelled' AND shipped_lines > 0
                              AND shipped_lines < live_lines)                            AS partly_shipped,
       COUNT(*) FILTER (WHERE status <> 'cancelled' AND promised_at < $1::timestamptz
                              AND shipped_lines < live_lines)                            AS past_promise,
       (COALESCE(SUM(order_value_cents) FILTER (WHERE status <> 'cancelled'
                     AND shipped_lines < live_lines), 0) / 100.0)::float8                AS outstanding_value
  FROM lines_scored
 GROUP BY channel
 ORDER BY channel`,
      paramOrder: ["as_of"],
      paramsSchema: AS_OF,
    },
  ],
};

export const ORDERS_DEFAULT_AS_OF = "2026-06-15T10:00:00Z";
