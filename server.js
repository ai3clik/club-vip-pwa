const express = require('express');
const { createClient } = require('@libsql/client');
const webpush = require('web-push');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS clientes (id TEXT PRIMARY KEY, puntos INTEGER DEFAULT 0)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, cliente_id TEXT, tipo TEXT, puntos INTEGER, fecha TEXT)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS suscripciones_pwa (cliente_id TEXT PRIMARY KEY, subscription_json TEXT)`);
}
initDb();

webpush.setVapidDetails(
  'mailto:soporte@tunegocio.com',
  process.env.VAPID_PUBLIC_KEY || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

app.get('/api/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', async (req, res) => {
  const { memberId, subscription } = req.body;
  await db.execute({
    sql: 'INSERT OR REPLACE INTO suscripciones_pwa (cliente_id, subscription_json) VALUES (?, ?)',
    args: [memberId, JSON.stringify(subscription)]
  });
  res.json({ success: true });
});

app.post('/api/admin/send-push', async (req, res) => {
  const { title, body } = req.body;
  const result = await db.execute('SELECT subscription_json FROM suscripciones_pwa');
  const payload = JSON.stringify({ title, body });
  const envios = result.rows.map(row => {
    const sub = JSON.parse(row.subscription_json);
    return webpush.sendNotification(sub, payload).catch(async err => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.execute({ sql: 'DELETE FROM suscripciones_pwa WHERE subscription_json = ?', args: [row.subscription_json] });
      }
    });
  });
  await Promise.all(envios);
  res.json({ success: true, enviados: result.rows.length });
});

app.post('/api/puntos', async (req, res) => {
  const { clienteId, puntos, tipo } = req.body;
  await db.execute({ sql: 'INSERT OR IGNORE INTO clientes (id, puntos) VALUES (?, 0)', args: [clienteId] });
  await db.execute({ sql: 'UPDATE clientes SET puntos = puntos + ? WHERE id = ?', args: [puntos, clienteId] });
  await db.execute({ 
    sql: 'INSERT INTO movimientos (cliente_id, tipo, puntos, fecha) VALUES (?, ?, ?, datetime("now", "localtime"))', 
    args: [clienteId, tipo, puntos] 
  });
  const cliente = await db.execute({ sql: 'SELECT puntos FROM clientes WHERE id = ?', args: [clienteId] });
  res.json({ success: true, puntos: cliente.rows[0].puntos });
});

app.get('/api/cliente/:id', async (req, res) => {
  const id = req.params.id;
  let cliente = await db.execute({ sql: 'SELECT * FROM clientes WHERE id = ?', args: [id] });
  if (cliente.rows.length === 0) {
    await db.execute({ sql: 'INSERT INTO clientes (id, puntos) VALUES (?, 10)', args: [id] });
    await db.execute({ sql: 'INSERT INTO movimientos (cliente_id, tipo, puntos, fecha) VALUES (?, "Registro bienvenida", 10, datetime("now", "localtime"))', args: [id] });
    cliente = await db.execute({ sql: 'SELECT * FROM clientes WHERE id = ?', args: [id] });
  }
  const movimientos = await db.execute({ sql: 'SELECT * FROM movimientos WHERE cliente_id = ? ORDER BY id DESC LIMIT 5', args: [id] });
  res.json({ cliente: cliente.rows[0], movimientos: movimientos.rows });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));