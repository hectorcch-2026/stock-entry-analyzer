const a = require('../lib/analyzer');

const SOURCE = process.env.DATA_SOURCE || 'auto';

(async () => {
  console.log(`\n=== 分析測試（DATA_SOURCE=${SOURCE}）===\n`);
  for (const s of ['AAPL', '0700.HK', '9988.HK', 'TSLA']) {
    const t = Date.now();
    try {
      const d = await a.analyze(s);
      console.log(
        s.padEnd(9) + 'OK ' + String(Date.now() - t).padStart(5) + 'ms' +
        ' | ' + String(d.meta.price).padStart(9) + ' ' + d.meta.currency +
        ' | 評分 ' + String(d.score).padStart(4) + ' ' + d.verdict.label +
        ' | 買區 ' + d.buyZone.lower.toFixed(2) + '~' + d.buyZone.upper.toFixed(2) +
        ' | 支撐' + d.levels.supports.length + ' 壓力' + d.levels.resistances.length +
        ' | 樣本' + String(d.backtest.samples).padStart(3) +
        ' | 上漲機率 ' + (d.probabilities.probUp20 * 100).toFixed(1) + '%' +
        ' | ' + d.dataSourceKey
      );
    } catch (e) {
      console.log(s.padEnd(9) + 'ERR ' + String(Date.now() - t).padStart(5) + 'ms | ' + (e.code || '') + ' ' + e.message);
    }
  }
})();
