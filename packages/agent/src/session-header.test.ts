import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createCatalog } from '@frametell/models';
import { piRuntime } from './runtime/pi.js';

test('every model request names the session that sent it', async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => { seen.push(String(req.headers['x-frametell-session'])); res.writeHead(500).end('{"error":"test"}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-session-'));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const catalog = await createCatalog({ keys: [{ providerId: 'custom-test', apiKey: 'k' }], custom: [{ id: 'custom-test', name: 'Test', protocol: 'openai', baseUrl: url, models: [{ id: 'm' }], discover: false }] });
    const model = catalog.get('custom-test', 'm');
    assert.ok(model);
    const session = await piRuntime(catalog.models, model).open({ name: 'page-p03', system: 's', cwd, maxTurns: 1 });
    await session.send({ text: 'hi' });
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((s) => s === 'page-p03'), `got ${seen.join(',')}`);
  } finally { server.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a session\'s transcript is saved after every turn, so a process lost mid-exchange leaves it to carry on from', async () => {
  // the model asks for a write; its answer to the result never comes (the process is gone before it does)
  let requests = 0;
  const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const server = http.createServer((req, res) => {
    req.resume();
    if (++requests > 1) return;   // held: the second turn never ends
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunk({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'storyboard.json', content: '{}' }) } }] }, finish_reason: null }] }));
    res.write(chunk({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-session-'));
  const stop = new AbortController();
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const catalog = await createCatalog({ keys: [{ providerId: 'custom-test', apiKey: 'k' }], custom: [{ id: 'custom-test', name: 'Test', protocol: 'openai', baseUrl: url, models: [{ id: 'm' }], discover: false }] });
    const session = await piRuntime(catalog.models, catalog.get('custom-test', 'm')!).open({ name: 'planner', system: 's', cwd, maxTurns: 10, signal: stop.signal });
    const sent = session.send({ text: 'plan the film' });
    for (let i = 0; i < 200 && requests < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(requests, 2, 'the second turn began');
    // mid-exchange: the first turn (its call and the tool's result) is on disk already
    const saved = JSON.parse(fs.readFileSync(session.ref!, 'utf8')) as { role: string }[];
    assert.deepEqual(saved.map((m) => m.role).filter((r) => r !== 'system'), ['user', 'assistant', 'toolResult']);
    assert.ok(fs.existsSync(path.join(cwd, 'storyboard.json')));
    stop.abort();
    await sent;
  } finally { server.closeAllConnections(); server.close(); fs.rmSync(cwd, { recursive: true, force: true }); }
});
