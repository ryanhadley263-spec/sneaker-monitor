// `npm run demo`: same server, simulated drops, no network needed.
process.env.DEMO = '1';
process.env.DATA_FILE ||= 'data/demo-state.json';
await import('./server.js');
