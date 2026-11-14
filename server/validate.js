// 导入记录的字段校验：任何一条不合法即整体拒绝，不产生半个版本。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPosNum(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function check(row, rules, label, errors) {
  for (const [field, ok, msg] of rules) {
    if (!ok(row[field])) errors.push(`${label} 字段 ${field} 不合法：${msg}（收到 ${JSON.stringify(row[field])}）`);
  }
}

const reqStr = (v) => typeof v === 'string' && v.length > 0;
const reqDate = (v) => typeof v === 'string' && DATE_RE.test(v);
const optStr = (v) => v === undefined || v === null || typeof v === 'string';
const posNum = (v) => isPosNum(v);
const nonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function validateRecords(records) {
  const errors = [];
  const r = records ?? {};
  for (const t of r.trades ?? []) {
    check(t, [
      ['accountId', reqStr, '必填字符串'],
      ['symbol', reqStr, '必填字符串'],
      ['side', (v) => v === 'BUY' || v === 'SELL', '必须是 BUY 或 SELL'],
      ['qty', posNum, '必须为正数'],
      ['price', posNum, '必须为正数'],
      ['ccy', reqStr, '必填字符串（交易币种）'],
      ['date', reqDate, '格式 YYYY-MM-DD'],
      ['id', optStr, '可选字符串'],
    ], `成交 ${t.id ?? '(无id)'}`, errors);
  }
  for (const f of r.fees ?? []) {
    check(f, [
      ['accountId', reqStr, '必填字符串'],
      ['type', reqStr, '必填字符串（费用类型）'],
      ['amount', nonNegNum, '必须为非负数'],
      ['ccy', reqStr, '必填字符串'],
      ['date', reqDate, '格式 YYYY-MM-DD'],
      ['tradeId', optStr, '关联成交 id 或 null（独立费用）'],
    ], `费用 ${f.id ?? '(无id)'}`, errors);
  }
  for (const c of r.corporateActions ?? []) {
    if (c.type === 'SPLIT') {
      check(c, [
        ['symbol', reqStr, '必填字符串'],
        ['ratio', posNum, '拆股比例必须为正数（如 4 表示 1拆4）'],
        ['exDate', reqDate, '格式 YYYY-MM-DD'],
      ], `公司行动 ${c.id ?? '(无id)'}`, errors);
    } else if (c.type === 'DIVIDEND') {
      check(c, [
        ['symbol', reqStr, '必填字符串'],
        ['dps', nonNegNum, '每股分红必须为非负数'],
        ['ccy', reqStr, '必填字符串'],
        ['exDate', reqDate, '格式 YYYY-MM-DD'],
        ['payDate', (v) => v === undefined || reqDate(v), '格式 YYYY-MM-DD'],
      ], `公司行动 ${c.id ?? '(无id)'}`, errors);
    } else {
      errors.push(`公司行动 ${c.id ?? '(无id)'} 类型不合法：${c.type}（支持 SPLIT / DIVIDEND）`);
    }
  }
  for (const p of r.prices ?? []) {
    check(p, [
      ['symbol', reqStr, '必填字符串'],
      ['date', reqDate, '格式 YYYY-MM-DD'],
      ['close', posNum, '必须为正数'],
    ], `行情 ${p.symbol ?? '?'}`, errors);
  }
  for (const x of r.fxRates ?? []) {
    check(x, [
      ['from', reqStr, '必填字符串'],
      ['to', reqStr, '必填字符串'],
      ['date', reqDate, '格式 YYYY-MM-DD'],
      ['rate', posNum, '必须为正数'],
    ], `汇率 ${x.from ?? '?'}->${x.to ?? '?'}`, errors);
  }
  for (const d of r.deposits ?? []) {
    check(d, [
      ['accountId', reqStr, '必填字符串'],
      ['date', reqDate, '格式 YYYY-MM-DD'],
      ['ccy', reqStr, '必填字符串'],
      ['amount', posNum, '必须为正数'],
    ], `入金 ${d.id ?? '(无id)'}`, errors);
  }
  return errors;
}

// 合并导入：追加记录并分配 id；同 id 视为重复，拒绝
export function mergeRecords(dataset, records) {
  const next = structuredClone(dataset);
  const seen = {
    trades: new Set(next.trades.map((x) => x.id)),
    fees: new Set(next.fees.map((x) => x.id)),
    corporateActions: new Set(next.corporateActions.map((x) => x.id)),
    deposits: new Set(next.deposits.map((x) => x.id)),
  };
  const dup = [];
  const pushAll = (key, rows, prefix) => {
    for (const row of rows ?? []) {
      if (row.id && seen[key].has(row.id)) {
        dup.push(row.id);
        continue;
      }
      const id = row.id ?? `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
      next[key].push({ ...row, id });
      seen[key].add(id);
    }
  };
  pushAll('trades', records.trades, 't');
  pushAll('fees', records.fees, 'f');
  pushAll('corporateActions', records.corporateActions, 'ca');
  pushAll('deposits', records.deposits, 'd');
  // 行情与汇率按 (symbol,date)/(from,to,date) 覆盖更新
  const pxKey = (p) => `${p.symbol}|${p.date}`;
  const pxMap = new Map(next.prices.map((p) => [pxKey(p), p]));
  for (const p of records.prices ?? []) pxMap.set(pxKey(p), { ...p });
  next.prices = [...pxMap.values()];
  const fxKey = (x) => `${x.from}|${x.to}|${x.date}`;
  const fxMap = new Map(next.fxRates.map((x) => [fxKey(x), x]));
  for (const x of records.fxRates ?? []) fxMap.set(fxKey(x), { ...x });
  next.fxRates = [...fxMap.values()];
  return { next, dup };
}
