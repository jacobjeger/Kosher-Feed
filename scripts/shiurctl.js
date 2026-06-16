#!/usr/bin/env node
/*
 * shiurctl — pull ShiurPod telemetry from the terminal and (after a human OKs
 * a fix) mark issues fixed. Zero deps; talks to /api/v1 with a Bearer token.
 *
 * Modeled on the MegaLife crashctl — same flag parser, same --table output.
 * One-app deployment, so no `apps` command. Adds a `metrics` command for the
 * perf telemetry stream and a `tail -f`-style watcher.
 *
 * Config via env:
 *   SHIURPOD_API_BASE   Base URL, e.g. https://shiurpod.com
 *   PORTAL_API_KEY      Bearer token (server must have the same value).
 *
 * Commands:
 *   shiurctl issues   [--status active|resolved|regressed|archived|all]
 *                     [--severity fatal|nonfatal|warn] [--platform ios|android]
 *                     [--q text] [--version v]
 *                     [--since 2026-06-01] [--until ...] [--limit n] [--table]
 *   shiurctl issue    <fingerprint> [--events n]
 *   shiurctl resolve  <fingerprint> --version <v> [--note "..."]
 *   shiurctl reopen   <fingerprint>
 *   shiurctl archive  <fingerprint>
 *   shiurctl merge    <from-fp> --into <to-fp>
 *   shiurctl stats
 *   shiurctl metrics  --kind <k> [--window 7d|24h|1h]
 *                     [--bucket version|cdn|network|platform|episode|feed]
 *                     [--version v] [--platform ios|android] [--table]
 *   shiurctl kinds                                            # list metric kinds
 *
 * Output is JSON by default; add --table for compact text tables.
 */
'use strict';

const BASE = (process.env.SHIURPOD_API_BASE || 'https://shiurpod.com').replace(/\/+$/, '');
const KEY = process.env.PORTAL_API_KEY || '';

function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }
if (!KEY) die('Set PORTAL_API_KEY to the portal API token. (SHIURPOD_API_BASE defaults to https://shiurpod.com)');

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { opt[k] = argv[++i]; }
      else { opt[k] = true; }
    } else pos.push(a);
  }
  return { pos, opt };
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  if (!res.ok) die(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function pad(s, n) { s = String(s == null ? '' : s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

function fmtAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h';
  return Math.round(h / 24) + 'd';
}

function fmtMs(v) {
  if (v == null) return '-';
  const n = Number(v);
  if (n >= 1000) return (n / 1000).toFixed(2) + 's';
  return Math.round(n) + 'ms';
}

async function main() {
  const { pos, opt } = parse(process.argv.slice(2));
  const cmd = pos[0];

  if (cmd === 'issues') {
    const q = new URLSearchParams();
    for (const k of ['status', 'severity', 'version', 'platform', 'q', 'since', 'until', 'limit', 'sort']) {
      if (opt[k] && opt[k] !== true) q.set(k, opt[k]);
    }
    const { data } = await api('GET', '/api/v1/issues' + (q.toString() ? '?' + q : ''));
    if (opt.table) {
      console.log(pad('FINGERPRINT', 18) + pad('N', 7) + pad('USERS', 7) + pad('SEV', 9) + pad('STATUS', 11) + pad('VERSION', 12) + pad('LAST', 7) + 'TITLE');
      console.log('-'.repeat(120));
      for (const r of data) {
        const ver = (r.appVersions && r.appVersions[r.appVersions.length - 1]) || '-';
        console.log(
          pad(r.fingerprint, 18) +
          pad(r.count, 7) +
          pad(r.uniqueDeviceCount, 7) +
          pad(r.severity, 9) +
          pad(r.status, 11) +
          pad(ver, 12) +
          pad(fmtAgo(r.lastSeen), 7) +
          (r.title || '').substring(0, 60)
        );
      }
      console.log(`\n${data.length} issue(s)`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (cmd === 'issue') {
    const fp = pos[1] || die('usage: shiurctl issue <fingerprint> [--events n]');
    const q = opt.events ? `?events=${encodeURIComponent(opt.events)}` : '';
    const { data } = await api('GET', `/api/v1/issues/${encodeURIComponent(fp)}${q}`);
    if (opt.table) {
      const i = data.issue;
      console.log(`\n  ${i.fingerprint}  [${i.severity}]  status=${i.status}`);
      console.log(`  ${i.title}`);
      console.log(`  ${i.count} events / ${i.uniqueDeviceCount} devices · first ${fmtAgo(i.firstSeen)} ago · last ${fmtAgo(i.lastSeen)} ago`);
      console.log(`  platforms: ${(i.platforms || []).join(', ') || '-'}`);
      console.log(`  versions:  ${(i.appVersions || []).join(', ') || '-'}`);
      if (i.resolvedAtVersion) console.log(`  resolved on v${i.resolvedAtVersion}${i.resolvedNote ? ' — ' + i.resolvedNote : ''}`);
      if (i.topStackFrame) console.log(`  frame: ${i.topStackFrame}`);
      console.log('\n  recent events:');
      for (const ev of (data.events || []).slice(0, 10)) {
        console.log(`    ${fmtAgo(ev.createdAt)} ago  ${ev.platform || '?'}  v${ev.appVersion || '?'}  ${(ev.message || '').substring(0, 80)}`);
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (cmd === 'resolve') {
    const fp = pos[1];
    if (!fp) die('usage: shiurctl resolve <fingerprint> --version <v> [--note "..."]');
    if (!opt.version || opt.version === true) die('--version <v> is required (so auto-reopen can detect regressions on a newer build)');
    const { data } = await api('POST', `/api/v1/issues/${encodeURIComponent(fp)}/resolve`, {
      version: String(opt.version),
      note: opt.note && opt.note !== true ? String(opt.note) : null,
      by: process.env.USER || 'shiurctl',
    });
    console.log(`Resolved ${fp} on v${opt.version}${opt.note ? ' — ' + opt.note : ''}`);
    if (!opt.table) console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'reopen') {
    const fp = pos[1] || die('usage: shiurctl reopen <fingerprint>');
    const { data } = await api('POST', `/api/v1/issues/${encodeURIComponent(fp)}/reopen`);
    console.log(`Reopened ${fp}`);
    if (!opt.table) console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'archive') {
    const fp = pos[1] || die('usage: shiurctl archive <fingerprint>');
    const { data } = await api('POST', `/api/v1/issues/${encodeURIComponent(fp)}/archive`);
    console.log(`Archived ${fp}`);
    if (!opt.table) console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'merge') {
    const fp = pos[1];
    if (!fp) die('usage: shiurctl merge <from-fp> --into <to-fp>');
    if (!opt.into || opt.into === true) die('--into <to-fp> is required');
    const { data } = await api('POST', `/api/v1/issues/${encodeURIComponent(fp)}/merge`, { into: String(opt.into) });
    console.log(`Merged ${fp} into ${opt.into} (${data.merged} events moved)`);
    return;
  }

  if (cmd === 'stats') {
    const { data } = await api('GET', '/api/v1/stats');
    if (opt.table) {
      console.log(`\n  Errors  last hour: ${data.lastHour}   last 24h: ${data.last24h}   last 7d: ${data.last7d}`);
      console.log(`  Fatal issues: ${data.fatal24h}   Active: ${data.activeIssues}   Regressed: ${data.regressedIssues}   Devices 24h: ${data.uniqueDevices24h}\n`);
      console.log(`  By version (7d):`);
      for (const r of data.byVersion) console.log(`    ${pad(r.appVersion, 14)} ${r.count}`);
      console.log(`\n  By platform (7d):`);
      for (const r of data.byPlatform) console.log(`    ${pad(r.platform, 14)} ${r.count}`);
      console.log(`\n  By source (7d):`);
      for (const r of data.bySource) console.log(`    ${pad(r.source, 20)} ${r.count}`);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (cmd === 'metrics') {
    if (!opt.kind || opt.kind === true) die('usage: shiurctl metrics --kind <k> [--window 7d] [--bucket version|cdn|network|platform|episode|feed] [--version v] [--platform p] [--table]');
    const q = new URLSearchParams({ kind: String(opt.kind) });
    for (const k of ['window', 'bucket', 'version', 'platform', 'limit']) {
      if (opt[k] && opt[k] !== true) q.set(k, opt[k]);
    }
    const { data } = await api('GET', '/api/v1/metrics/summary?' + q);
    if (opt.table) {
      console.log(`\n  ${opt.kind}  window=${opt.window || '7d'}${opt.bucket ? '  bucket=' + opt.bucket : ''}`);
      console.log(`  overall: n=${data.overall.count}  p50=${fmtMs(data.overall.p50)}  p95=${fmtMs(data.overall.p95)}  p99=${fmtMs(data.overall.p99)}  avg=${fmtMs(data.overall.avg)}`);
      if (data.buckets.length > 0) {
        console.log('');
        console.log(pad('BUCKET', 30) + pad('N', 8) + pad('P50', 10) + pad('P95', 10) + pad('P99', 10) + pad('AVG', 10));
        console.log('-'.repeat(80));
        for (const r of data.buckets) {
          console.log(pad(r.bucket, 30) + pad(r.count, 8) + pad(fmtMs(r.p50), 10) + pad(fmtMs(r.p95), 10) + pad(fmtMs(r.p99), 10) + pad(fmtMs(r.avg), 10));
        }
      }
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  if (cmd === 'kinds') {
    const { data } = await api('GET', '/api/v1/metrics/kinds');
    if (opt.table) {
      console.log(pad('KIND', 30) + 'COUNT (7d)');
      console.log('-'.repeat(50));
      for (const r of data) console.log(pad(r.kind, 30) + r.count);
    } else {
      console.log(JSON.stringify(data, null, 2));
    }
    return;
  }

  die([
    'Commands:',
    '  issues   [--status active|resolved|regressed|archived|all] [--severity ...] [--q ...] [--version ...] [--platform ...] [--limit n] [--table]',
    '  issue    <fingerprint> [--events n] [--table]',
    '  resolve  <fingerprint> --version <v> [--note "..."]',
    '  reopen   <fingerprint>',
    '  archive  <fingerprint>',
    '  merge    <from-fp> --into <to-fp>',
    '  stats    [--table]',
    '  metrics  --kind <k> [--window 7d|24h|1h] [--bucket version|cdn|network|platform|episode|feed] [--version v] [--platform p] [--table]',
    '  kinds    [--table]',
  ].join('\n'));
}

main().catch((e) => die(String(e && e.stack || e)));
