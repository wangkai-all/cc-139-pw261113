// 零依赖 HTTP 服务：JSON API + 前端静态文件
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine.js';
import * as store from './store.js';
import { validateRecords, mergeRecords } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireVersion(n) {
  const dataset = store.loadVersion(n);
  if (!dataset) {
    const err = new Error(`版本 v${n} 不存在`);
    err.status = 404;
    throw err;
  }
  return dataset;
}

const routes = {
  'GET /api/bootstrap': () => {
    const meta = store.getMeta();
    const dataset = store.loadVersion(meta.currentVersion);
    const engine = new Engine(dataset);
    return {
      meta,
      reportCcy: dataset.reportCcy,
      accounts: dataset.accounts,
      instruments: dataset.instruments,
      lastDate: engine.lastDate(),
    };
  },

  'GET /api/version/dataset': (req, q, n) => requireVersion(n),

  'GET /api/version/compute': (req, q, n) => {
    const dataset = requireVersion(n);
    const account = q.get('account') ?? dataset.accounts[0]?.id;
    const asOf = q.get('asOf') ?? new Engine(dataset).lastDate();
    return new Engine(dataset).computeState(account, asOf);
  },

  'GET /api/version/timeline': (req, q, n) => {
    const dataset = requireVersion(n);
    const account = q.get('account') ?? dataset.accounts[0]?.id;
    return new Engine(dataset).computeTimeline(account);
  },

  // 单笔成交的批次级追溯：卖出 -> 消耗了哪些买入批次；买入 -> 批次剩余情况
  'GET /api/version/trade': (req, q, n) => {
    const dataset = requireVersion(n);
    const id = q.get('id');
    const trade = dataset.trades.find((t) => t.id === id);
    if (!trade) {
      const err = new Error(`成交 ${id} 不存在`);
      err.status = 404;
      throw err;
    }
    const engine = new Engine(dataset);
    const state = engine.computeState(trade.accountId, engine.lastDate());
    const fees = dataset.fees.filter((f) => f.tradeId === id);
    return {
      trade,
      fees,
      reversed: Boolean(trade.reversedBy),
      realized: state.realized.find((r) => r.tradeId === id) ?? null,
      lots: state.positions.flatMap((p) => p.lots.filter((l) => l.tradeId === id).map((l) => ({ ...l, symbol: p.symbol }))),
      errors: state.errors.filter((e) => e.tradeId === id),
    };
  },

  'POST /api/import': async (req) => {
    const body = await readBody(req);
    const records = body.records ?? body;
    const errors = validateRecords(records);
    if (errors.length) {
      const err = new Error(`导入校验失败：\n${errors.join('\n')}`);
      err.status = 400;
      throw err;
    }
    const { dataset } = store.loadCurrent();
    const { next, dup } = mergeRecords(dataset, records);
    if (dup.length) {
      const err = new Error(`以下 id 已存在，导入被拒绝：${dup.join(', ')}`);
      err.status = 400;
      throw err;
    }
    const counts = ['trades', 'fees', 'corporateActions', 'deposits', 'prices', 'fxRates']
      .map((k) => `${k}:${(records[k] ?? []).length}`)
      .join(' ');
    const label = body.label?.trim() || `导入（${counts}）`;
    const { meta, n } = store.createVersion(next, 'IMPORT', label);
    return { ok: true, version: n, meta };
  },

  // 冲正：把目标记录标记为已冲正（不参与计算），可选追加一条更正记录，生成新版本
  'POST /api/reverse': async (req) => {
    const body = await readBody(req);
    const { targetType, targetId, reason, replacement, replacementFees } = body;
    const keyOf = { trade: 'trades', fee: 'fees', corporateAction: 'corporateActions', deposit: 'deposits' }[targetType];
    if (!keyOf) {
      const err = new Error(`不支持的冲正类型：${targetType}`);
      err.status = 400;
      throw err;
    }
    const { dataset } = store.loadCurrent();
    const next = structuredClone(dataset);
    const target = next[keyOf].find((x) => x.id === targetId);
    if (!target) {
      const err = new Error(`记录 ${targetId} 不存在`);
      err.status = 404;
      throw err;
    }
    if (target.reversedBy) {
      const err = new Error(`记录 ${targetId} 已被冲正，不能重复冲正`);
      err.status = 400;
      throw err;
    }
    const reversalId = store.newId('rev');
    target.reversedBy = reversalId;
    let replacementId = null;
    if (replacement) {
      const errors = validateRecords({ [keyOf]: [replacement], fees: replacementFees ?? [] });
      if (errors.length) {
        const err = new Error(`更正记录校验失败：\n${errors.join('\n')}`);
        err.status = 400;
        throw err;
      }
      replacementId = replacement.id ?? store.newId(targetType);
      next[keyOf].push({ ...replacement, id: replacementId });
      for (const f of replacementFees ?? []) {
        next.fees.push({ ...f, id: f.id ?? store.newId('f'), tradeId: replacementId });
      }
    }
    next.reversals.push({
      id: reversalId,
      targetType,
      targetId,
      reason: reason ?? '',
      replacementId,
      createdAt: new Date().toISOString(),
    });
    const label = `冲正 ${targetId}${replacement ? ' 并更正' : ''}${reason ? `：${reason}` : ''}`;
    const { meta, n } = store.createVersion(next, 'REVERSAL', label);
    return { ok: true, version: n, reversalId, replacementId, meta };
  },

  'POST /api/reset': async () => {
    const meta = store.resetToSample();
    return { ok: true, meta };
  },
};

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(full);
  res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  try {
    // 动态路由：/api/version/:n/{dataset|compute|timeline|trade}
    const m = pathname.match(/^\/api\/version\/(\d+)\/(dataset|compute|timeline|trade)$/);
    const key = m ? `${req.method} /api/version/${m[2]}` : `${req.method} ${pathname}`;
    const handler = routes[key];
    if (handler && req.method === (m ? 'GET' : req.method)) {
      const result = await handler(req, url.searchParams, m ? Number(m[1]) : undefined);
      sendJson(res, 200, result);
      return;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口：${req.method} ${pathname}` });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (err) {
    sendJson(res, err.status ?? 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  store.getMeta(); // 首次启动时生成样本数据
  console.log(`投资交易分析服务已启动: http://localhost:${PORT}`);
});
