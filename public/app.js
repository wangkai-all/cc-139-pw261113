// 前端单页应用：总览 / 成交与批次 / 现金流与盈亏 / 数据与版本
// 所有动态文本一律经 esc() 或 textContent 注入，防止样本/导入数据中的字符破坏 DOM。

const $ = (sel) => document.querySelector(sel);

const state = {
  bootstrap: null,
  version: null,
  account: null,
  asOf: null,
  tab: 'overview',
  dataset: null,
  timeline: [],
  compute: null,
  chartMode: 'chart', // or 'table'
  expandedTrade: null,
  expandedRealized: null,
};

// ---------- 工具 ----------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (n, dp = 2) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const fmtQty = (n) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 });

const fmtCompact = (n) => {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return fmt(n, 0);
};

const signed = (n, dp = 2) => (n == null ? '—' : `${n > 0 ? '+' : ''}${fmt(n, dp)}`);
const cls = (n) => (n == null ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');

async function api(path, opts) {
  const r = await fetch(path, opts && { ...opts, headers: { 'Content-Type': 'application/json' } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 2600);
}

const instName = (symbol) => state.bootstrap.instruments.find((i) => i.symbol === symbol)?.name ?? symbol;
const instCcy = (symbol) => state.bootstrap.instruments.find((i) => i.symbol === symbol)?.ccy ?? '';

// ---------- 数据加载 ----------
async function loadAll(keepAsOf = false) {
  const v = state.version;
  const [dataset, timeline] = await Promise.all([
    api(`/api/version/${v}/dataset`),
    api(`/api/version/${v}/timeline?account=${state.account}`),
  ]);
  state.dataset = dataset;
  state.timeline = timeline;
  if (!keepAsOf || !state.asOf) {
    state.asOf = timeline.length ? timeline[timeline.length - 1].date : state.bootstrap.lastDate;
  }
  await loadCompute();
}

async function loadCompute() {
  state.compute = await api(`/api/version/${state.version}/compute?account=${state.account}&asOf=${state.asOf}`);
  render();
}

// ---------- 头部控制 ----------
function renderHeader() {
  const { accounts, meta } = state.bootstrap;
  $('#selAccount').innerHTML = accounts.map((a) => `<option value="${esc(a.id)}"${a.id === state.account ? ' selected' : ''}>${esc(a.name)}（${esc(a.id)}）</option>`).join('');
  $('#selVersion').innerHTML = meta.versions
    .map((v) => `<option value="${v.n}"${v.n === state.version ? ' selected' : ''}>v${v.n} · ${esc(v.label)}</option>`)
    .join('');
  $('#inpDate').value = state.asOf ?? '';
}

// ---------- 总览 ----------
function renderOverview() {
  const c = state.compute;
  const t = c.totals;
  const missingPanel = c.missing.length
    ? `<div class="panel warn"><span class="title">⚠ 数据缺口（${c.missing.length}）—— 以下项目未计入总资产，不估算：</span><ul>${c.missing
        .map((m) =>
          m.type === 'PRICE'
            ? `<li>缺行情：${esc(m.symbol)} 在 ${esc(m.date)} 当日或之前没有收盘价（${esc(m.for)}）</li>`
            : `<li>缺汇率：${esc(m.from)}→${esc(m.to)} 在 ${esc(m.date)} 当日或之前没有汇率（${esc(m.for)}）</li>`,
        )
        .join('')}</ul></div>`
    : '';
  const errPanel = c.errors.length
    ? `<div class="panel err"><span class="title">✖ 计算错误（${c.errors.length}）—— 相关成交已跳过，未暗中做空：</span><ul>${c.errors
        .map((e) => `<li>${esc(e.date)} ${esc(e.message ?? e.type)}</li>`)
        .join('')}</ul></div>`
    : '';

  const posRows = c.positions
    .map((p) => {
      const lots = p.lots
        .map((l) => `<span class="sub">批次 ${esc(l.tradeId)} ${esc(l.date)} 买 ${fmtQty(l.qty)}，剩 ${fmtQty(l.remaining)} @${fmt(l.unitCost, 4)}</span>`)
        .join('<br>');
      return `<tr>
        <td class="l"><strong>${esc(p.symbol)}</strong> <span class="sub">${esc(p.name)}</span><br>${lots}</td>
        <td>${fmtQty(p.qty)}</td>
        <td>${fmt(p.avgCost, 4)}</td>
        <td>${p.price == null ? '<span class="badge err">缺价</span>' : `${fmt(p.price)}<br><span class="sub">${esc(p.priceDate)}</span>`}</td>
        <td>${p.mv == null ? '—' : `${fmt(p.mv)} ${esc(p.ccy)}`}</td>
        <td>${p.fxRate == null ? '<span class="badge err">缺汇率</span>' : `${fmt(p.fxRate, 4)}<br><span class="sub">${esc(p.fxDate)}</span>`}</td>
        <td>${fmt(p.mvReport)}</td>
        <td class="${cls(p.unrealReport)}">${signed(p.unrealReport)}</td>
      </tr>`;
    })
    .join('');

  const cashRows = c.cash
    .map(
      (x) => `<tr>
        <td class="l">${esc(x.ccy)}</td>
        <td>${fmt(x.amount)}</td>
        <td>${x.fxRate == null ? '<span class="badge err">缺汇率</span>' : `${fmt(x.fxRate, 4)} <span class="sub">${esc(x.fxDate)}</span>`}</td>
        <td>${fmt(x.amountReport)}</td>
      </tr>`,
    )
    .join('');

  const dayEvents = c.events.filter((e) => e.date === state.asOf);

  $('#tab-overview').innerHTML = `
    ${errPanel}${missingPanel}
    <div class="kpis">
      <div class="kpi hero"><div class="label">总资产（${esc(c.reportCcy)}，${esc(state.asOf)}）</div>
        <div class="value">${fmt(t.totalReport)}</div>
        <div class="sub">持仓市值 + 现金；缺价/缺汇率项未计入</div></div>
      <div class="kpi"><div class="label">持仓市值</div><div class="value">${fmt(t.positionsReport)}</div>
        <div class="sub">未实现盈亏 <span class="${cls(t.unrealizedReport)}">${signed(t.unrealizedReport)}</span></div></div>
      <div class="kpi"><div class="label">现金合计</div><div class="value">${fmt(t.cashReport)}</div>
        <div class="sub">${c.cash.length} 个币种</div></div>
      <div class="kpi"><div class="label">累计已实现盈亏</div><div class="value ${cls(t.realizedReport)}">${signed(t.realizedReport)}</div>
        <div class="sub">按成交日汇率折算</div></div>
    </div>

    <div class="card">
      <div class="chart-toggle">
        <h2 style="margin:0;flex:1">总资产走势（${esc(c.reportCcy)}）</h2>
        <button data-chartmode="chart"${state.chartMode === 'chart' ? ' class="primary"' : ''}>图表</button>
        <button data-chartmode="table"${state.chartMode === 'table' ? ' class="primary"' : ''}>表格</button>
      </div>
      <div id="chartBox"></div>
      ${dayEvents.length ? `<div class="mt"><span class="muted">当日事件：</span>${dayEvents.map((e) => `<span class="badge">${esc(e.label)}</span>`).join(' ')}</div>` : ''}
    </div>

    <div class="card">
      <h2>持仓（截至 ${esc(state.asOf)}）</h2>
      <table class="data">
        <thead><tr><th class="l">标的 / 批次</th><th>数量</th><th>平均成本</th><th>现价</th><th>市值（交易币）</th><th>汇率</th><th>市值（${esc(c.reportCcy)}）</th><th>未实现盈亏</th></tr></thead>
        <tbody>${posRows || '<tr><td colspan="8" class="l muted">暂无持仓</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>现金（分币种）</h2>
      <table class="data">
        <thead><tr><th class="l">币种</th><th>金额</th><th>汇率（估值日口径）</th><th>折合 ${esc(c.reportCcy)}</th></tr></thead>
        <tbody>${cashRows || '<tr><td colspan="4" class="l muted">暂无现金</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#tab-overview').querySelectorAll('[data-chartmode]').forEach((b) =>
    b.addEventListener('click', () => {
      state.chartMode = b.dataset.chartmode;
      renderOverview();
    }),
  );
  renderChartOrTable();
}

// 总资产走势：单系列折线（2px 线 + 10% 面积），十字线 + tooltip，当前估值日标记，端点标签
function renderChartOrTable() {
  const box = $('#chartBox');
  const tl = state.timeline;
  if (!tl.length) {
    box.innerHTML = '<p class="muted">暂无时间轴数据</p>';
    return;
  }
  if (state.chartMode === 'table') {
    box.innerHTML = `<table class="data">
      <thead><tr><th class="l">日期</th><th>总资产</th><th>现金</th><th>持仓市值</th><th>累计已实现</th><th class="l">事件</th></tr></thead>
      <tbody>${tl
        .map(
          (p) => `<tr${p.date === state.asOf ? ' class="expanded"' : ''}>
          <td class="l">${esc(p.date)}</td><td>${fmt(p.totalReport)}</td><td>${fmt(p.cashReport)}</td>
          <td>${fmt(p.positionsReport)}</td><td class="${cls(p.realizedReport)}">${signed(p.realizedReport)}</td>
          <td class="l">${p.events.map(esc).join('；') || ''}${p.missingCount ? ` <span class="badge">缺口${p.missingCount}</span>` : ''}${p.errorCount ? ` <span class="badge err">错误${p.errorCount}</span>` : ''}</td>
        </tr>`,
        )
        .join('')}</tbody></table>`;
    return;
  }

  const W = 1080;
  const H = 280;
  const pad = { l: 64, r: 88, t: 14, b: 30 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const t0 = Date.parse(tl[0].date);
  const t1 = Date.parse(tl[tl.length - 1].date);
  const xs = (d) => pad.l + ((Date.parse(d) - t0) / Math.max(1, t1 - t0)) * iw;
  const vals = tl.map((p) => p.totalReport);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < Math.max(1, hi * 0.01)) {
    hi += Math.max(1, hi * 0.01);
    lo -= Math.max(1, Math.abs(lo) * 0.01);
  }
  const ys = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  // 4 条整洁的 y 轴刻度
  const ticks = [];
  for (let i = 0; i <= 4; i++) ticks.push(lo + ((hi - lo) * i) / 4);

  const line = tl.map((p, i) => `${i ? 'L' : 'M'}${xs(p.date).toFixed(1)},${ys(p.totalReport).toFixed(1)}`).join(' ');
  const area = `${line} L${xs(tl[tl.length - 1].date).toFixed(1)},${(pad.t + ih).toFixed(1)} L${pad.l},${(pad.t + ih).toFixed(1)} Z`;
  const last = tl[tl.length - 1];
  const cur = tl.find((p) => p.date === state.asOf) ?? tl.reduce((a, b) => (b.date <= state.asOf ? b : a), tl[0]);

  const xTickIdx = [...new Set([0, Math.floor((tl.length - 1) / 2), tl.length - 1])];

  box.innerHTML = `
  <div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="总资产走势折线图">
      ${ticks
        .map(
          (v) => `<line x1="${pad.l}" y1="${ys(v)}" x2="${W - pad.r}" y2="${ys(v)}" stroke="var(--gridline)" stroke-width="1"/>
        <text x="${pad.l - 8}" y="${ys(v) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${esc(fmtCompact(v))}</text>`,
        )
        .join('')}
      <line x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}" stroke="var(--baseline)" stroke-width="1"/>
      ${xTickIdx
        .map((i) => `<text x="${xs(tl[i].date)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(tl[i].date.slice(2))}</text>`)
        .join('')}
      <path d="${area}" fill="var(--series-1-wash)"/>
      <path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${tl
        .filter((p) => p.events.length)
        .map(
          (p) =>
            `<circle cx="${xs(p.date)}" cy="${ys(p.totalReport)}" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"><title>${esc(p.date)} ${esc(p.events.join('；'))}</title></circle>`,
        )
        .join('')}
      <line x1="${xs(cur.date)}" y1="${pad.t}" x2="${xs(cur.date)}" y2="${pad.t + ih}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="3 3"/>
      <circle cx="${xs(cur.date)}" cy="${ys(cur.totalReport)}" r="5" fill="var(--surface-1)" stroke="var(--series-1)" stroke-width="2"/>
      <circle cx="${xs(last.date)}" cy="${ys(last.totalReport)}" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>
      <text x="${W - pad.r + 8}" y="${ys(last.totalReport) + 4}" font-size="12" font-weight="600" fill="var(--text-primary)">${esc(fmtCompact(last.totalReport))}</text>
      <line id="crosshair" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" stroke="var(--baseline)" stroke-width="1" visibility="hidden"/>
      <rect id="hoverZone" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}" fill="transparent"/>
    </svg>
    <div class="chart-tooltip" id="chartTip"></div>
  </div>`;

  const svg = box.querySelector('svg');
  const cross = box.querySelector('#crosshair');
  const tip = box.querySelector('#chartTip');
  const zone = box.querySelector('#hoverZone');
  zone.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bd = Infinity;
    tl.forEach((p, i) => {
      const d = Math.abs(xs(p.date) - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const p = tl[best];
    cross.setAttribute('x1', xs(p.date));
    cross.setAttribute('x2', xs(p.date));
    cross.setAttribute('visibility', 'visible');
    tip.style.display = 'block';
    const tipRows = [
      `<div class="v">${esc(fmt(p.totalReport))} ${esc(state.compute.reportCcy)}</div>`,
      `<div class="d">${esc(p.date)} · 现金 ${esc(fmtCompact(p.cashReport))} · 持仓 ${esc(fmtCompact(p.positionsReport))}</div>`,
    ];
    if (p.events.length) tipRows.push(`<div class="ev">${p.events.map(esc).join('<br>')}</div>`);
    tip.innerHTML = tipRows.join('');
    const rx = (xs(p.date) / W) * rect.width;
    const ry = (ys(p.totalReport) / H) * rect.height;
    tip.style.left = `${Math.min(rect.width - 200, Math.max(0, rx + 14))}px`;
    tip.style.top = `${Math.max(0, ry - 20)}px`;
  });
  zone.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    tip.style.display = 'none';
  });
}

// ---------- 成交与批次 ----------
function feeOf(tradeId) {
  return state.dataset.fees.filter((f) => f.tradeId === tradeId && !f.reversedBy);
}

function renderTrades() {
  const trades = [...state.dataset.trades]
    .filter((t) => t.accountId === state.account)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const errByTrade = new Map();
  for (const e of state.compute.errors) if (e.tradeId) errByTrade.set(e.tradeId, e);

  const rows = trades
    .map((t) => {
      const fees = feeOf(t.id);
      const feeTxt = fees.length ? fees.map((f) => `${esc(f.type)} ${fmt(f.amount)} ${esc(f.ccy)}`).join('<br>') : '<span class="muted">—</span>';
      const err = errByTrade.get(t.id);
      const status = t.reversedBy
        ? '<span class="badge rev">已冲正</span>'
        : err
          ? '<span class="badge err">错误</span>'
          : '<span class="badge">正常</span>';
      const canReverse = !t.reversedBy;
      const main = `<tr class="clickable${t.reversedBy ? ' reversed' : ''}" data-trade="${esc(t.id)}">
        <td class="l">${esc(t.date)}</td>
        <td class="l"><strong>${esc(t.symbol)}</strong> <span class="sub">${esc(instName(t.symbol))}</span></td>
        <td class="l"><span class="badge ${t.side === 'BUY' ? 'buy' : 'sell'}">${t.side === 'BUY' ? '买入' : '卖出'}</span></td>
        <td>${fmtQty(t.qty)}</td><td>${fmt(t.price)} ${esc(t.ccy)}</td>
        <td class="l">${feeTxt}</td><td class="l">${status}</td>
        <td>${canReverse ? `<button class="danger" data-reverse="${esc(t.id)}">冲正</button>` : ''}</td>
      </tr>`;
      let detail = '';
      if (state.expandedTrade === t.id) detail = `<tr class="detail"><td colspan="8" data-detail="${esc(t.id)}"><div class="muted">加载中…</div></td></tr>`;
      return main + detail;
    })
    .join('');

  $('#tab-trades').innerHTML = `
    <div class="card">
      <h2>成交记录（当前账户 · 版本 v${state.version}）—— 点击卖出成交可查看 FIFO 消耗了哪些买入批次</h2>
      <table class="data">
        <thead><tr><th class="l">日期</th><th class="l">标的</th><th class="l">方向</th><th>数量</th><th>价格</th><th class="l">关联费用</th><th class="l">状态</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8" class="l muted">暂无成交</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#tab-trades').querySelectorAll('tr[data-trade]').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const id = tr.dataset.trade;
      state.expandedTrade = state.expandedTrade === id ? null : id;
      renderTrades();
    }),
  );
  $('#tab-trades').querySelectorAll('[data-reverse]').forEach((b) =>
    b.addEventListener('click', () => openReverseModal('trade', b.dataset.reverse)),
  );
  if (state.expandedTrade) loadTradeDetail(state.expandedTrade);
}

async function loadTradeDetail(tradeId) {
  const cell = $(`[data-detail="${tradeId}"]`);
  if (!cell) return;
  try {
    const d = await api(`/api/version/${state.version}/trade?id=${encodeURIComponent(tradeId)}`);
    const t = d.trade;
    let html = `<div><strong>${esc(t.id)}</strong> ${esc(t.date)} ${t.side === 'BUY' ? '买入' : '卖出'} ${esc(t.symbol)} ${fmtQty(t.qty)} @${fmt(t.price)} ${esc(t.ccy)}`;
    if (d.fees.length) html += ` · 费用：${d.fees.map((f) => `${esc(f.type)} ${fmt(f.amount)} ${esc(f.ccy)}`).join('，')}`;
    html += '</div>';
    if (d.reversed) {
      html += '<div class="panel warn mt">该成交已被冲正，不参与当前版本计算。</div>';
    } else if (d.errors.length) {
      html += `<div class="panel err mt">${d.errors.map((e) => esc(e.message)).join('<br>')}</div>`;
    } else if (d.realized) {
      const r = d.realized;
      html += `<div class="mt"><strong>FIFO 批次消耗明细</strong>（合计盈亏 ${fmt(r.pnl)} ${esc(r.ccy)} × 成交日汇率 ${fmt(r.fxRate, 4)}（${esc(r.fxDate)}）= <strong class="${cls(r.pnlReport)}">${signed(r.pnlReport)} ${esc(state.compute.reportCcy)}</strong>）</div>
      <table class="data mt">
        <thead><tr><th class="l">买入批次</th><th class="l">买入日期</th><th>消耗数量</th><th>单位成本</th><th>卖出收入</th><th>分摊费用</th><th>批次成本</th><th>批次盈亏</th></tr></thead>
        <tbody>${r.consumptions
          .map(
            (c) => `<tr>
            <td class="l">${esc(c.lotTradeId)}</td><td class="l">${esc(c.lotDate)}</td>
            <td>${fmtQty(c.take)}</td><td>${fmt(c.unitCost, 4)}</td><td>${fmt(c.proceeds)}</td>
            <td>${fmt(c.feeAlloc, 4)}</td><td>${fmt(c.cost)}</td>
            <td class="${cls(c.pnl)}">${signed(c.pnl, 4)}</td>
          </tr>`,
          )
          .join('')}</tbody>
      </table>
      <div class="muted mt">费用分摊规则：卖出费用 ${fmt(r.feeTotal)} ${esc(r.ccy)} 按各批次消耗数量占比分摊；批次单位成本含买入费用。</div>`;
    } else if (d.lots.length) {
      html += `<div class="mt"><strong>该笔买入形成的批次（当前剩余）</strong></div>
      <table class="data mt">
        <thead><tr><th class="l">批次</th><th>原始数量</th><th>剩余数量</th><th>单位成本（含费用）</th></tr></thead>
        <tbody>${d.lots
          .map((l) => `<tr><td class="l">${esc(l.lotId)}</td><td>${fmtQty(l.qty)}</td><td>${fmtQty(l.remaining)}</td><td>${fmt(l.unitCost, 4)}</td></tr>`)
          .join('')}</tbody>
      </table>`;
    } else {
      html += '<div class="muted mt">该买入批次已被全部消耗。</div>';
    }
    cell.innerHTML = html;
  } catch (e) {
    cell.innerHTML = `<div class="panel err">${esc(e.message)}</div>`;
  }
}

// ---------- 现金流与盈亏 ----------
function renderCash() {
  const c = state.compute;
  const typeName = { DEPOSIT: '入金', BUY: '买入', SELL: '卖出', DIVIDEND: '现金分红', FEE: '费用' };
  const cfRows = [...c.cashflows]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map(
      (x) => `<tr>
      <td class="l">${esc(x.date)}</td>
      <td class="l"><span class="badge">${esc(typeName[x.type] ?? x.type)}</span></td>
      <td class="l">${esc(x.label)}</td>
      <td class="${cls(x.amount)}">${signed(x.amount)} ${esc(x.ccy)}</td>
      <td>${x.fxRate == null ? '<span class="badge err">缺汇率</span>' : `${fmt(x.fxRate, 4)} <span class="sub">${esc(x.fxDate)}</span>`}</td>
      <td class="${cls(x.amountReport)}">${signed(x.amountReport)}</td>
    </tr>`,
    )
    .join('');

  const rlRows = [...c.realized]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => {
      const open = state.expandedRealized === r.tradeId;
      const main = `<tr class="clickable" data-rl="${esc(r.tradeId)}">
        <td class="l">${esc(r.date)}</td>
        <td class="l"><strong>${esc(r.symbol)}</strong></td>
        <td>${fmtQty(r.qty)} @ ${fmt(r.price)}</td>
        <td>${fmt(r.feeTotal)}</td>
        <td class="${cls(r.pnl)}">${signed(r.pnl)} ${esc(r.ccy)}</td>
        <td>${r.fxRate == null ? '<span class="badge err">缺汇率</span>' : `${fmt(r.fxRate, 4)} <span class="sub">${esc(r.fxDate)}</span>`}</td>
        <td class="${cls(r.pnlReport)}">${signed(r.pnlReport)}</td>
      </tr>`;
      const detail = open
        ? `<tr class="detail"><td colspan="7"><table class="data">
            <thead><tr><th class="l">消耗批次</th><th class="l">批次日期</th><th>数量</th><th>单位成本</th><th>分摊费用</th><th>批次盈亏（${esc(r.ccy)}）</th></tr></thead>
            <tbody>${r.consumptions
              .map(
                (x) => `<tr><td class="l">${esc(x.lotTradeId)}</td><td class="l">${esc(x.lotDate)}</td><td>${fmtQty(x.take)}</td><td>${fmt(x.unitCost, 4)}</td><td>${fmt(x.feeAlloc, 4)}</td><td class="${cls(x.pnl)}">${signed(x.pnl, 4)}</td></tr>`,
              )
              .join('')}</tbody>
          </table></td></tr>`
        : '';
      return main + detail;
    })
    .join('');

  $('#tab-cash').innerHTML = `
    <div class="card">
      <h2>现金流（截至 ${esc(state.asOf)}，报告币金额按发生日汇率折算）</h2>
      <table class="data">
        <thead><tr><th class="l">日期</th><th class="l">类型</th><th class="l">说明</th><th>金额（交易币）</th><th>汇率</th><th>折合 ${esc(c.reportCcy)}</th></tr></thead>
        <tbody>${cfRows || '<tr><td colspan="6" class="l muted">暂无现金流</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>已实现盈亏（点击行展开批次明细；现金分红是独立现金流，不在此列）</h2>
      <table class="data">
        <thead><tr><th class="l">日期</th><th class="l">标的</th><th>卖出</th><th>费用</th><th>盈亏（交易币）</th><th>汇率（成交日）</th><th>盈亏（${esc(c.reportCcy)}）</th></tr></thead>
        <tbody>${rlRows || '<tr><td colspan="7" class="l muted">暂无已实现盈亏</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#tab-cash').querySelectorAll('tr[data-rl]').forEach((tr) =>
    tr.addEventListener('click', () => {
      state.expandedRealized = state.expandedRealized === tr.dataset.rl ? null : tr.dataset.rl;
      renderCash();
    }),
  );
}

// ---------- 数据与版本 ----------
const IMPORT_TEMPLATE = {
  trades: [{ accountId: 'acc_main', symbol: 'AAPL', side: 'BUY', qty: 10, price: 60, ccy: 'USD', date: '2025-04-15' }],
  fees: [{ accountId: 'acc_main', tradeId: null, type: '佣金', amount: 1, ccy: 'USD', date: '2025-04-15' }],
  corporateActions: [{ symbol: 'AAPL', type: 'DIVIDEND', dps: 0.07, ccy: 'USD', exDate: '2025-05-08', payDate: '2025-05-15' }],
  prices: [{ symbol: 'AAPL', date: '2025-04-15', close: 61 }],
  fxRates: [{ from: 'USD', to: 'CNY', date: '2025-04-15', rate: 7.3 }],
  deposits: [],
};

function renderData() {
  const { meta } = state.bootstrap;
  const ds = state.dataset;
  const vRows = meta.versions
    .map(
      (v) => `<tr${v.n === state.version ? ' class="expanded"' : ''}>
      <td class="l"><strong>v${v.n}</strong>${v.n === meta.currentVersion ? ' <span class="badge">当前</span>' : ''}</td>
      <td class="l">${esc(v.kind)}</td>
      <td class="l">${esc(v.label)}</td>
      <td class="l">${esc(new Date(v.createdAt).toLocaleString('zh-CN'))}</td>
      <td>${v.n !== state.version ? `<button data-switch="${v.n}">切换查看</button>` : ''}</td>
    </tr>`,
    )
    .join('');

  const revRows = (ds.reversals ?? [])
    .map(
      (r) => `<tr><td class="l">${esc(r.id)}</td><td class="l">${esc(r.targetType)} / ${esc(r.targetId)}</td><td class="l">${esc(r.reason)}</td><td class="l">${esc(r.replacementId ?? '—')}</td></tr>`,
    )
    .join('');

  const counts = ['trades', 'fees', 'corporateActions', 'deposits', 'prices', 'fxRates']
    .map((k) => `${k}: ${(ds[k] ?? []).length}`)
    .join(' · ');

  $('#tab-data').innerHTML = `
    <div class="card">
      <h2>计算版本（每次导入/冲正生成不可变新版本，可随时切换核对）</h2>
      <table class="data">
        <thead><tr><th class="l">版本</th><th class="l">类型</th><th class="l">说明</th><th class="l">生成时间</th><th></th></tr></thead>
        <tbody>${vRows}</tbody>
      </table>
      <div class="mt flex">
        <button id="btnDemoReverse">演示冲正：撤销 t10（卖出 AAPL 100 股）并更正为 80 股</button>
        <span class="muted">一键生成新版本，随后可在 v1/v2 间切换对比总资产与已实现盈亏</span>
      </div>
    </div>

    <div class="card">
      <h2>本版本冲正记录</h2>
      <table class="data">
        <thead><tr><th class="l">冲正编号</th><th class="l">对象</th><th class="l">原因</th><th class="l">更正记录</th></tr></thead>
        <tbody>${revRows || '<tr><td colspan="4" class="l muted">本版本暂无冲正</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>导入（成交 / 费用 / 汇率 / 公司行动 / 行情 / 入金，JSON 格式，导入即生成新版本）</h2>
      <div class="flex" style="margin-bottom:8px">
        <button id="btnTemplate">填入模板</button>
        <button id="btnImport" class="primary">校验并导入为新版本</button>
      </div>
      <textarea class="code" id="importBox" spellcheck="false" placeholder='{"trades":[...],"fees":[...],"fxRates":[...],"corporateActions":[...]}'></textarea>
    </div>

    <div class="card">
      <h2>当前版本数据集（v${state.version}）</h2>
      <div class="muted">${esc(counts)}</div>
      <details class="mt"><summary>查看完整 JSON</summary><pre class="json">${esc(JSON.stringify(ds, null, 2))}</pre></details>
    </div>`;

  $('#tab-data').querySelectorAll('[data-switch]').forEach((b) =>
    b.addEventListener('click', async () => {
      state.version = Number(b.dataset.switch);
      state.expandedTrade = null;
      await loadAll();
      toast(`已切换到 v${state.version}`);
    }),
  );
  $('#btnDemoReverse').addEventListener('click', demoReverse);
  $('#btnTemplate').addEventListener('click', () => {
    $('#importBox').value = JSON.stringify(IMPORT_TEMPLATE, null, 2);
  });
  $('#btnImport').addEventListener('click', doImport);
}

async function demoReverse() {
  const t10 = state.dataset.trades.find((t) => t.id === 't10');
  if (!t10 || t10.reversedBy) {
    toast('当前版本中 t10 不存在或已被冲正，请切换到包含 t10 的版本（如 v1）再演示', true);
    return;
  }
  try {
    const r = await api('/api/reverse', {
      method: 'POST',
      body: JSON.stringify({
        targetType: 'trade',
        targetId: 't10',
        reason: '客户指令撤销，按 80 股更正',
        replacement: { accountId: 'acc_main', symbol: 'AAPL', side: 'SELL', qty: 80, price: 60, ccy: 'USD', date: '2025-01-20' },
        replacementFees: [{ accountId: 'acc_main', type: '佣金', amount: 2, ccy: 'USD', date: '2025-01-20' }],
      }),
    });
    state.bootstrap = await api('/api/bootstrap');
    state.version = r.version;
    await loadAll();
    toast(`已生成新版本 v${r.version}（冲正 t10，更正为 80 股）`);
  } catch (e) {
    toast(e.message, true);
  }
}

async function doImport() {
  let records;
  try {
    records = JSON.parse($('#importBox').value);
  } catch {
    toast('JSON 解析失败，请检查格式', true);
    return;
  }
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.stringify({ records }) });
    state.bootstrap = await api('/api/bootstrap');
    state.version = r.version;
    await loadAll();
    toast(`导入成功，已生成 v${r.version}`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- 冲正弹窗 ----------
function openReverseModal(targetType, targetId) {
  const t = state.dataset.trades.find((x) => x.id === targetId);
  const isTrade = targetType === 'trade' && t;
  $('#modalBox').innerHTML = `
    <h3>冲正记录 ${esc(targetId)}</h3>
    <div class="muted" style="margin-bottom:10px">冲正后原记录保留在数据集中但标记为「已冲正」，不参与计算；可选择同时追加一条更正记录。整个操作生成一个新计算版本。</div>
    <div class="row"><label>原因</label><input type="text" id="revReason" placeholder="例如：客户指令撤销"></div>
    ${isTrade ? `<div class="row"><label><input type="checkbox" id="revWithRepl" checked style="width:auto"> 同时更正</label>
      <span class="muted">${esc(t.symbol)} ${t.side === 'BUY' ? '买入' : '卖出'}</span></div>
    <div class="row"><label>数量</label><input type="number" id="revQty" value="${esc(t.qty)}" min="0" step="any"></div>
    <div class="row"><label>价格</label><input type="number" id="revPrice" value="${esc(t.price)}" min="0" step="any"></div>
    <div class="row"><label>日期</label><input type="date" id="revDate" value="${esc(t.date)}"></div>
    <div class="row"><label>费用</label><input type="number" id="revFee" value="0" min="0" step="any"><span class="muted">${esc(t.ccy)}</span></div>` : ''}
    <div class="actions">
      <button id="revCancel">取消</button>
      <button id="revOk" class="primary">生成新版本</button>
    </div>`;
  $('#modalMask').classList.add('open');
  $('#revCancel').addEventListener('click', () => $('#modalMask').classList.remove('open'));
  $('#revOk').addEventListener('click', async () => {
    const body = { targetType, targetId, reason: $('#revReason').value };
    if (isTrade && $('#revWithRepl').checked) {
      body.replacement = {
        accountId: t.accountId,
        symbol: t.symbol,
        side: t.side,
        qty: Number($('#revQty').value),
        price: Number($('#revPrice').value),
        ccy: t.ccy,
        date: $('#revDate').value,
      };
      const fee = Number($('#revFee').value);
      if (fee > 0) body.replacementFees = [{ accountId: t.accountId, type: '佣金', amount: fee, ccy: t.ccy, date: body.replacement.date }];
    }
    try {
      const r = await api('/api/reverse', { method: 'POST', body: JSON.stringify(body) });
      $('#modalMask').classList.remove('open');
      state.bootstrap = await api('/api/bootstrap');
      state.version = r.version;
      await loadAll();
      toast(`已生成新版本 v${r.version}`);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

// ---------- 渲染分发 ----------
function render() {
  renderHeader();
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  for (const tab of ['overview', 'trades', 'cash', 'data']) {
    $(`#tab-${tab}`).hidden = tab !== state.tab;
  }
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'trades') renderTrades();
  else if (state.tab === 'cash') renderCash();
  else renderData();
}

// ---------- 事件绑定 ----------
function bindGlobal() {
  $('#selAccount').addEventListener('change', async (e) => {
    state.account = e.target.value;
    state.expandedTrade = null;
    await loadAll(true);
  });
  $('#selVersion').addEventListener('change', async (e) => {
    state.version = Number(e.target.value);
    state.expandedTrade = null;
    await loadAll();
  });
  $('#inpDate').addEventListener('change', async (e) => {
    state.asOf = e.target.value;
    await loadCompute();
  });
  const step = (dir) => async () => {
    const dates = state.timeline.map((p) => p.date);
    const idx = dates.findIndex((d) => d === state.asOf);
    if (dir > 0) {
      const next = dates.find((d) => d > state.asOf);
      if (next) state.asOf = next;
    } else {
      const prev = [...dates].reverse().find((d) => d < state.asOf);
      if (prev) state.asOf = prev;
      else if (idx !== 0 && dates.length) state.asOf = dates[0];
    }
    await loadCompute();
  };
  $('#btnPrevDay').addEventListener('click', step(-1));
  $('#btnNextDay').addEventListener('click', step(1));
  $('#btnLatest').addEventListener('click', async () => {
    const dates = state.timeline.map((p) => p.date);
    if (dates.length) state.asOf = dates[dates.length - 1];
    await loadCompute();
  });
  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('确定重置？全部版本与导入数据将被清空并恢复样本。')) return;
    await api('/api/reset', { method: 'POST', body: '{}' });
    state.bootstrap = await api('/api/bootstrap');
    state.version = state.bootstrap.meta.currentVersion;
    state.account = state.bootstrap.accounts[0].id;
    await loadAll();
    toast('已重置为样本数据');
  });
  document.querySelectorAll('nav.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      render();
    }),
  );
  $('#modalMask').addEventListener('click', (e) => {
    if (e.target === $('#modalMask')) $('#modalMask').classList.remove('open');
  });
}

// ---------- 启动 ----------
(async function init() {
  try {
    state.bootstrap = await api('/api/bootstrap');
    state.version = state.bootstrap.meta.currentVersion;
    state.account = state.bootstrap.accounts[0].id;
    bindGlobal();
    await loadAll();
  } catch (e) {
    document.querySelector('main').innerHTML = `<div class="panel err">初始化失败：${esc(e.message)}</div>`;
  }
})();
