// Generates the sample database the Database block harness opens: node make-sample.mjs <out.db>
import { rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

export function makeSample(file) {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      city TEXT DEFAULT 'Unknown',
      balance REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      created TEXT
    );
    CREATE TABLE products (
      sku TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      price REAL,
      stock INTEGER,
      photo BLOB
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      placed TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('new','paid','shipped','refunded')),
      total REAL
    );
    CREATE TABLE order_items (
      order_id INTEGER NOT NULL REFERENCES orders(id),
      sku TEXT NOT NULL REFERENCES products(sku),
      qty INTEGER NOT NULL,
      PRIMARY KEY (order_id, sku)
    ) WITHOUT ROWID;
    CREATE TABLE "odd ""table"" name" ("select" TEXT, "a""b" INTEGER);
    CREATE INDEX orders_by_customer ON orders(customer_id, placed);
    CREATE UNIQUE INDEX customers_city_name ON customers(city, name) WHERE active = 1;
    CREATE VIEW top_customers AS
      SELECT c.id, c.name, count(o.id) AS orders, round(sum(o.total), 2) AS spent
      FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY spent DESC;
    CREATE TRIGGER orders_total_default AFTER INSERT ON orders WHEN NEW.total IS NULL
    BEGIN
      UPDATE orders SET total = 0 WHERE id = NEW.id;
    END;
  `)
  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth', 'Margaret Hamilton', 'Linus Torvalds', 'Radia Perlman', 'Ken Thompson', 'Frances Allen', 'Dennis Ritchie', 'Hedy Lamarr', 'John Backus', 'Annie Easley', 'Leslie Lamport']
  const cities = ['London', 'New York', 'Cambridge', 'Rotterdam', 'Boston', 'Palo Alto', 'Helsinki', null]
  const cust = db.prepare('INSERT INTO customers (name, email, city, balance, active, notes, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
  names.forEach((n, i) => cust.run(n, n.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com', cities[i % cities.length], Math.round((i * 137.31 + 12.5) * 100) / 100, i % 5 === 4 ? 0 : 1,
    i % 4 === 0 ? 'Prefers email.\nAsked for a quote in March; follow up before the end of the quarter, with the extended support option included.' : i === 3 ? '' : null, `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(3 + i).padStart(2, '0')}`))
  const prod = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?)')
  const titles = ['Mechanical keyboard', 'USB-C dock', 'Monitor arm', 'Desk mat', 'Webcam', 'Noise-cancelling headphones', 'Laptop stand', 'Cable kit', 'Standing desk', 'Task lamp', 'Ergonomic mouse', 'Whiteboard']
  titles.forEach((t, i) => prod.run(`SKU-${1000 + i}`, t, Math.round((19 + i * 17.3) * 100) / 100, i % 4 === 3 ? null : 5 + i * 3, i === 0 ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 255, 254, 253, 1, 2, 3, 4, 5, 6, 7, 8, 9]) : null))
  const ord = db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?)')
  const item = db.prepare('INSERT INTO order_items VALUES (?, ?, ?)')
  const statuses = ['new', 'paid', 'shipped', 'shipped', 'refunded']
  for (let i = 1; i <= 240; i++) {
    ord.run(i, 1 + (i * 7) % names.length, `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')} ${String(8 + (i % 10)).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`, statuses[i % statuses.length], Math.round((20 + ((i * 37) % 400) + (i % 100) / 100) * 100) / 100)
    item.run(i, `SKU-${1000 + (i % titles.length)}`, 1 + (i % 4))
  }
  db.exec(`INSERT INTO "odd ""table"" name" VALUES ('x; DROP TABLE customers;--', 1)`)
  db.close()
  return file
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node make-sample.mjs <out.db>')
  console.log(makeSample(process.argv[2]))
}
