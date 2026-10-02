import { analyze, formatDuration, probe } from './index.js';

const paint = (code, value, enabled) => enabled ? `\x1b[${code}m${value}\x1b[0m` : value;

export function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const options = { json: false, timeout: 10000 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--timeout') {
      if (!args[++i]) throw new Error('--timeout needs a value in milliseconds');
      options.timeout = Number(args[i]);
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else if (options.url) throw new Error('give one URL');
    else options.url = arg;
  }
  if (!options.url) throw new Error('give a URL; use --help for usage');
  return options;
}

export function render(report, color = process.stdout.isTTY && !process.env.NO_COLOR) {
  const rows = [];
  rows.push(paint('1', `cachewhy  ${report.url}`, color));
  rows.push(`${report.status} final response${report.redirects.length ? ` after ${report.redirects.length} redirect${report.redirects.length === 1 ? '' : 's'}` : ''}`);
  for (const item of report.redirects) rows.push(`  ${item.status} ${item.url} -> ${item.location} (browser: ${item.browser.fresh ? 'reusable' : 'new request needed'})`);
  rows.push('');
  if (report.redirects.length) rows.push('Final response policy');
  for (const [label, result] of [['Browser', report.browser], ['Shared cache', report.shared]]) {
    const state = result.fresh ? paint('32', 'REUSE', color) : result.mayServeStale ? paint('33', 'SERVE STALE', color) : result.uncertain ? paint('33', 'DEPENDS', color) : paint('33', result.storable ? 'REVALIDATE' : 'DO NOT STORE', color);
    const duration = result.fresh ? ` for up to ${formatDuration(result.remainingSeconds)}` : '';
    rows.push(`${label.padEnd(12)} ${state}${duration}`);
    rows.push(`              ${result.reason}`);
  }
  if (report.warning) rows.push('', paint('31', `404 warning: ${report.warning}`, color));
  rows.push('', 'Observed headers');
  for (const [name, value] of Object.entries(report.observedHeaders)) rows.push(`  ${name}: ${value}`);
  if (!Object.keys(report.observedHeaders).length) rows.push('  none of the cache headers checked were present');
  rows.push('', 'This probe cannot inspect an existing browser cache, service worker, or CDN configuration.');
  return rows.join('\n');
}

export async function run(args, write = console.log) {
  const options = parseArgs(args);
  if (options.help) {
    write('Usage: cachewhy URL [--timeout MS] [--json]\n\nSends one GET per redirect and stops reading each response after its headers.');
    return;
  }
  const report = analyze(await probe(options.url, { timeout: options.timeout }));
  write(options.json ? JSON.stringify(report, null, 2) : render(report));
}
