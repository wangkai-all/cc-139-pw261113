// 版本化数据存储：每个计算版本是数据集的一份不可变快照（data/vN.json）。
// 导入与冲正都会生成新版本；历史版本可随时切换查看、互相核对。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSampleDataset } from './sample-data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const META_FILE = path.join(DATA_DIR, 'meta.json');

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

export function resetToSample() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^v\d+\.json$/.test(f)) fs.unlinkSync(path.join(DATA_DIR, f));
  }
  writeJson(path.join(DATA_DIR, 'v1.json'), buildSampleDataset());
  const meta = {
    currentVersion: 1,
    versions: [{ n: 1, kind: 'INIT', label: '初始样本导入', createdAt: new Date().toISOString() }],
  };
  writeJson(META_FILE, meta);
  return meta;
}

export function getMeta() {
  if (!fs.existsSync(META_FILE)) resetToSample();
  return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
}

export function loadVersion(n) {
  const file = path.join(DATA_DIR, `v${n}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadCurrent() {
  const meta = getMeta();
  return { meta, dataset: loadVersion(meta.currentVersion) };
}

// 以当前版本为基底生成新版本（不可变快照），并切换为当前版本
export function createVersion(dataset, kind, label) {
  const meta = getMeta();
  const n = Math.max(...meta.versions.map((v) => v.n)) + 1;
  writeJson(path.join(DATA_DIR, `v${n}.json`), dataset);
  meta.versions.push({ n, kind, label, createdAt: new Date().toISOString() });
  meta.currentVersion = n;
  writeJson(META_FILE, meta);
  return { meta, n };
}

let idCounter = 0;
export function newId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
