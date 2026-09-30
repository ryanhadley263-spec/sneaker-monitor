import { chromium } from 'playwright';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters.js';

const DB = process.env.DATA_FILE || 'data/state.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export class Hub extends EventEmitter {
  constructor() {
    super();
    this.monitors = new Map(); // id -> config + runtime info
    this.events = [];          // newest first
    this.settings = { webhook: '' };
    this.timers = new Map();
    this.browser = null;
    this.busy = new Set();
    this.load();
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(DB, 'utf8'));
      this.settings = s.settings || this.settings;
      this.events = s.events || [];
      for (const m of s.monitors || []) this.monitors.set(m.id, { ...m, running: false, lastError: null });
    } catch {}
    for (const m of [...this.monitors.values()]) if (m.autostart) this.start(m.id);
  }

  save() {
    fs.mkdirSync(path.dirname(DB), { recursive: true });
    const monitors = [...this.monitors.values()].map(({ running, lastError, ...m }) => ({ ...m, autostart: running }));
    fs.writeFileSync(DB, JSON.stringify({ settings: this.settings, events: this.events.slice(0, 500), monitors }, null, 1));
  }

  snapshot() {
    return { monitors: [...this.monitors.values()], events: this.events.slice(0, 200), settings: this.settings };
  }

  push() { this.emit('update', this.snapshot()); }

  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  add({ site, target, label, intervalSec = 60, keywords = '', proxy = '' }) {
    if (!adapters[site]) throw new Error('unknown site');
    new URL(target);
    const id = Math.random().toString(36).slice(2, 9);
    const m = {
      id, site, target, label: label || `${site} monitor`, intervalSec: Math.max(site === 'demo' ? 3 : 15, +intervalSec || 60),
      keywords, proxy, running: false, lastRun: null, lastError: null, runs: 0, products: {},
    };
    this.monitors.set(id, m);
    this.save(); this.push();
    return m;
  }

  remove(id) {
    this.stop(id);
    this.monitors.delete(id);
    this.save(); this.push();
  }

  start(id) {
    const m = this.monitors.get(id);
    if (!m || this.timers.has(id)) return;
    m.running = true;
    const tick = async () => {
      await this.runOnce(id);
      if (this.timers.has(id)) {
        const jitter = m.intervalSec * 1000 * (0.9 + Math.random() * 0.2);
        this.timers.set(id, setTimeout(tick, jitter));
      }
    };
    this.timers.set(id, setTimeout(tick, 0));
    this.save(); this.push();
  }

  stop(id) {
    const m = this.monitors.get(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (m) m.running = false;
    this.save(); this.push();
  }

  async runOnce(id) {
    const m = this.monitors.get(id);
    if (!m || this.busy.has(id)) return;
    this.busy.add(id);
    let ctx;
    try {
      let products;
      if (m.site === 'demo') {
        // simulated feed: no browser needed
        products = await adapters.demo.scrape(null, m);
      } else {
        const browser = await this.getBrowser();
        ctx = await browser.newContext({
          userAgent: UA, viewport: { width: 1366, height: 900 }, locale: 'en-US',
          ...(m.proxy ? { proxy: { server: m.proxy } } : {}),
        });
        // skip heavy assets; only the DOM/JSON is needed
        await ctx.route('**/*', (r) =>
          ['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue());
        const page = await ctx.newPage();
        products = await adapters[m.site].scrape(page, m);
      }

      const kws = m.keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (kws.length) products = products.filter((p) => kws.some((k) => (p.name || '').toLowerCase().includes(k)));

      this.diff(m, products);
      m.lastError = null;
    } catch (e) {
      m.lastError = String(e.message || e).split('\n')[0];
      this.log(m, 'error', m.lastError);
    } finally {
      await ctx?.close().catch(() => {});
      m.lastRun = Date.now();
      m.runs++;
      this.busy.delete(id);
      this.save(); this.push();
    }
  }

  diff(m, products) {
    const first = m.runs === 0;
    const prev = m.products;
    const next = {};
    for (const p of products) {
      next[p.id] = p;
      const old = prev[p.id];
      if (!old) {
        if (!first) this.log(m, 'new', `New: ${p.name}`, p);
        continue;
      }
      if (old.status !== 'in_stock' && p.status === 'in_stock') this.log(m, 'restock', `In stock: ${p.name}`, p);
      else if (old.status === 'in_stock' && p.status === 'sold_out') this.log(m, 'sold_out', `Sold out: ${p.name}`, p);
      if (old.price != null && p.price != null && old.price !== p.price)
        this.log(m, 'price', `${p.name}: $${old.price} -> $${p.price}`, p);
      const added = (p.sizes || []).filter((s) => !(old.sizes || []).includes(s));
      if (added.length && (old.sizes || []).length) this.log(m, 'sizes', `${p.name}: new sizes ${added.join(', ')}`, p);
    }
    m.products = next;
  }

  log(m, type, message, product) {
    const ev = { t: Date.now(), monitor: m.id, label: m.label, site: m.site, type, message, url: product?.url };
    this.events.unshift(ev);
    this.events.length = Math.min(this.events.length, 500);
    if (type !== 'error') this.notify(ev);
  }

  async notify(ev) {
    if (!this.settings.webhook) return false;
    try {
      const res = await fetch(this.settings.webhook, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `**[${ev.site.toUpperCase()}] ${ev.label}**: ${ev.message}${ev.url ? `\n${ev.url}` : ''}` }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async testWebhook() {
    const ok = await this.notify({ site: 'test', label: 'Sneaker Monitor', message: 'Webhook connected' });
    if (!ok) throw new Error('Webhook failed or not set');
  }

  // Seed a few simulated monitors so a fresh install has something to show.
  seedDemo() {
    if (this.monitors.size) return;
    const a = this.add({ site: 'demo', target: 'https://demo.local/snkrs', label: 'SNKRS Launch Feed (demo)', intervalSec: 6 });
    const b = this.add({ site: 'demo', target: 'https://demo.local/goat', label: 'GOAT Jordan 4 Watch (demo)', intervalSec: 6 });
    this.start(a.id);
    this.start(b.id);
  }

  async shutdown() {
    for (const t of this.timers.values()) clearTimeout(t);
    await this.browser?.close().catch(() => {});
  }
}
