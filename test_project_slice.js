'use strict';
// node test_project_slice.js — the board finds a project's slice by its folder,
// its line or any window on it, and says when the folder has no git.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { find, folderOf } = require('./project-slice');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
const withSlice = path.join(root, 'WithSlice'), bare = path.join(root, 'bare');
fs.mkdirSync(path.join(withSlice, '.agents'), { recursive: true });
fs.mkdirSync(path.join(withSlice, '.git'));
fs.mkdirSync(bare);
fs.writeFileSync(path.join(withSlice, '.agents', 'HANDOFF.md'), '# Slice\nnext: step 2\n');

const key = f => f.replace(/\\/g, '/').toLowerCase();
const db = { lineOf: m => ({ 'local_win-1': key(withSlice), 'local_win-2': key(bare), 'local_win-3': 'radio' })[m] || '' };

let s = find(db, withSlice);
assert.ok(s.text.includes('next: step 2') && s.git && s.mtime > 0, 'by folder');
assert.ok(find(db, key(withSlice)).text, 'by line of work');
assert.ok(find(db, 'local_win-1').text, 'by a window of the project');

s = find(db, 'local_win-2');
assert.deepStrictEqual([s.folder, s.text, s.git], [key(bare), '', false], 'a project with no slice and no git');
assert.ok(s.file.endsWith(path.join('.agents', 'HANDOFF.md')), 'still says where the slice belongs');

assert.strictEqual(folderOf(db, 'local_win-3'), '', 'a line named by hand leads to no folder');
assert.strictEqual(find(db, 'local_unknown').folder, '', 'an unknown window');
assert.strictEqual(find(db, path.join(root, 'gone')).folder, '', 'a folder that does not exist');
assert.strictEqual(find(db, '').folder, '');

fs.rmSync(root, { recursive: true, force: true });
console.log('project-slice: 9/9');
