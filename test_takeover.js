'use strict';
// node test_takeover.js — a release unpacked beside the old bridge finds it and brings its board along.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const takeover = require('./takeover');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
const oldDir = path.join(root, 'Agent-Bridge-v2.3.1', 'agent-bridge');
const newDir = path.join(root, 'Agent-Bridge-v2.8.2', 'agent-bridge');
const elsewhere = path.join(root, 'gone');
for (const d of [oldDir, newDir]) fs.mkdirSync(d, { recursive: true });

// The old bridge: code, a board with two messages, a long body, a document, settings.
fs.writeFileSync(path.join(oldDir, 'agent-bridge-mcp.js'), '// old');
fs.writeFileSync(path.join(oldDir, 'VERSION'), '2.3.1\n');
fs.mkdirSync(path.join(oldDir, 'agent_bridge_bodies'));
fs.mkdirSync(path.join(oldDir, 'docs', 'attachments'), { recursive: true });
const body = path.join(oldDir, 'agent_bridge_bodies', 'msg_0002.md');
const doc = path.join(oldDir, 'docs', 'contract.md');
fs.writeFileSync(body, 'the long text');
fs.writeFileSync(doc, 'the contract');
fs.writeFileSync(path.join(oldDir, 'docs', 'attachments', 'att_1_log.txt'), 'log');
fs.writeFileSync(path.join(oldDir, 'bridge_config.json'), JSON.stringify({ adminName: 'Owner', uiPort: 8787,
  contractsDir: path.join(oldDir, 'contracts'), sandboxDir: 'D:/somewhere/else' }));
{
  const db = new DatabaseSync(path.join(oldDir, 'agent_bridge.db'));
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, message TEXT, file TEXT); CREATE TABLE docs_index (name TEXT PRIMARY KEY, file TEXT);');
  db.prepare('INSERT INTO messages (message, file) VALUES (?, ?)').run('hello', null);
  db.prepare('INSERT INTO messages (message, file) VALUES (?, ?)').run('[Attached: log — ' + path.join(oldDir, 'docs', 'attachments', 'att_1_log.txt') + ']', body);
  db.prepare('INSERT INTO docs_index (name, file) VALUES (?, ?)').run('contract.md', doc.replace(/\\/g, '/'));
  db.close();
}
fs.writeFileSync(path.join(newDir, 'agent-bridge-mcp.js'), '// new');

const cfgOf = dir => { const f = path.join(root, 'cfg-' + path.basename(path.dirname(dir)) + '.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { 'agent-bridge': { command: 'node', args: [path.join(dir, 'agent-bridge-mcp.js')] } } })); return f; };

// Finding the bridge the clients use.
assert.strictEqual(takeover.findOther(newDir, [cfgOf(newDir)]), null, 'the clients already point here');
assert.strictEqual(takeover.findOther(newDir, [cfgOf(elsewhere)]), null, 'a folder that no longer exists is nobody');
assert.strictEqual(takeover.findOther(newDir, [path.join(root, 'no-such.json')]), null, 'no client config');
const found = takeover.findOther(newDir, [path.join(root, 'no-such.json'), cfgOf(oldDir)]);
assert.ok(found && path.resolve(found.dir) === path.resolve(oldDir), 'the old folder is found');
assert.strictEqual(found.version, '2.3.1');

// Whether a folder has a board worth keeping.
assert.strictEqual(takeover.hasBoard(newDir), false, 'a fresh folder has none');
assert.strictEqual(takeover.hasBoard(oldDir), true);

// Moving it.
const before = fs.readFileSync(path.join(oldDir, 'bridge_config.json'), 'utf8');
const r = takeover.take(oldDir, newDir);
assert.strictEqual(r.messages, 2, 'both messages came');
assert.ok(r.files >= 4, 'settings, body, document, attachment');
assert.strictEqual(takeover.hasBoard(newDir), true);
assert.ok(fs.existsSync(path.join(newDir, 'agent_bridge_bodies', 'msg_0002.md')) && fs.existsSync(path.join(newDir, 'docs', 'contract.md')));
{
  const db = new DatabaseSync(path.join(newDir, 'agent_bridge.db'), { readOnly: true });
  const m = db.prepare('SELECT message, file FROM messages WHERE id = 2').get();
  const d = db.prepare('SELECT file FROM docs_index').get();
  db.close();
  assert.strictEqual(path.resolve(m.file), path.resolve(newDir, 'agent_bridge_bodies', 'msg_0002.md'), 'the body is read from the new folder');
  assert.ok(m.message.includes(path.join(newDir, 'docs', 'attachments')) && !m.message.includes('v2.3.1'), 'so is the attachment the text names');
  assert.ok(d.file.includes('v2.8.2') && !d.file.includes('v2.3.1'), 'and the document, written with forward slashes');
}
const cfg = JSON.parse(fs.readFileSync(path.join(newDir, 'bridge_config.json'), 'utf8'));
assert.strictEqual(cfg.adminName, 'Owner', 'the settings came');
assert.strictEqual(path.resolve(cfg.contractsDir), path.resolve(newDir, 'contracts'), 'a folder inside the bridge follows it');
assert.strictEqual(cfg.sandboxDir, 'D:/somewhere/else', 'a folder kept elsewhere stays where it is');
assert.strictEqual(path.resolve(cfg.movedFrom), path.resolve(oldDir));

// The old folder is untouched.
assert.strictEqual(fs.readFileSync(path.join(oldDir, 'bridge_config.json'), 'utf8'), before);
assert.ok(fs.existsSync(body) && fs.existsSync(path.join(oldDir, 'agent_bridge.db')));
{
  const db = new DatabaseSync(path.join(oldDir, 'agent_bridge.db'), { readOnly: true });
  assert.ok(db.prepare('SELECT file FROM messages WHERE id = 2').get().file.includes('v2.3.1'), 'its board still names its own files');
  db.close();
}

fs.rmSync(root, { recursive: true, force: true });
console.log('takeover: all checks passed');
