// Site adapters: each takes a Playwright page + monitor config and returns
// [{ id, name, url, price, status, sizes }]. Selectors are best-effort; sites
// change markup often, so tune these against the live pages.

const parsePrice = (s) => {
  const m = String(s ?? '').match(/[\d,]+(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
};

// Pull product info embedded as JSON-LD / __NEXT_DATA__ before falling back to the DOM.
async function embeddedJson(page) {
  return page.evaluate(() => {
    const out = { ld: [], next: null };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { out.ld.push(JSON.parse(s.textContent)); } catch {}
    });
    const n = document.getElementById('__NEXT_DATA__');
    if (n) { try { out.next = JSON.parse(n.textContent); } catch {} }
    return out;
  });
}

function fromLd(ld) {
  const items = ld.flatMap((x) => (Array.isArray(x) ? x : x['@graph'] || [x]));
  return items
    .filter((x) => x && (x['@type'] === 'Product' || x['@type']?.includes?.('Product')))
    .map((p) => {
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      const avail = String(offer?.availability || '');
      return {
        id: p.sku || p.url || p.name,
        name: p.name,
        url: p.url,
        price: parsePrice(offer?.price ?? offer?.lowPrice),
        status: /InStock/i.test(avail) ? 'in_stock' : /OutOfStock|SoldOut/i.test(avail) ? 'sold_out' : 'unknown',
        sizes: [],
      };
    });
}

// ---------- Nike SNKRS ----------
// target: a SNKRS feed/upcoming URL (https://www.nike.com/launch) or a product URL.
const snkrs = {
  async scrape(page, cfg) {
    await page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const cards = await page.evaluate(() => {
      const seen = new Set();
      return [...document.querySelectorAll('a[href*="/launch/t/"]')]
        .map((a) => {
          const href = a.href.split('?')[0];
          if (seen.has(href)) return null;
          seen.add(href);
          const card = a.closest('li, article, div') || a;
          const text = (card.innerText || '').trim();
          const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
          const priceLine = lines.find((l) => /\$\s?\d/.test(l));
          const buyable = /(^|\n)\s*(Buy|Add to Bag)/i.test(text);
          const sold = /sold out|out of stock/i.test(text);
          return { href, name: lines[0] || href.split('/').pop(), priceLine, buyable, sold };
        })
        .filter(Boolean);
    });
    const products = cards.map((c) => ({
      id: c.href,
      name: c.name,
      url: c.href,
      price: parsePrice(c.priceLine),
      status: c.sold ? 'sold_out' : c.buyable ? 'in_stock' : 'upcoming',
      sizes: [],
    }));
    if (products.length) return products;
    return fromLd((await embeddedJson(page)).ld);
  },
};

// ---------- GOAT ----------
// target: a GOAT product URL (size/price ladder) or a search URL (https://www.goat.com/search?query=...).
const goat = {
  async scrape(page, cfg) {
    await page.goto(cfg.target, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const isProduct = /\/sneakers\/[^/?]+/.test(new URL(cfg.target).pathname);
    const data = await embeddedJson(page);

    if (isProduct) {
      const ld = fromLd(data.ld)[0];
      const sizes = await page.evaluate(() =>
        [...document.querySelectorAll('[data-qa*="size"], button[class*="size" i]')]
          .map((b) => b.innerText.replace(/\s+/g, ' ').trim())
          .filter((t) => /\d/.test(t)));
      const name = ld?.name || (await page.title()).replace(/\s*\|.*$/, '');
      return [{
        id: cfg.target,
        name,
        url: cfg.target,
        price: ld?.price ?? null,
        status: ld?.status && ld.status !== 'unknown' ? ld.status : sizes.length ? 'in_stock' : 'unknown',
        sizes,
      }];
    }

    const cards = await page.evaluate(() => {
      const seen = new Set();
      return [...document.querySelectorAll('a[href*="/sneakers/"]')]
        .map((a) => {
          const href = a.href.split('?')[0];
          if (seen.has(href)) return null;
          seen.add(href);
          const lines = (a.innerText || '').split('\n').map((l) => l.trim()).filter(Boolean);
          return { href, name: lines[0], priceLine: lines.find((l) => /\$\s?\d/.test(l)) };
        })
        .filter(Boolean);
    });
    return cards.map((c) => ({
      id: c.href, name: c.name || c.href.split('/').pop(), url: c.href,
      price: parsePrice(c.priceLine), status: 'in_stock', sizes: [],
    }));
  },
};

// ---------- Demo ----------
// Simulated feed so the project runs with no network and no live-site dependency.
// Each monitor keeps its own catalog and randomly restocks, sells out, reprices, and drops sizes.
const CATALOG = [
  ['Air Jordan 4 Retro "Military Blue"', 215], ['Air Jordan 1 Low OG "Howard"', 140],
  ['Nike Dunk Low "Panda"', 115], ['Travis Scott x Air Jordan 1 Low', 150],
  ['Nike SB Dunk Low "Ben & Jerry\'s"', 120], ['Air Jordan 3 Retro "White Cement"', 210],
  ['Nike Air Max 1 "Patta"', 190], ['Air Jordan 11 Retro "Cool Grey"', 225],
];
const SIZES = ['7', '7.5', '8', '8.5', '9', '9.5', '10', '10.5', '11', '12'];
const demoState = new Map();
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const demo = {
  async scrape(_page, cfg) {
    let items = demoState.get(cfg.id);
    if (!items) {
      items = CATALOG.map(([name, price], i) => ({
        id: `demo-${cfg.id}-${i}`, name, url: `https://example.com/${i}`, price,
        status: pick(['in_stock', 'sold_out', 'upcoming']), sizes: [],
      }));
      items.forEach((p) => { p.sizes = p.status === 'in_stock' ? SIZES.filter(() => Math.random() > 0.5) : []; });
      demoState.set(cfg.id, items);
    }
    for (const p of items) {
      const r = Math.random();
      if (r < 0.10) {
        p.status = p.status === 'in_stock' ? 'sold_out' : 'in_stock';
        p.sizes = p.status === 'in_stock' ? SIZES.filter(() => Math.random() > 0.5) : [];
      } else if (r < 0.16) {
        p.price = Math.max(80, p.price + pick([-20, -10, 10, 20]));
      } else if (r < 0.22 && p.status === 'in_stock') {
        const missing = SIZES.filter((s) => !p.sizes.includes(s));
        if (missing.length) p.sizes = [...p.sizes, pick(missing)];
      }
    }
    return items.map((p) => ({ ...p, sizes: [...p.sizes] }));
  },
};

export const adapters = { snkrs, goat, demo };
