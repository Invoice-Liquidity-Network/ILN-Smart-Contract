#!/usr/bin/env node
// reviews fuzz snapshots under contracts/fuzz/test_snapshots/tests
// flags snapshots that contain likely panic or unexpected error indicators
const fs = require('fs');
const path = require('path');

const SNAP_DIR = path.join(__dirname, '..', 'contracts', 'fuzz', 'test_snapshots', 'tests');

function walk(obj, cb) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') {
    cb(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) walk(v, cb);
    return;
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) walk(obj[k], cb);
    return;
  }
}

function inspectFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim().length === 0) return {file, ok:false, reason:'empty'};
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { return {file, ok:false, reason:'invalid-json'}; }
    const issues = new Set();
    walk(json, (v)=>{
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        if (s.includes('panic') || s.includes('forced panic') || s.includes('unhandled') || s.includes('revert') || s.includes('error')) issues.add('suspicious-string');
      }
    });
    // Heuristic: look for empty generators or missing keys
    if (!json.generators) issues.add('missing-generators');
    // If any invocation includes `function_name` set to "set_should_panic", mark
    if (raw.includes('set_should_panic')) issues.add('set_should_panic-caller');
    return {file, ok: issues.size===0, reasons: Array.from(issues)};
  } catch (e) {
    return {file, ok:false, reason: String(e)};
  }
}

function main() {
  if (!fs.existsSync(SNAP_DIR)) {
    console.error('snapshot dir not found:', SNAP_DIR);
    process.exit(2);
  }
  const files = fs.readdirSync(SNAP_DIR).filter(f=>f.endsWith('.json'));
  const results = {total: files.length, flagged: []};
  for (const f of files) {
    const res = inspectFile(path.join(SNAP_DIR, f));
    if (!res.ok) results.flagged.push(res);
  }
  console.log('Total snapshots:', results.total);
  console.log('Flagged snapshots:', results.flagged.length);
  if (results.flagged.length>0) {
    console.log('Examples:');
    for (const r of results.flagged.slice(0,20)) {
      console.log('-', path.basename(r.file), r.reasons || r.reason);
    }
    console.log('\nRun `node scripts/review-fuzz-snapshots.js` locally to inspect all flagged files.');
    process.exit(1);
  } else {
    console.log('All snapshots look syntactically valid and contain no obvious panic/error indicators.');
    process.exit(0);
  }
}

main();
