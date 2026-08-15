/* Exercise the ZIP reader against the real library.
 *
 * Two levels of checking: every book must yield a readable container.xml and
 * OPF, and a sample of books has every single entry inflated and compared
 * against the size the central directory promised. The second one is what
 * actually proves the offsets and the inflate path, so it is worth the time
 * on a subset.
 *
 * Usage:
 *   node tools/test_zip.mjs <folder-or-file> [...] [--deep N] [--limit N]
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { ZipArchive } from '../js/zip.js';

async function findBooks(root, limit) {
  const found = [];
  async function walk(dir) {
    if (limit && found.length >= limit) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (limit && found.length >= limit) return;
      const path = join(dir, item.name);
      if (item.isDirectory()) await walk(path);
      else if (extname(item.name).toLowerCase() === '.epub') found.push(path);
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await walk(root);
  else found.push(root);
  return found;
}

function findOpfPath(containerXml) {
  const match = /full-path\s*=\s*["']([^"']+)["']/i.exec(containerXml);
  return match ? match[1].replace(/\\/g, '/').replace(/^\/+/, '') : null;
}

async function checkShallow(path) {
  const buffer = await readFile(path);
  const zip = await ZipArchive.open(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );

  const container = await zip.readText('META-INF/container.xml');
  const opfPath = findOpfPath(container);
  if (!opfPath) throw new Error('container.xml に rootfile がありません');
  if (!zip.has(opfPath)) throw new Error(`OPF が見つかりません: ${opfPath}`);
  const opf = await zip.readText(opfPath);
  if (!/<\s*package/i.test(opf)) throw new Error('OPF が package 要素で始まっていません');

  return { zip, entries: zip.entries.size, opfPath, opfBytes: opf.length };
}

async function checkDeep(zip) {
  let checked = 0;
  let bytes = 0;
  for (const entry of zip.entries.values()) {
    if (entry.name.endsWith('/')) continue;      // directory marker
    const data = await zip.read(entry.name);
    if (data.length !== entry.size) {
      throw new Error(
        `サイズ不一致 ${entry.name}: 展開 ${data.length} / 目録 ${entry.size}`
      );
    }
    checked += 1;
    bytes += data.length;
  }
  return { checked, bytes };
}

async function main() {
  const args = process.argv.slice(2);
  const takesValue = new Set(['--deep', '--limit']);
  const paths = [];
  let deepCount = 40;
  let limit = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (takesValue.has(arg)) {
      const value = Number(args[++i]);       // consume the value, not a path
      if (arg === '--deep') deepCount = value; else limit = value;
    } else if (!arg.startsWith('--')) {
      paths.push(arg);
    }
  }

  let books = [];
  for (const path of paths) books = books.concat(await findBooks(path, limit));
  if (limit) books = books.slice(0, limit);

  console.log(`${books.length} 冊を検査します（うち先頭 ${deepCount} 冊は全項目を展開）\n`);

  let ok = 0;
  let deepEntries = 0;
  let deepBytes = 0;
  const failures = [];
  const started = Date.now();

  for (let i = 0; i < books.length; i++) {
    const path = books[i];
    try {
      const { zip, entries } = await checkShallow(path);
      if (i < deepCount) {
        const deep = await checkDeep(zip);
        deepEntries += deep.checked;
        deepBytes += deep.bytes;
      }
      ok += 1;
      if (!entries) throw new Error('項目が 0 件です');
    } catch (err) {
      failures.push([basename(path), err.message]);
    }
    if ((i + 1) % 100 === 0 || i + 1 === books.length) {
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${books.length}  (${seconds}s)`);
    }
  }

  console.log('');
  console.log('='.repeat(66));
  console.log(`開けた本            : ${ok} / ${books.length}`);
  console.log(`全項目を展開した本  : ${Math.min(deepCount, books.length)}`);
  console.log(`  展開した項目数    : ${deepEntries.toLocaleString()}`);
  console.log(`  展開したバイト数  : ${(deepBytes / 1024 / 1024).toFixed(0)} MB（すべて目録と一致）`);
  if (failures.length) {
    console.log(`失敗                : ${failures.length}`);
    for (const [name, message] of failures.slice(0, 10)) {
      console.log(`   ${name.slice(0, 52)}`);
      console.log(`     ${message}`);
    }
  }
  console.log('='.repeat(66));
  process.exit(failures.length ? 1 : 0);
}

main();
