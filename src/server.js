import express from 'express';
import { Hub } from './monitor.js';

const hub = new Hub();
const app = express();
app.use(express.json());
app.use(express.static('public'));

const clients = new Set();
hub.on('update', (snap) => clients.forEach((res) => res.write(`data: ${JSON.stringify(snap)}\n\n`)));

app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(hub.snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const wrap = (fn) => (req, res) => {
  try { res.json(fn(req) ?? { ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
};
app.post('/api/monitors', wrap((r) => hub.add(r.body)));
app.post('/api/monitors/:id/start', wrap((r) => hub.start(r.params.id)));
app.post('/api/monitors/:id/stop', wrap((r) => hub.stop(r.params.id)));
app.post('/api/monitors/:id/run', wrap((r) => { hub.runOnce(r.params.id); }));
app.delete('/api/monitors/:id', wrap((r) => hub.remove(r.params.id)));
app.post('/api/settings', wrap((r) => {
  const hook = String(r.body.webhook || '').trim();
  if (hook && !/^https:\/\//.test(hook)) throw new Error('Webhook must be an https URL');
  hub.settings.webhook = hook; hub.save(); hub.push();
}));
app.post('/api/webhook/test', async (_req, res) => {
  try { await hub.testWebhook(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

if (process.env.DEMO === '1') hub.seedDemo();

const port = process.env.PORT || 3001;
const host = process.env.HOST || '127.0.0.1'; // Docker sets HOST=0.0.0.0
app.listen(port, host, () => console.log(`Control center: http://localhost:${port}${process.env.DEMO === '1' ? ' (demo mode)' : ''}`));
process.on('SIGINT', async () => { await hub.shutdown(); process.exit(0); });
