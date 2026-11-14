// 核心计算引擎 —— 投资交易分析
//
// 计算规则（README 有完整说明）：
//  - 成本：先进先出（FIFO）。买入费用计入该批次的单位成本；卖出费用按消耗数量占比分摊到各批次。
//  - 部分卖出：只扣减被消耗数量，批次剩余数量保留。
//  - 拆股：在除权日对全部未平仓批次，数量 × 比例、单位成本 ÷ 比例。
//  - 现金分红：除息日快照持仓数量，派息日按快照数量 × 每股分红计入现金，是独立现金流；
//    行情使用未复权收盘价，分红不再计入持仓成本或盈亏，避免重复计算。
//  - 多币种：每笔金额同时保留交易币与报告币口径；已实现盈亏按成交日汇率折算，
//    估值（市值/现金/总资产）按估值日汇率折算，各自记录所用汇率与日期。
//  - 汇率/行情取值：取当日或之前最近一条；取不到不估算，计入「数据缺口」单独展示。
//  - 仅现货多头：卖出数量超过持仓时记录错误并跳过该笔成交，绝不暗中按做空处理。

const EPS = 1e-9;

export const r6 = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
export const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// 在按日期升序的行中取「当日或之前最近一条」
function lastOnOrBefore(sortedRows, date, dateOf) {
  let lo = 0;
  let hi = sortedRows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dateOf(sortedRows[mid]) <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? sortedRows[ans] : null;
}

function groupBySorted(rows, keyOf, dateOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  for (const arr of m.values()) arr.sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : 1));
  return m;
}

const KIND_ORDER = { deposit: 0, split: 1, divEx: 2, trade: 3, divPay: 4, fee: 5 };

export class Engine {
  constructor(dataset) {
    this.ds = dataset;
    this.reportCcy = dataset.reportCcy;
    this.instruments = new Map((dataset.instruments ?? []).map((i) => [i.symbol, i]));
    this.fxByPair = groupBySorted(dataset.fxRates ?? [], (r) => `${r.from}->${r.to}`, (r) => r.date);
    this.pxBySymbol = groupBySorted(dataset.prices ?? [], (p) => p.symbol, (p) => p.date);
  }

  // 汇率：from -> to 在 date 当日或之前最近一条；同币种恒为 1
  fxAt(from, to, date) {
    if (from === to) return { rate: 1, date, sameCcy: true };
    const rows = this.fxByPair.get(`${from}->${to}`);
    if (!rows) return null;
    const hit = lastOnOrBefore(rows, date, (r) => r.date);
    return hit ? { rate: hit.rate, date: hit.date } : null;
  }

  // 行情：symbol 在 date 当日或之前最近一条收盘价（未复权）
  priceAt(symbol, date) {
    const rows = this.pxBySymbol.get(symbol);
    if (!rows) return null;
    const hit = lastOnOrBefore(rows, date, (p) => p.date);
    return hit ? { close: hit.close, date: hit.date } : null;
  }

  // 数据集中全部相关日期的最大值（默认估值日）
  lastDate() {
    let max = '0000-00-00';
    const scan = (rows, dateOf) => {
      for (const r of rows ?? []) {
        const d = dateOf(r);
        if (d && d > max) max = d;
      }
    };
    scan(this.ds.trades, (t) => t.date);
    scan(this.ds.fees, (f) => f.date);
    scan(this.ds.deposits, (d) => d.date);
    scan(this.ds.corporateActions, (c) => c.payDate ?? c.exDate);
    scan(this.ds.prices, (p) => p.date);
    scan(this.ds.fxRates, (r) => r.date);
    return max;
  }

  // 组装指定账户、截至 asOf 的事件流（已按日期与日内顺序排序）
  buildEvents(accountId, asOf) {
    const ds = this.ds;
    const evs = [];
    const feeByTrade = new Map();
    for (const f of ds.fees ?? []) {
      if (f.reversedBy || !f.tradeId) continue;
      if (!feeByTrade.has(f.tradeId)) feeByTrade.set(f.tradeId, []);
      feeByTrade.get(f.tradeId).push(f);
    }
    for (const t of ds.trades ?? []) {
      if (t.reversedBy || t.accountId !== accountId || t.date > asOf) continue;
      evs.push({ date: t.date, kind: 'trade', trade: t, fees: feeByTrade.get(t.id) ?? [] });
    }
    for (const f of ds.fees ?? []) {
      if (f.reversedBy || f.tradeId || f.accountId !== accountId || f.date > asOf) continue;
      evs.push({ date: f.date, kind: 'fee', fee: f });
    }
    for (const d of ds.deposits ?? []) {
      if (d.reversedBy || d.accountId !== accountId || d.date > asOf) continue;
      evs.push({ date: d.date, kind: 'deposit', deposit: d });
    }
    for (const ca of ds.corporateActions ?? []) {
      if (ca.reversedBy) continue;
      if (ca.type === 'SPLIT') {
        if (ca.exDate <= asOf) evs.push({ date: ca.exDate, kind: 'split', ca });
      } else if (ca.type === 'DIVIDEND') {
        if (ca.exDate <= asOf) evs.push({ date: ca.exDate, kind: 'divEx', ca });
        const pay = ca.payDate ?? ca.exDate;
        if (pay <= asOf) evs.push({ date: pay, kind: 'divPay', ca });
      }
    }
    const refOf = (e) => e.trade?.id ?? e.fee?.id ?? e.ca?.id ?? e.deposit?.id ?? '';
    evs.sort((a, b) =>
      a.date < b.date ? -1
      : a.date > b.date ? 1
      : (KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) || String(refOf(a)).localeCompare(String(refOf(b))));
    return evs;
  }

  newState() {
    return {
      lots: new Map(), // symbol -> [lot]
      cash: new Map(), // ccy -> amount
      realized: [],
      cashflows: [],
      errors: [],
      missing: [],
      log: [],
      pendingDivs: [],
      seq: 0,
    };
  }

  qtyOf(st, symbol) {
    return r6((st.lots.get(symbol) ?? []).reduce((s, l) => s + l.remaining, 0));
  }

  addCash(st, ccy, delta) {
    st.cash.set(ccy, r6((st.cash.get(ccy) ?? 0) + delta));
  }

  addCashflow(st, entry) {
    const fx = this.fxAt(entry.ccy, this.reportCcy, entry.date);
    const cf = {
      id: `cf${++st.seq}`,
      ...entry,
      amount: r6(entry.amount),
      fxRate: fx ? fx.rate : null,
      fxDate: fx ? fx.date : null,
      amountReport: fx ? r6(entry.amount * fx.rate) : null,
    };
    if (!fx) {
      st.missing.push({ type: 'FX', from: entry.ccy, to: this.reportCcy, date: entry.date, for: `cashflow:${cf.id}` });
    }
    st.cashflows.push(cf);
    return cf;
  }

  applyEvent(st, ev) {
    switch (ev.kind) {
      case 'deposit': {
        const d = ev.deposit;
        this.addCash(st, d.ccy, d.amount);
        this.addCashflow(st, {
          date: d.date, type: 'DEPOSIT', ccy: d.ccy, amount: d.amount,
          refType: 'deposit', refId: d.id, label: `入金 ${d.amount} ${d.ccy}`,
        });
        st.log.push({ date: d.date, kind: 'deposit', refId: d.id, label: `入金 ${d.amount} ${d.ccy}` });
        break;
      }
      case 'fee': {
        const f = ev.fee;
        this.addCash(st, f.ccy, -f.amount);
        this.addCashflow(st, {
          date: f.date, type: 'FEE', ccy: f.ccy, amount: -f.amount,
          refType: 'fee', refId: f.id, label: `费用 ${f.type} ${f.amount} ${f.ccy}`,
        });
        st.log.push({ date: f.date, kind: 'fee', refId: f.id, label: `费用 ${f.type} ${f.amount} ${f.ccy}` });
        break;
      }
      case 'trade':
        this.applyTrade(st, ev);
        break;
      case 'split': {
        const { symbol, ratio } = ev.ca;
        for (const lot of st.lots.get(symbol) ?? []) {
          lot.qty = r6(lot.qty * ratio);
          lot.remaining = r6(lot.remaining * ratio);
          lot.unitCost = r6(lot.unitCost / ratio);
        }
        st.log.push({
          date: ev.date, kind: 'split', refId: ev.ca.id,
          label: `拆股 ${symbol} 1拆${ratio}（数量×${ratio}，单位成本÷${ratio}）`,
        });
        break;
      }
      case 'divEx': {
        const shares = this.qtyOf(st, ev.ca.symbol);
        st.pendingDivs.push({ caId: ev.ca.id, symbol: ev.ca.symbol, shares, paid: false });
        st.log.push({
          date: ev.date, kind: 'divEx', refId: ev.ca.id,
          label: `除息 ${ev.ca.symbol} 每股 ${ev.ca.dps} ${ev.ca.ccy}（登记持仓 ${shares} 股）`,
        });
        break;
      }
      case 'divPay': {
        for (const p of st.pendingDivs) {
          if (p.caId !== ev.ca.id || p.paid) continue;
          p.paid = true;
          const amount = r6(p.shares * ev.ca.dps);
          this.addCash(st, ev.ca.ccy, amount);
          this.addCashflow(st, {
            date: ev.date, type: 'DIVIDEND', ccy: ev.ca.ccy, amount,
            refType: 'corporateAction', refId: ev.ca.id,
            label: `现金分红 ${p.symbol} ${p.shares}股 × ${ev.ca.dps} ${ev.ca.ccy}`,
          });
          st.log.push({
            date: ev.date, kind: 'divPay', refId: ev.ca.id,
            label: `分红到账 ${p.symbol} ${amount} ${ev.ca.ccy}`,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  applyTrade(st, ev) {
    const t = ev.trade;
    // 关联费用折算到成交币种（规则：费用币种≠成交币种时按成交日汇率折算，缺汇率记错误）
    let feeTotal = 0;
    const feeItems = [];
    for (const f of ev.fees) {
      if (f.ccy === t.ccy) {
        feeTotal += f.amount;
        feeItems.push({ feeId: f.id, type: f.type, amount: f.amount, ccy: f.ccy, amountInTradeCcy: f.amount });
      } else {
        const fx = this.fxAt(f.ccy, t.ccy, t.date);
        if (!fx) {
          st.errors.push({
            type: 'FEE_FX_MISSING', tradeId: t.id, feeId: f.id, date: t.date,
            message: `费用 ${f.id} 缺少 ${f.ccy}->${t.ccy} 汇率，未计入成本`,
          });
          continue;
        }
        const conv = r6(f.amount * fx.rate);
        feeTotal += conv;
        feeItems.push({ feeId: f.id, type: f.type, amount: f.amount, ccy: f.ccy, amountInTradeCcy: conv, fxRate: fx.rate });
      }
    }
    feeTotal = r6(feeTotal);
    const gross = r6(t.qty * t.price);

    if (t.side === 'BUY') {
      const cost = r6(gross + feeTotal);
      const lot = {
        id: `lot-${t.id}`,
        tradeId: t.id,
        symbol: t.symbol,
        date: t.date,
        qty: t.qty,
        remaining: t.qty,
        unitCost: r6(cost / t.qty),
        ccy: t.ccy,
      };
      if (!st.lots.has(t.symbol)) st.lots.set(t.symbol, []);
      st.lots.get(t.symbol).push(lot);
      this.addCash(st, t.ccy, -cost);
      this.addCashflow(st, {
        date: t.date, type: 'BUY', ccy: t.ccy, amount: -cost,
        refType: 'trade', refId: t.id,
        label: `买入 ${t.symbol} ${t.qty}股 @${t.price}（含费用 ${feeTotal}）`,
        gross, fee: feeTotal,
      });
      st.log.push({ date: t.date, kind: 'trade', refId: t.id, label: `买入 ${t.symbol} ${t.qty} @${t.price} ${t.ccy}` });
      return;
    }

    // SELL —— 仅现货多头：超出持仓记错误并跳过
    const held = this.qtyOf(st, t.symbol);
    if (t.qty > held + EPS) {
      st.errors.push({
        type: 'OVERSELL', tradeId: t.id, date: t.date, symbol: t.symbol,
        qty: t.qty, held,
        message: `卖出 ${t.qty} 股超过持仓 ${held} 股，已跳过（本系统仅支持现货多头，不做空）`,
      });
      st.log.push({ date: t.date, kind: 'error', refId: t.id, label: `卖出 ${t.symbol} ${t.qty} 超持仓，已报错跳过` });
      return;
    }

    let need = t.qty;
    const consumptions = [];
    for (const lot of st.lots.get(t.symbol) ?? []) {
      if (need <= EPS) break;
      if (lot.remaining <= EPS) continue;
      const take = Math.min(lot.remaining, need);
      lot.remaining = r6(lot.remaining - take);
      need = r6(need - take);
      const feeAlloc = r6((feeTotal * take) / t.qty); // 卖出费用按消耗数量占比分摊
      const proceeds = r6(take * t.price);
      const cost = r6(take * lot.unitCost);
      consumptions.push({
        lotId: lot.id,
        lotTradeId: lot.tradeId,
        lotDate: lot.date,
        take: r6(take),
        unitCost: lot.unitCost,
        proceeds,
        feeAlloc,
        cost,
        pnl: r6(proceeds - feeAlloc - cost),
      });
    }
    const pnlTotal = r6(consumptions.reduce((s, c) => s + c.pnl, 0));
    const fx = this.fxAt(t.ccy, this.reportCcy, t.date); // 已实现盈亏按成交日汇率折算
    st.realized.push({
      id: `rl${++st.seq}`,
      tradeId: t.id,
      date: t.date,
      symbol: t.symbol,
      qty: t.qty,
      price: t.price,
      gross,
      feeTotal,
      feeItems,
      pnl: pnlTotal,
      ccy: t.ccy,
      fxRate: fx ? fx.rate : null,
      fxDate: fx ? fx.date : null,
      pnlReport: fx ? r6(pnlTotal * fx.rate) : null,
      consumptions,
    });
    if (!fx) {
      st.missing.push({ type: 'FX', from: t.ccy, to: this.reportCcy, date: t.date, for: `realized:${t.id}` });
    }
    const net = r6(gross - feeTotal);
    this.addCash(st, t.ccy, net);
    this.addCashflow(st, {
      date: t.date, type: 'SELL', ccy: t.ccy, amount: net,
      refType: 'trade', refId: t.id,
      label: `卖出 ${t.symbol} ${t.qty}股 @${t.price}（扣费用 ${feeTotal}）`,
      gross, fee: feeTotal,
    });
    st.log.push({ date: t.date, kind: 'trade', refId: t.id, label: `卖出 ${t.symbol} ${t.qty} @${t.price} ${t.ccy}` });
  }

  // 估值：持仓市值 + 现金，折算报告币；缺价/缺汇率进 missing，不估算
  valuate(st, asOf) {
    const missing = [];
    const positions = [];
    for (const [symbol, lots] of st.lots) {
      const open = lots.filter((l) => l.remaining > EPS);
      const qty = r6(open.reduce((s, l) => s + l.remaining, 0));
      if (qty <= EPS) continue;
      const inst = this.instruments.get(symbol);
      const ccy = inst?.ccy ?? open[0].ccy;
      const costBasis = r6(open.reduce((s, l) => s + l.remaining * l.unitCost, 0));
      const px = this.priceAt(symbol, asOf);
      const fx = this.fxAt(ccy, this.reportCcy, asOf);
      let mv = null;
      let unreal = null;
      if (px) {
        mv = r6(qty * px.close);
        unreal = r6(mv - costBasis);
      } else {
        missing.push({ type: 'PRICE', symbol, date: asOf, for: `position:${symbol}` });
      }
      if (!fx) missing.push({ type: 'FX', from: ccy, to: this.reportCcy, date: asOf, for: `position:${symbol}` });
      positions.push({
        symbol,
        name: inst?.name ?? symbol,
        ccy,
        qty,
        avgCost: r6(costBasis / qty),
        costBasis,
        price: px ? px.close : null,
        priceDate: px ? px.date : null,
        mv,
        fxRate: fx ? fx.rate : null,
        fxDate: fx ? fx.date : null,
        mvReport: mv != null && fx ? r6(mv * fx.rate) : null,
        unreal,
        unrealReport: unreal != null && fx ? r6(unreal * fx.rate) : null,
        lots: open.map((l) => ({
          lotId: l.id, tradeId: l.tradeId, date: l.date,
          qty: l.qty, remaining: l.remaining, unitCost: l.unitCost,
        })),
      });
    }
    const cash = [];
    for (const [ccy, amount] of st.cash) {
      if (Math.abs(amount) < EPS) continue;
      const fx = this.fxAt(ccy, this.reportCcy, asOf);
      if (!fx) missing.push({ type: 'FX', from: ccy, to: this.reportCcy, date: asOf, for: `cash:${ccy}` });
      cash.push({
        ccy,
        amount: r6(amount),
        fxRate: fx ? fx.rate : null,
        fxDate: fx ? fx.date : null,
        amountReport: fx ? r6(amount * fx.rate) : null,
      });
    }
    const sum = (rows, k) => r6(rows.reduce((s, r) => s + (r[k] ?? 0), 0));
    const totals = {
      cashReport: sum(cash, 'amountReport'),
      positionsReport: sum(positions, 'mvReport'),
      costReport: null,
      unrealizedReport: sum(positions, 'unrealReport'),
      realizedReport: sum(st.realized, 'pnlReport'),
    };
    totals.totalReport = r6(totals.cashReport + totals.positionsReport);
    return { positions, cash, totals, missing };
  }

  // 全量计算：返回指定账户截至 asOf 的完整状态
  computeState(accountId, asOf) {
    const st = this.newState();
    for (const ev of this.buildEvents(accountId, asOf)) this.applyEvent(st, ev);
    const { positions, cash, totals, missing } = this.valuate(st, asOf);
    // 合并事件期缺口（如现金流折算缺汇率）与估值缺口，按键去重
    const seen = new Set();
    const allMissing = [];
    for (const m of [...st.missing, ...missing]) {
      const key = `${m.type}|${m.symbol ?? ''}|${m.from ?? ''}|${m.for ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      allMissing.push(m);
    }
    return {
      accountId,
      asOf,
      reportCcy: this.reportCcy,
      positions,
      cash,
      totals,
      realized: st.realized,
      cashflows: st.cashflows,
      errors: st.errors,
      missing: allMissing,
      events: st.log,
    };
  }

  // 时间轴：每个事件日/行情日/汇率日的资产快照（用于按时间推进核对）
  computeTimeline(accountId) {
    const ds = this.ds;
    const last = this.lastDate();
    const events = this.buildEvents(accountId, last);
    const dateSet = new Set(events.map((e) => e.date));
    for (const p of ds.prices ?? []) if (p.date <= last) dateSet.add(p.date);
    for (const r of ds.fxRates ?? []) if (r.date <= last) dateSet.add(r.date);
    const dates = [...dateSet].sort();
    const st = this.newState();
    const points = [];
    let ei = 0;
    for (const d of dates) {
      const dayEvents = [];
      while (ei < events.length && events[ei].date <= d) {
        const before = st.log.length;
        this.applyEvent(st, events[ei]);
        for (let i = before; i < st.log.length; i++) dayEvents.push(st.log[i]);
        ei++;
      }
      const { totals, missing } = this.valuate(st, d);
      points.push({
        date: d,
        totalReport: totals.totalReport,
        cashReport: totals.cashReport,
        positionsReport: totals.positionsReport,
        realizedReport: totals.realizedReport,
        missingCount: missing.length,
        errorCount: st.errors.length,
        events: dayEvents.map((l) => l.label),
      });
    }
    return points;
  }
}

export function computeState(dataset, accountId, asOf) {
  return new Engine(dataset).computeState(accountId, asOf);
}

export function computeTimeline(dataset, accountId) {
  return new Engine(dataset).computeTimeline(accountId);
}
