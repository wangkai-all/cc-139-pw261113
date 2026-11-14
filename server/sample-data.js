// 随项目自带的小型行情与交易样本（合成数据，不依赖任何实时证券接口）。
// 故事线（报告币：CNY）：
//  - 主账户 acc_main：AAPL 两笔买入 → 部分卖出（FIFO 消耗两个批次）→ 1拆4 → 再买卖；
//    腾讯（港元）买入后收现金分红再部分卖出；茅台（人民币）买入后收现金分红；
//    DEMO.US 永远缺行情，用于演示「缺价单独显示」。
//  - 备用账户 acc_margin：仅一笔腾讯买入，用于演示按账户查看。
// 所有数字均为确定值，README 的核对演练可手工复算。

const FX = {
  // date: [USD->CNY, HKD->CNY]
  '2024-01-12': [7.1480, 0.9128],
  '2024-01-15': [7.1500, 0.9130],
  '2024-01-31': [7.1600, 0.9140],
  '2024-02-01': [7.1580, 0.9138],
  '2024-02-29': [7.1700, 0.9150],
  '2024-03-05': [7.1650, 0.9145],
  '2024-03-10': [7.1680, 0.9148],
  '2024-03-31': [7.1800, 0.9160],
  '2024-04-08': [7.1880, 0.9168],
  '2024-04-10': [7.1900, 0.9170],
  '2024-04-30': [7.2000, 0.9180],
  '2024-05-10': [7.2050, 0.9185],
  '2024-05-15': [7.2100, 0.9190],
  '2024-05-31': [7.2200, 0.9200],
  '2024-06-20': [7.2300, 0.9210],
  '2024-06-30': [7.2400, 0.9220],
  '2024-07-01': [7.2450, 0.9225],
  '2024-07-15': [7.2500, 0.9230],
  '2024-07-31': [7.2600, 0.9240],
  '2024-08-10': [7.2700, 0.9250],
  '2024-08-12': [7.2720, 0.9252],
  '2024-08-20': [7.2750, 0.9255],
  '2024-08-31': [7.2800, 0.9260],
  '2024-09-02': [7.2850, 0.9265],
  '2024-09-30': [7.2900, 0.9270],
  '2024-10-31': [7.3000, 0.9280],
  '2024-11-05': [7.3050, 0.9285],
  '2024-11-08': [7.3080, 0.9288],
  '2024-11-15': [7.3100, 0.9290],
  '2024-11-30': [7.3150, 0.9295],
  '2024-12-31': [7.3200, 0.9300],
  '2025-01-20': [7.3300, 0.9310],
  '2025-01-31': [7.3350, 0.9315],
  '2025-02-28': [7.3400, 0.9320],
  '2025-03-31': [7.3500, 0.9330],
};

const PRICES = {
  // AAPL 为未复权收盘价：2024-09-02 拆股后价格断崖是真实市场口径，由拆股公司行动解释
  AAPL: {
    '2024-01-15': 180, '2024-01-31': 182, '2024-02-29': 185, '2024-03-10': 195,
    '2024-03-31': 192, '2024-04-30': 198, '2024-05-31': 205, '2024-06-20': 210,
    '2024-06-30': 208, '2024-07-31': 215, '2024-08-31': 220, '2024-09-02': 55,
    '2024-09-30': 56, '2024-10-31': 54, '2024-11-05': 55, '2024-11-30': 57,
    '2024-12-31': 58, '2025-01-20': 60, '2025-01-31': 61, '2025-02-28': 59,
    '2025-03-31': 62,
  },
  '00700.HK': {
    '2024-02-01': 280, '2024-02-29': 285, '2024-03-31': 290, '2024-04-10': 300,
    '2024-04-30': 300, '2024-05-15': 305, '2024-05-31': 310, '2024-06-30': 315,
    '2024-07-31': 320, '2024-08-10': 330, '2024-08-31': 332, '2024-09-30': 340,
    '2024-10-31': 335, '2024-11-30': 345, '2024-12-31': 350, '2025-01-31': 355,
    '2025-02-28': 360, '2025-03-31': 365,
  },
  '600519.SH': {
    '2024-03-05': 1700, '2024-03-31': 1710, '2024-04-30': 1690, '2024-05-31': 1720,
    '2024-06-30': 1680, '2024-07-01': 1685, '2024-07-31': 1750, '2024-08-31': 1760,
    '2024-09-30': 1800, '2024-10-31': 1780, '2024-11-30': 1820, '2024-12-31': 1850,
    '2025-01-31': 1860, '2025-02-28': 1840, '2025-03-31': 1880,
  },
  // DEMO.US 故意不提供任何行情 -> 持仓始终「缺价」
};

export function buildSampleDataset() {
  const fxRates = [];
  for (const [date, [usd, hkd]] of Object.entries(FX)) {
    fxRates.push({ from: 'USD', to: 'CNY', date, rate: usd });
    fxRates.push({ from: 'HKD', to: 'CNY', date, rate: hkd });
  }
  const prices = [];
  for (const [symbol, rows] of Object.entries(PRICES)) {
    for (const [date, close] of Object.entries(rows)) prices.push({ symbol, date, close });
  }
  return {
    reportCcy: 'CNY',
    accounts: [
      { id: 'acc_main', name: '主账户' },
      { id: 'acc_margin', name: '备用账户' },
    ],
    instruments: [
      { symbol: 'AAPL', name: '苹果公司', ccy: 'USD', market: 'NASDAQ' },
      { symbol: '00700.HK', name: '腾讯控股', ccy: 'HKD', market: 'HKEX' },
      { symbol: '600519.SH', name: '贵州茅台', ccy: 'CNY', market: 'SSE' },
      { symbol: 'DEMO.US', name: '演示缺价股', ccy: 'USD', market: 'NASDAQ' },
    ],
    deposits: [
      { id: 'd1', accountId: 'acc_main', date: '2024-01-12', ccy: 'CNY', amount: 1500000, note: '初始入金' },
      { id: 'd2', accountId: 'acc_main', date: '2024-01-12', ccy: 'USD', amount: 40000, note: '初始入金' },
      { id: 'd3', accountId: 'acc_main', date: '2024-01-12', ccy: 'HKD', amount: 200000, note: '初始入金' },
      { id: 'd4', accountId: 'acc_margin', date: '2024-04-08', ccy: 'HKD', amount: 50000, note: '初始入金' },
    ],
    trades: [
      { id: 't1', accountId: 'acc_main', symbol: 'AAPL', side: 'BUY', qty: 100, price: 180, ccy: 'USD', date: '2024-01-15' },
      { id: 't2', accountId: 'acc_main', symbol: '00700.HK', side: 'BUY', qty: 500, price: 280, ccy: 'HKD', date: '2024-02-01' },
      { id: 't3', accountId: 'acc_main', symbol: '600519.SH', side: 'BUY', qty: 10, price: 1700, ccy: 'CNY', date: '2024-03-05' },
      { id: 't4', accountId: 'acc_main', symbol: 'AAPL', side: 'BUY', qty: 60, price: 195, ccy: 'USD', date: '2024-03-10' },
      { id: 't5', accountId: 'acc_margin', symbol: '00700.HK', side: 'BUY', qty: 100, price: 300, ccy: 'HKD', date: '2024-04-10' },
      { id: 't6', accountId: 'acc_main', symbol: 'DEMO.US', side: 'BUY', qty: 10, price: 5, ccy: 'USD', date: '2024-05-10' },
      { id: 't7', accountId: 'acc_main', symbol: 'AAPL', side: 'SELL', qty: 120, price: 210, ccy: 'USD', date: '2024-06-20' },
      { id: 't8', accountId: 'acc_main', symbol: '00700.HK', side: 'SELL', qty: 200, price: 330, ccy: 'HKD', date: '2024-08-10' },
      { id: 't9', accountId: 'acc_main', symbol: 'AAPL', side: 'BUY', qty: 50, price: 55, ccy: 'USD', date: '2024-11-05' },
      { id: 't10', accountId: 'acc_main', symbol: 'AAPL', side: 'SELL', qty: 100, price: 60, ccy: 'USD', date: '2025-01-20' },
    ],
    fees: [
      { id: 'f1', accountId: 'acc_main', tradeId: 't1', type: '佣金', amount: 5, ccy: 'USD', date: '2024-01-15' },
      { id: 'f2', accountId: 'acc_main', tradeId: 't2', type: '佣金', amount: 140, ccy: 'HKD', date: '2024-02-01' },
      { id: 'f3', accountId: 'acc_main', tradeId: 't2', type: '印花税', amount: 14, ccy: 'HKD', date: '2024-02-01' },
      { id: 'f4', accountId: 'acc_main', tradeId: 't3', type: '佣金', amount: 5, ccy: 'CNY', date: '2024-03-05' },
      { id: 'f5', accountId: 'acc_main', tradeId: 't4', type: '佣金', amount: 5, ccy: 'USD', date: '2024-03-10' },
      { id: 'f6', accountId: 'acc_margin', tradeId: 't5', type: '佣金', amount: 30, ccy: 'HKD', date: '2024-04-10' },
      { id: 'f7', accountId: 'acc_main', tradeId: 't6', type: '佣金', amount: 1, ccy: 'USD', date: '2024-05-10' },
      { id: 'f8', accountId: 'acc_main', tradeId: 't7', type: '佣金', amount: 5, ccy: 'USD', date: '2024-06-20' },
      { id: 'f9', accountId: 'acc_main', tradeId: 't8', type: '佣金', amount: 100, ccy: 'HKD', date: '2024-08-10' },
      { id: 'f10', accountId: 'acc_main', tradeId: 't8', type: '印花税', amount: 33, ccy: 'HKD', date: '2024-08-10' },
      { id: 'f11', accountId: 'acc_main', tradeId: 't9', type: '佣金', amount: 2, ccy: 'USD', date: '2024-11-05' },
      { id: 'f12', accountId: 'acc_main', tradeId: 't10', type: '佣金', amount: 2, ccy: 'USD', date: '2025-01-20' },
      // 不关联成交的独立费用：只影响现金流，不分摊到批次成本
      { id: 'f20', accountId: 'acc_main', tradeId: null, type: '账户管理费', amount: 50, ccy: 'CNY', date: '2024-12-31' },
    ],
    corporateActions: [
      { id: 'ca1', symbol: 'AAPL', type: 'SPLIT', ratio: 4, exDate: '2024-09-02' },
      { id: 'ca2', symbol: '00700.HK', type: 'DIVIDEND', dps: 3.4, ccy: 'HKD', exDate: '2024-05-15', payDate: '2024-05-31' },
      { id: 'ca3', symbol: '600519.SH', type: 'DIVIDEND', dps: 30.876, ccy: 'CNY', exDate: '2024-07-01', payDate: '2024-07-15' },
      { id: 'ca4', symbol: 'AAPL', type: 'DIVIDEND', dps: 0.25, ccy: 'USD', exDate: '2024-08-12', payDate: '2024-08-20' },
      { id: 'ca5', symbol: 'AAPL', type: 'DIVIDEND', dps: 0.0625, ccy: 'USD', exDate: '2024-11-08', payDate: '2024-11-15' },
    ],
    prices,
    fxRates,
    reversals: [],
  };
}
