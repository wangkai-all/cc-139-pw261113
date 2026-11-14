import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, computeState, r6 } from '../server/engine.js';
import { buildSampleDataset } from '../server/sample-data.js';

const ds = () => buildSampleDataset();
const closeTo = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('FIFO：部分卖出按先进先出消耗批次，剩余批次保留', () => {
  const st = computeState(ds(), 'acc_main', '2024-06-30');
  const r = st.realized.find((x) => x.tradeId === 't7');
  assert.ok(r, 't7 应产生已实现盈亏');
  assert.equal(r.consumptions.length, 2);
  // 先消耗 t1 的 100 股（单位成本含费用 180.05），再消耗 t4 的 20 股
  const [c1, c2] = r.consumptions;
  assert.equal(c1.lotTradeId, 't1');
  assert.equal(c1.take, 100);
  closeTo(c1.unitCost, 180.05);
  assert.equal(c2.lotTradeId, 't4');
  assert.equal(c2.take, 20);
  closeTo(c2.unitCost, 195.083333, 1e-4);
  // t4 批次剩余 40 股保留
  const aapl = st.positions.find((p) => p.symbol === 'AAPL');
  assert.equal(aapl.qty, 40);
  assert.equal(aapl.lots.length, 1);
  assert.equal(aapl.lots[0].tradeId, 't4');
  assert.equal(aapl.lots[0].remaining, 40);
});

test('费用分摊：买入费用计入单位成本，卖出费用按数量占比分摊到批次', () => {
  const st = computeState(ds(), 'acc_main', '2024-06-30');
  const r = st.realized.find((x) => x.tradeId === 't7');
  const [c1, c2] = r.consumptions;
  // 卖出费用 5 USD 按 100:20 分摊
  closeTo(c1.feeAlloc, (5 * 100) / 120);
  closeTo(c2.feeAlloc, (5 * 20) / 120);
  closeTo(c1.feeAlloc + c2.feeAlloc, 5);
  // 批次盈亏 = 卖出收入 - 分摊费用 - 批次成本
  closeTo(c1.pnl, 100 * 210 - c1.feeAlloc - 100 * 180.05);
  closeTo(c2.pnl, 20 * 210 - c2.feeAlloc - 20 * 195.083333, 1e-3);
  closeTo(r.pnl, 3288.333333, 1e-3);
});

test('拆股：数量×比例、单位成本÷比例，拆后卖出用调整后的成本', () => {
  const before = computeState(ds(), 'acc_main', '2024-09-01');
  const after = computeState(ds(), 'acc_main', '2024-09-02');
  const b = before.positions.find((p) => p.symbol === 'AAPL');
  const a = after.positions.find((p) => p.symbol === 'AAPL');
  assert.equal(b.qty, 40);
  assert.equal(a.qty, 160);
  closeTo(a.avgCost, b.avgCost / 4);
  closeTo(a.costBasis, b.costBasis, 1e-3); // 成本总额不变
  // 拆股后卖出（t10: 100股 @60，费用2）：成本按 48.770833 计
  const end = computeState(ds(), 'acc_main', '2025-03-31');
  const r = end.realized.find((x) => x.tradeId === 't10');
  assert.equal(r.consumptions.length, 1);
  closeTo(r.consumptions[0].unitCost, 195.083333 / 4, 1e-4);
  closeTo(r.pnl, 100 * 60 - 2 - 100 * (195.083333 / 4), 1e-3);
});

test('现金分红：独立现金流，不进入批次成本与已实现盈亏', () => {
  const st = computeState(ds(), 'acc_main', '2024-12-31');
  const divs = st.cashflows.filter((c) => c.type === 'DIVIDEND');
  assert.equal(divs.length, 4); // 腾讯 1700 HKD、茅台 308.76 CNY、AAPL 10 USD 与 13.125 USD
  const tencent = divs.find((d) => d.refId === 'ca2');
  assert.equal(tencent.amount, 500 * 3.4);
  assert.equal(tencent.ccy, 'HKD');
  const moutai = divs.find((d) => d.refId === 'ca3');
  closeTo(moutai.amount, 10 * 30.876);
  // 分红不计入已实现盈亏：realized 全部来自卖出成交
  assert.ok(st.realized.every((r) => r.tradeId));
});

test('分红后批次成本不变（精确值）', () => {
  const st = computeState(ds(), 'acc_main', '2024-12-31');
  const aapl = st.positions.find((p) => p.symbol === 'AAPL');
  // 160 股 @ 48.770833 + 50 股 @ 55.04
  closeTo(aapl.costBasis, 160 * (195.083333 / 4) + 50 * 55.04, 1e-2);
});

test('多币种：交易币与报告币分别保存；已实现用成交日汇率，估值用估值日汇率', () => {
  const st = computeState(ds(), 'acc_main', '2025-03-31');
  const r = st.realized.find((x) => x.tradeId === 't7');
  assert.equal(r.ccy, 'USD');
  assert.equal(r.fxDate, '2024-06-20'); // 成交日汇率
  assert.equal(r.fxRate, 7.23);
  closeTo(r.pnlReport, r.pnl * 7.23, 1e-2);
  // 估值日用估值日汇率
  const aapl = st.positions.find((p) => p.symbol === 'AAPL');
  assert.equal(aapl.fxDate, '2025-03-31');
  assert.equal(aapl.fxRate, 7.35);
  closeTo(aapl.mvReport, aapl.mv * 7.35, 1e-2);
  // 现金分币种保存
  const usd = st.cash.find((c) => c.ccy === 'USD');
  assert.ok(usd.amount > 0);
  closeTo(usd.amountReport, usd.amount * 7.35, 1e-2);
});

test('缺价单独显示：DEMO.US 无行情，进数据缺口且不计入总资产', () => {
  const st = computeState(ds(), 'acc_main', '2025-03-31');
  const demo = st.positions.find((p) => p.symbol === 'DEMO.US');
  assert.ok(demo, 'DEMO.US 持仓仍在');
  assert.equal(demo.mv, null);
  assert.equal(demo.mvReport, null);
  assert.ok(st.missing.some((m) => m.type === 'PRICE' && m.symbol === 'DEMO.US'));
  // 总资产只汇总可估值部分
  const sumMv = st.positions.reduce((s, p) => s + (p.mvReport ?? 0), 0);
  const sumCash = st.cash.reduce((s, c) => s + (c.amountReport ?? 0), 0);
  closeTo(st.totals.totalReport, r6(sumMv + sumCash), 1e-2);
});

test('缺汇率单独显示：无汇率记录时折算结果为 null 并列入缺口', () => {
  const d = ds();
  d.fxRates = d.fxRates.filter((x) => x.from !== 'HKD'); // 删掉全部 HKD 汇率
  const st = computeState(d, 'acc_main', '2024-03-31');
  const hk = st.positions.find((p) => p.symbol === '00700.HK');
  assert.equal(hk.mvReport, null);
  assert.ok(st.missing.some((m) => m.type === 'FX' && m.from === 'HKD'));
});

test('仅现货多头：超出持仓的卖出报错并跳过，不做空', () => {
  const d = ds();
  d.trades.push({ id: 'tx', accountId: 'acc_main', symbol: 'AAPL', side: 'SELL', qty: 9999, price: 100, ccy: 'USD', date: '2025-02-10' });
  const st = computeState(d, 'acc_main', '2025-03-31');
  const err = st.errors.find((e) => e.type === 'OVERSELL' && e.tradeId === 'tx');
  assert.ok(err, '应记录超卖错误');
  // 持仓未被扣成负数
  const aapl = st.positions.find((p) => p.symbol === 'AAPL');
  assert.ok(aapl.qty > 0);
  // 该笔不产生现金流与已实现盈亏
  assert.ok(!st.cashflows.some((c) => c.refId === 'tx'));
  assert.ok(!st.realized.some((r) => r.tradeId === 'tx'));
});

test('现金流：买入扣款、卖出回款、分红与独立费用各自成行', () => {
  const st = computeState(ds(), 'acc_main', '2024-02-29');
  const buy = st.cashflows.find((c) => c.refId === 't2');
  assert.equal(buy.type, 'BUY');
  assert.equal(buy.amount, -(500 * 280 + 154)); // 含佣金与印花税
  const dep = st.cashflows.find((c) => c.refId === 'd3');
  assert.equal(dep.amount, 200000);
  const hkd = st.cash.find((c) => c.ccy === 'HKD');
  closeTo(hkd.amount, 200000 - 140154);
  // 独立费用
  const st2 = computeState(ds(), 'acc_main', '2024-12-31');
  const fee = st2.cashflows.find((c) => c.refId === 'f20');
  assert.equal(fee.type, 'FEE');
  assert.equal(fee.amount, -50);
});

test('按账户隔离：备用账户只有自己的持仓与现金', () => {
  const st = computeState(ds(), 'acc_margin', '2025-03-31');
  assert.equal(st.positions.length, 1);
  assert.equal(st.positions[0].symbol, '00700.HK');
  assert.equal(st.positions[0].qty, 100);
  assert.equal(st.cash.length, 1);
  assert.equal(st.cash[0].ccy, 'HKD');
  // 50000 入金 - 30030 买入（含佣金）+ 340 腾讯分红（除息日持有 100 股 × 3.4）
  closeTo(st.cash[0].amount, 50000 - 30030 + 340);
});

test('时间轴：拆股前后与卖出前后总资产可逐日核对', () => {
  const tl = new Engine(ds()).computeTimeline('acc_main');
  const at = (date) => tl.find((p) => p.date === date);
  // 拆股当天有事件说明，且总市值不因拆股跳变（数量×4、价格÷4）
  const splitDay = at('2024-09-02');
  assert.ok(splitDay.events.some((e) => e.includes('拆股')));
  const prev = at('2024-08-31');
  closeTo(splitDay.positionsReport, prev.positionsReport, Math.abs(prev.positionsReport) * 0.02 + 1);
  // 卖出日现金增加、持仓市值下降
  const sellDay = at('2025-01-20');
  const beforeSell = at('2024-12-31');
  assert.ok(sellDay.cashReport > beforeSell.cashReport);
  assert.ok(sellDay.events.some((e) => e.includes('卖出')));
});

test('冲正：被冲正记录不参与计算，更正记录生效（通过 store 层生成新版本）', async () => {
  const { resetToSample, loadCurrent, createVersion } = await import('../server/store.js');
  resetToSample();
  const { dataset } = loadCurrent();
  const next = structuredClone(dataset);
  const t10 = next.trades.find((t) => t.id === 't10');
  t10.reversedBy = 'rev_test';
  next.trades.push({ id: 't10r', accountId: 'acc_main', symbol: 'AAPL', side: 'SELL', qty: 80, price: 60, ccy: 'USD', date: '2025-01-20' });
  next.fees.push({ id: 'f12r', accountId: 'acc_main', tradeId: 't10r', type: '佣金', amount: 2, ccy: 'USD', date: '2025-01-20' });
  next.reversals.push({ id: 'rev_test', targetType: 'trade', targetId: 't10', reason: '测试', replacementId: 't10r', createdAt: new Date().toISOString() });
  const { n } = createVersion(next, 'REVERSAL', '冲正 t10 并更正为 80 股');
  assert.equal(n, 2);
  const st = computeState(next, 'acc_main', '2025-03-31');
  assert.ok(!st.realized.some((r) => r.tradeId === 't10'), 't10 已被冲正');
  const r = st.realized.find((x) => x.tradeId === 't10r');
  assert.ok(r, '更正成交生效');
  assert.equal(r.qty, 80);
  closeTo(r.pnl, 80 * 60 - 2 - 80 * (195.083333 / 4), 1e-3);
  resetToSample(); // 还原数据目录
});
