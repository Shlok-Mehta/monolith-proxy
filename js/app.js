/* Monolith — app: routing, report rendering, watchlist, compare, settings. */
(function () {
  'use strict';
  const LG = window.LG;
  const U = LG.util;
  const E = LG.engine;
  const { $, $$, esc, money, pct, pctPlain, num, compact, dateLabel, signClass } = U;

  const state = {
    stock: null,
    analysis: null,
    opts: {},
    watch: normaliseWatch(U.store('watchlist')),
    busy: false
  };

  // Stored watchlists outlive code. Accept strings from the old shape, drop
  // blanks and duplicates, and always keep an uppercase symbol plus a name.
  function normaliseWatch(list) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const out = [];
    list.forEach((w) => {
      const symbol = String((w && w.symbol) || w || '').trim().toUpperCase();
      if (!symbol || seen.has(symbol)) return;
      seen.add(symbol);
      out.push({ symbol, name: (w && w.name) || symbol });
    });
    return out;
  }

  const cache = new Map();
  const indexCache = new Map();

  /* ---------------- small helpers ---------------- */

  const fv = (stock, key) => (stock.fields[key] ? stock.fields[key].value : null);
  const fsrc = (stock, key) => (stock.fields[key] ? stock.fields[key].source : '');

  function srcTag(stock, key) {
    const f = stock.fields[key];
    if (!f) return '<span class="tag na">N/A</span>';
    const s = f.source === 'you' ? '<span class="tag you">yours</span>' : `<span class="tag">${esc(shortSrc(f.source))}</span>`;
    return s;
  }

  function shortSrc(s) {
    return String(s || '').replace(/Yahoo, .* close/, 'exchange close').replace(/Screener\.in \(₹ cr\)/, 'Screener');
  }

  function valueCell(stock, key, fmt, extraClass) {
    const v = fv(stock, key);
    if (v == null) return `<td class="num"><span class="tag na">N/A</span></td>`;
    return `<td class="num ${extraClass || ''}">${fmt ? fmt(v) : num(v)}<span class="src">${esc(shortSrc(fsrc(stock, key)))}</span></td>`;
  }

  function kv(label, html, tag) {
    return `<div><span class="k">${esc(label)}</span><span class="v">${html} ${tag || ''}</span></div>`;
  }

  function trendBadge(text) {
    const cls = /Up/i.test(text) ? 'buy' : /Down|Weak/i.test(text) ? 'sell' : 'hold';
    return `<span class="badge ${cls}">${esc(text)}</span>`;
  }

  function ratingBadge(r) {
    const cls = /BUY/i.test(r) ? 'buy' : /SELL/i.test(r) ? 'sell' : 'hold';
    return `<span class="badge ${cls}">${esc(r)}</span>`;
  }

  const STAR = '●';
  const sources = (stock) => `
    <details class="more">
      <summary>Sources (${stock.provenance.length})</summary>
      <table class="tbl compact"><tbody>
      ${stock.provenance.map(p => `<tr><td>${esc(p.label)}${p.ok ? '' : ' — failed'}${p.note ? ': ' + esc(p.note) : ''}</td><td class="num">${esc(new Date(p.at).toLocaleString('en-GB'))}</td></tr>`).join('')}
      </tbody></table>
      <p class="hint">Route: ${esc(LG.data.Route.label)}. ${stock.isIndia ? 'India: prices from the exchange close, fundamentals from Screener.' : 'Non-Indian listing: price data only.'}</p>
    </details>`;

  /* ---------------- chart ---------------- */

  function priceChart(tech) {
    const closes = tech.closes.slice(-750);
    if (!closes.length) return '';
    const w = 800, h = 190, pad = 6;
    const min = Math.min.apply(null, closes), max = Math.max.apply(null, closes);
    const x = (i) => pad + (i / (closes.length - 1)) * (w - pad * 2);
    const y = (v) => pad + (1 - (v - min) / ((max - min) || 1)) * (h - pad * 2);
    const path = closes.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    const dma = (series) => {
      const s = series.slice(-750);
      return s.map((v, i) => (U.isNum(v) ? (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) : '')).filter(Boolean).join(' ');
    };
    const area = `${path} L ${x(closes.length - 1).toFixed(1)} ${h - pad} L ${x(0).toFixed(1)} ${h - pad} Z`;
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Price history with 20 and 50 day averages">
      <path d="${area}" fill="rgba(255,90,54,0.09)"></path>
      <path d="${dma(tech.maSeries.s50)}" fill="none" stroke="rgba(236,228,210,0.45)" stroke-width="1"></path>
      <path d="${dma(tech.maSeries.s20)}" fill="none" stroke="rgba(236,228,210,0.22)" stroke-width="1"></path>
      <path d="${path}" fill="none" stroke="#ece4d2" stroke-width="1.4"></path>
    </svg>
    <div class="chart-legend"><span><i style="background:#ece4d2"></i>close, 3y</span><span><i style="background:rgba(236,228,210,.45)"></i>50-DMA</span><span><i style="background:rgba(236,228,210,.22)"></i>20-DMA</span><span>${esc(dateLabel(tech.lastT))}</span></div>`;
  }

  /* ---------------- report ---------------- */

  function thesis(a) {
    const { stock, tech, val, rating, plan } = a;
    if (!val.ok) {
      return `<strong>${esc(rating)}</strong> on price action alone: ${esc(tech.trend.toLowerCase())}, ${pctPlain(tech.fromHigh, 1)} from the 52-week high, RSI ${num(tech.rsi14, 0)}. Valuation cannot be judged without earnings per share, so no target is issued.`;
    }
    const trendClause = tech.trend === 'Uptrend' ? 'and the daily trend is with it'
      : tech.trend === 'Downtrend' ? 'even though the daily trend is still down'
      : 'with a mixed daily trend';
    return `<strong>${esc(rating)}</strong>, ${esc(a.action.toLowerCase())}. Valuation carries the call: a ${pctPlain(val.baseGrowth, 0)} earnings path at a ${num(val.exitPe, 0)}× exit multiple gives ${pctPlain(val.expectedReturn, 1)} expected return against a ${pctPlain(a.hurdle, 0)} hurdle, ${trendClause}. Invalidation sits at ${money(plan.stop, stock.currency)}.`;
  }

  function sectionA(a) {
    const { stock, tech, val } = a;
    const assumes = val.ok && val.impliedGrowth != null
      ? `Today's price implies about <span class="num-sig">${pctPlain(val.impliedGrowth * 100, 1)}</span> of earnings growth a year for five years at an 11% discount rate — ${val.impliedPlausible === false ? 'above' : val.impliedPlausible === true ? 'inside' : 'near'} the ${val.hist != null ? pctPlain(val.hist, 1) + ' five-year history' : 'range the free data can support'}.`
      : 'Earnings per share is missing, so the reverse DCF cannot run and no target is issued.';

    // The R:R gate can block a BUY for timing, not for value. Say which.
    let entryNote = '';
    if (a.plan.rr < 2 && a.plan.priceToQualify != null) {
      entryNote = ` <span class="tag">Entry</span> The arithmetic clears the hurdle but reward:risk is ${a.plan.rr.toFixed(2)}:1, below the 2:1 bar. The price that would qualify is about <span class="num-sig">${money(a.plan.priceToQualify, stock.currency)}</span>.`;
    }

    return `<section class="sec" id="sec-a" data-sec="A">
      <div class="sec-head"><span class="n">A</span><h2>Bottom line</h2><span class="sub">the call</span></div>
      <p class="thesis">${thesis(a)}</p>
      <p>${assumes}${entryNote}</p>
      <div class="note">Rating follows the scenario math; headlines can only take risk off the table.${a.news ? ` Company tone is ${esc(a.news.label)} and the national backdrop is ${esc(a.news.macroLabel)}; ${a.newsPremium ? `the hurdle was raised ${a.newsPremium} points` : 'neither moved the hurdle'}.` : ''} ${val.ok ? `Probability-weighted value ${money(val.weightedTarget, stock.currency)}.` : ''} Action: <strong>${esc(a.action)}</strong>. Confidence ${a.conf.score}/10.</div>
    </section>`;
  }

  function sectionB(a) {
    const { stock, tech, val } = a;
    const dq = a.conf.dataQuality;
    const thin = dq.have < 6 ? `<p class="note warn">Thin data: only ${dq.have} of ${dq.total} fields could be verified. Confidence is capped at 5 and the rating should be read as provisional.</p>` : '';
    return `<section class="sec" id="sec-b" data-sec="B">
      <div class="sec-head"><span class="n">B</span><h2>Snapshot</h2><span class="sub">${esc(stock.asOf)}</span></div>
      <div class="kv">
        ${kv('Ticker', esc(stock.symbol) + (stock.exchange ? ` <span class="tag">${esc(stock.exchange)}</span>` : ''))}
        ${kv('Close', `<span class="num-sig">${money(tech.price, stock.currency)}</span>`, srcTag(stock, 'price'))}
        ${kv('Day change', `<span class="${signClass(tech.changePct)}">${pct(tech.changePct, 2)}</span>`)}
        ${kv('52-week range', `${money(tech.low52, stock.currency)} – ${money(tech.high52, stock.currency)}`, `<span class="tag">${pctPlain(tech.fromHigh, 1)} from high</span>`)}
        ${kv('Market cap', fv(stock, 'marketCap') != null ? compact(fv(stock, 'marketCap') * (stock.currency === 'INR' ? 1e7 : 1), stock.currency) : '<span class="tag na">N/A</span>', fv(stock, 'marketCap') != null ? srcTag(stock, 'marketCap') : '')}
        ${kv('P/E (TTM)', fv(stock, 'pe') != null ? num(fv(stock, 'pe'), 1) + '×' : '<span class="tag na">N/A</span>', fv(stock, 'pe') != null ? srcTag(stock, 'pe') : '')}
        ${kv('Book value', fv(stock, 'bookValue') != null ? money(fv(stock, 'bookValue'), stock.currency, 0) : '<span class="tag na">N/A</span>')}
        ${kv('ROE', fv(stock, 'roe') != null ? pctPlain(fv(stock, 'roe'), 1) : '<span class="tag na">N/A</span>', fv(stock, 'roe') != null ? srcTag(stock, 'roe') : '')}
        ${kv('ROCE', fv(stock, 'roce') != null ? pctPlain(fv(stock, 'roce'), 1) : '<span class="tag na">N/A</span>')}
        ${kv('Dividend yield', fv(stock, 'divYield') != null ? pctPlain(fv(stock, 'divYield'), 2) : '<span class="tag na">N/A</span>')}
        ${kv('Debt / equity', fv(stock, 'debtEquity') != null ? num(fv(stock, 'debtEquity'), 2) : '<span class="tag na">N/A</span>')}
        ${kv('Promoter holding', fv(stock, 'promoter') != null ? pctPlain(fv(stock, 'promoter'), 1) : '<span class="tag na">N/A</span>', fv(stock, 'promoter') != null ? srcTag(stock, 'promoter') : '')}
      </div>
      ${thin}
      <p class="hint">Market cap is shown in ${stock.currency === 'INR' ? 'crore' : 'billions'} where the source reports it that way. Free float, pledge and ADTV are only shown when the source publishes them.</p>
    </section>`;
  }

  function sectionC(a) {
    const { stock } = a;
    const pros = (stock.pros || []).map(p => `<li>${esc(p)}</li>`).join('');
    const cons = (stock.cons || []).map(p => `<li>${esc(p)}</li>`).join('');
    const about = stock.about ? `<p>${esc(stock.about)}</p>` : '';
    return `<section class="sec" id="sec-c" data-sec="C">
      <div class="sec-head"><span class="n">C</span><h2>Business quality &amp; governance</h2><span class="sub">filing-level</span></div>
      ${about}
      <div class="note warn">Segment mix, moat evidence and management track record are not available from a keyless source. That is a gap in this report, not a clean bill of health. Read the latest annual report and the last four concall transcripts before acting.</div>
      ${pros || cons ? `<table class="tbl compact"><thead><tr><th>What the numbers say</th><th>What to check</th></tr></thead><tbody>
        <tr><td><ul class="ul">${pros || '<li>No automatic flags.</li>'}</ul></td><td><ul class="ul">${cons || '<li>No automatic flags.</li>'}</ul></td></tr>
      </tbody></table><p class="hint">These flags are generated by Screener from published ratios; they are a checklist, not an opinion.</p>` : ''}
      <p class="hint">Governance items to verify yourself: auditor changes, related-party transactions, promoter pledge, regulatory action, litigation, dilution. None of them can be checked for free here, so none are claimed.</p>
    </section>`;
  }

  function sectionD(a) {
    const { stock, val } = a;
    const an = stock.annual;
    if (!an) {
      return `<section class="sec" id="sec-d" data-sec="D">
        <div class="sec-head"><span class="n">D</span><h2>Financial health</h2><span class="sub">five years</span></div>
        <p class="note warn">The five-year table did not parse from the free source for this symbol. The company page on Screener carries it; the link is in the sources panel and the numbers can be pasted in by hand.</p>
      </section>`;
    }
    const cols = an.header.length || (an.sales.length);
    const rowHtml = (label, arr, fmt, isEps) => {
      if (!arr) return `<tr><td>${label}</td>${'<td class="num"><span class="tag na">N/A</span></td>'.repeat(cols)}</tr>`;
      return `<tr><td>${label}</td>${arr.slice(-cols).map(v => `<td class="num">${U.isNum(v) ? fmt(v) : '<span class="tag na">N/A</span>'}</td>`).join('')}</tr>`;
    };
    const g = (arr) => {
      if (!arr) return null;
      const v = arr.filter(U.isNum);
      if (v.length < 2 || v[0] <= 0) return null;
      return (Math.pow(v[v.length - 1] / v[0], 1 / (v.length - 1)) - 1) * 100;
    };
    const salesG = g(an.sales), profitG = g(an.profit), epsG = g(an.eps);
    return `<section class="sec" id="sec-d" data-sec="D">
      <div class="sec-head"><span class="n">D</span><h2>Financial health</h2><span class="sub">annual, ${stock.currency === 'INR' ? '₹ crore' : 'reported units'}</span></div>
      <table class="tbl">
        <thead><tr><th></th>${(an.header.slice(0, cols)).map(hd => `<th class="num">${esc(hd)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rowHtml(an.marginLabel === 'Financing margin' ? 'Revenue' : 'Sales', an.sales, v => num(v, 0))}
          ${rowHtml('Net profit', an.profit, v => num(v, 0))}
          ${rowHtml('EPS', an.eps, v => num(v, 2))}
          ${rowHtml(an.marginLabel || 'Operating margin', an.opm, v => pctPlain(v, 1))}
        </tbody>
      </table>
      <div class="kv">
        ${kv('Sales CAGR', salesG != null ? pctPlain(salesG, 1) + ' <span class="tag est">est.</span>' : '<span class="tag na">N/A</span>')}
        ${kv('Profit CAGR', profitG != null ? pctPlain(profitG, 1) + ' <span class="tag est">est.</span>' : '<span class="tag na">N/A</span>')}
        ${kv('EPS CAGR', epsG != null ? pctPlain(epsG, 1) + ' <span class="tag est">est.</span>' : '<span class="tag na">N/A</span>')}
        ${kv('Earnings quality', val.ok ? (fv(stock, 'roe') != null ? 'ROE ' + pctPlain(fv(stock, 'roe'), 1) : 'N/A') : '<span class="tag na">N/A</span>')}
      </div>
      <p class="hint">Cash-flow, receivables, inventory days, DuPont and Piotroski need the full statements. CAGR here is first-to-last of the displayed columns and is marked as an estimate for that reason.</p>
    </section>`;
  }

  function sectorOf(stock) {
    const hay = `${stock.name} ${stock.about || ''} ${(stock.peers || []).map(p => p.name).join(' ')}`.toLowerCase();
    const map = [
      ['bank', ['bank', 'banking']],
      ['nbfc', ['finance', 'nbfc', 'housing finance', 'microfinance', 'financial services']],
      ['it', ['software', 'information technology', 'infosys', 'tcs', 'wipro', 'hcl']],
      ['pharma', ['pharma', 'drug', 'healthcare', 'lifescience', 'biotech']],
      ['auto', ['motor', 'auto', 'vehicle', 'maruti', 'tata motors']],
      ['oil', ['oil', 'petroleum', 'gas', 'refin', 'ongc', 'bpcl']],
      ['power', ['power', 'utility', 'electric', 'energy']],
      ['fmcg', ['consumer', 'fmcg', 'foods', 'retail']],
      ['cement', ['cement']],
      ['metal', ['steel', 'metal', 'aluminium', 'copper']],
      ['telecom', ['telecom', 'wireless']]
    ];
    for (const [key, words] of map) if (words.some(w => hay.includes(w))) return key;
    return 'general';
  }

  const SECTOR_KPIS = {
    bank: ['Net interest margin', 'CASA ratio', 'Credit growth', 'GNPA / NNPA', 'Provision coverage', 'CASA + CAR'],
    nbfc: ['AUM growth', 'Spread', 'Cost of funds', 'Stage-3 assets', 'Credit cost', 'ROA'],
    it: ['Constant-currency growth', 'Deal TCV', 'EBIT margin', 'Utilisation', 'Attrition', 'Client concentration'],
    pharma: ['US price erosion', 'ANDA approvals', 'USFDA status', 'R&D % of sales', 'India vs export mix', 'CDMO order book'],
    auto: ['Volumes', 'Market share', 'Realisation per unit', 'EBITDA margin', 'Dealer inventory', 'EV capex'],
    oil: ['GRM', 'Marketing margin', 'Throughput', 'Inventory gain/loss', 'Subsidy sharing', 'Crude sensitivity'],
    power: ['PLF', 'PPA coverage', 'Regulated equity', 'Capex pipeline', 'Fuel pass-through', 'Renewable capacity'],
    fmcg: ['Volume vs price growth', 'Gross margin', 'A&P intensity', 'Distribution reach', 'Rural mix', 'Input cost'],
    cement: ['Volumes', 'Realisation per tonne', 'Utilisation', 'Power & fuel cost', 'Capacity additions'],
    metal: ['Spreads', 'Utilisation', 'Inventory', 'Capacity additions', 'Through-cycle EV/EBITDA'],
    telecom: ['ARPU', 'Subscriber mix', 'Capex intensity', 'Net debt', 'Spectrum obligations'],
    general: ['Revenue growth', 'Operating margin', 'Return on capital', 'Working capital days', 'Leverage']
  };

  function sectionE(a) {
    const sector = sectorOf(a.stock);
    const kpis = SECTOR_KPIS[sector] || SECTOR_KPIS.general;
    return `<section class="sec" id="sec-e" data-sec="E">
      <div class="sec-head"><span class="n">E</span><h2>Sector KPIs</h2><span class="sub">${esc(sector)}</span></div>
      <p>Detected from the company description and its peer set. These are the metrics that usually explain this sector's earnings surprises.</p>
      <table class="tbl compact"><tbody>
        <tr><td>KPIs that matter</td><td>${kpis.map(k => `<span class="tag">${esc(k)}</span>`).join(' ')}</td></tr>
        <tr><td>Values</td><td><span class="tag na">N/A — not in the free feed</span> Take them from the last investor presentation.</td></tr>
      </tbody></table>
      <p class="hint">Guessing a sector metric would be worse than admitting the gap. The list is here so you know what to pull.</p>
    </section>`;
  }

  function sectionF(a) {
    const { stock, val, tech } = a;
    if (!val.ok) {
      return `<section class="sec" id="sec-f" data-sec="F">
        <div class="sec-head"><span class="n">F</span><h2>Valuation</h2><span class="sub">inputs missing</span></div>
        <p>${esc(val.reason)}</p>
        <p class="hint">P/E is ${fv(stock, 'pe') != null ? num(fv(stock, 'pe'), 1) + '×' : 'not available'}, book value ${fv(stock, 'bookValue') != null ? money(fv(stock, 'bookValue'), stock.currency, 0) : 'not available'}.</p>
        <button class="ghost" type="button" data-open-manual>Add EPS or P/E by hand</button>
      </section>`;
    }
    const peers = (stock.peers || []).filter(p => U.isNum(p.pe) && p.pe > 0);
    const peerPe = peers.length ? U.mean(peers.map(p => p.pe)) : null;
    const disc = peerPe ? (fv(stock, 'pe') / peerPe - 1) * 100 : null;
    return `<section class="sec" id="sec-f" data-sec="F">
      <div class="sec-head"><span class="n">F</span><h2>Valuation</h2><span class="sub">reverse DCF + scenarios</span></div>
      <div class="kv">
        ${kv('P/E (TTM)', fv(stock, 'pe') != null ? num(fv(stock, 'pe'), 1) + '×' : '<span class="tag na">N/A</span>')}
        ${kv('Peer average P/E', peerPe != null ? num(peerPe, 1) + '× <span class="tag est">est.</span>' : '<span class="tag na">N/A</span>')}
        ${kv('Premium / discount', disc != null ? `<span class="${signClass(disc)}">${pct(disc, 1)}</span> vs peers` : '<span class="tag na">N/A</span>')}
        ${kv('Implied 5y growth', val.impliedGrowth != null ? pctPlain(val.impliedGrowth * 100, 1) : '<span class="tag na">N/A</span>', '<span class="tag est">reverse DCF</span>')}
        ${kv('History, 5y EPS CAGR', val.hist != null ? pctPlain(val.hist, 1) : '<span class="tag na">N/A</span>')}
        ${kv('Margin of safety', `<span class="${signClass(val.mos)}">${pct(val.mos, 1)}</span>`, '<span class="tag">base case</span>')}
      </div>
      <p>Reverse DCF: at an 11% discount rate and 4% terminal growth, today's price implies <span class="num-sig">${pctPlain(val.impliedGrowth * 100, 1)}</span> a year in earnings growth for five years. ${val.hist != null ? `The company delivered ${pctPlain(val.hist, 1)} over the last five years.` : ''} ${val.impliedPlausible === false ? 'That is a demanding bar.' : val.impliedPlausible === true ? 'That looks achievable on the record.' : ''}</p>
      <p>Fair-value band from the scenarios: <strong>${money(val.fairLow, stock.currency)} – ${money(val.fairHigh, stock.currency)}</strong>. Base case ${money(val.rows[1].target, stock.currency)} against a close of ${money(tech.price, stock.currency)}.</p>
      <p class="hint">Base growth is the five-year EPS CAGR faded toward 10% across the forecast, so a cyclical peak is not projected as permanent. The exit multiple is today's, capped — it assumes the market pays the same multiple in a year. Multiples versus the stock's own five-year median need a paid history feed, so that comparison is not claimed. ${val.cons ? `Growth was positive in ${val.cons.up} of the last ${val.cons.years} years.` : ''}</p>
      ${/bank|financial|finance|insurance|lender/i.test(stock.name + ' ' + (stock.peers || []).map(p => p.name).join(' ')) ? '<p class="note warn">This looks like a lender or financial. A P/E-on-EPS target ignores loan growth, credit cost, NIM and book value. Read the target as a cross-check against a P/ABV-versus-ROE valuation, not as the valuation.</p>' : ''}
      ${fv(stock, 'pe') != null && fv(stock, 'pe') > 45 ? '<p class="note warn">The multiple is extreme for this model. A P/E-on-EPS target at 45×+ is sensitive to the exit-multiple cap and to the growth assumption; read it as a warning, not a valuation.</p>' : ''}
    </section>`;
  }

  function sectionG(a) {
    const { stock, tech } = a;
    const dmaRow = (label, v) => `<tr><td>${label}</td><td class="num">${U.isNum(v) ? money(v, stock.currency) : '—'}</td><td class="num ${U.isNum(v) ? signClass(tech.price / v - 1) : ''}">${U.isNum(v) ? pct((tech.price / v - 1) * 100, 1) : '—'}</td></tr>`;
    const rsRow = tech.rs ? `<tr><td>Relative strength, 3m</td><td class="num ${signClass(tech.rs.m3)}">${pct(tech.rs.m3, 1)}</td><td class="num ${signClass(tech.rs.m12)}">${pct(tech.rs.m12, 1)}</td></tr>` : '';
    return `<section class="sec" id="sec-g" data-sec="G">
      <div class="sec-head"><span class="n">G</span><h2>Technicals &amp; flows</h2><span class="sub">daily bars, 5y</span></div>
      ${priceChart(tech)}
      <div class="kv">
        ${kv('Trend, daily', trendBadge(tech.trend))}
        ${kv('Trend, weekly', trendBadge(tech.weeklyTrend))}
        ${kv('RSI (14)', `${num(tech.rsi14, 1)} <span class="tag">${tech.rsi14 > 70 ? 'overbought' : tech.rsi14 < 30 ? 'oversold' : 'neutral'}</span>`)}
        ${kv('MACD', `${num(tech.macd.line, 2)} / ${num(tech.macd.signal, 2)} <span class="tag">${esc(tech.macd.state)}</span>`)}
        ${kv('ATR (14)', `${money(tech.atr14, stock.currency)} <span class="tag">${pctPlain(tech.atrPct, 1)} of price</span>`)}
        ${kv('52-week position', `${pctPlain(tech.rangePos, 0)} of range`)}
      </div>
      <table class="tbl compact">
        <thead><tr><th>Average</th><th class="num">Level</th><th class="num">Price vs</th></tr></thead>
        <tbody>
          ${dmaRow('20-DMA', tech.ma.s20)}${dmaRow('50-DMA', tech.ma.s50)}${dmaRow('100-DMA', tech.ma.s100)}${dmaRow('200-DMA', tech.ma.s200)}
          <tr><td>Support (swing)</td><td class="num">${money(tech.support, stock.currency)}</td><td class="num">${pct((tech.price / tech.support - 1) * 100, 1)} above</td></tr>
          <tr><td>Resistance (swing)</td><td class="num">${money(tech.resistance, stock.currency)}</td><td class="num">${pct((tech.resistance / tech.price - 1) * 100, 1)} away</td></tr>
          ${rsRow}
        </tbody>
      </table>
      <p class="hint">Support and resistance come from 3-bar swing pivots over the last year, not from drawn lines. Relative strength compares with ${stock.isIndia ? 'the Nifty 50' : 'the S&P 500'} over the same window.${tech.rs ? '' : ' Index data was unavailable for this run.'}</p>
    </section>`;
  }

  function sectionH(a) {
    const { stock, news } = a;
    const badge = (label) => {
      const cls = label === 'positive' ? 'buy' : label === 'negative' ? 'sell' : 'hold';
      return `<span class="badge ${cls}">${esc(label)}</span>`;
    };
    const counts = (n) => (n && n.count)
      ? `<span class="subline">${n.pos} positive · ${n.neg} negative · ${n.count} stories</span>`
      : '<span class="tag na">no headlines</span>';
    const adj = a.conf.newsAdjust;
    const adjTxt = !news ? '<span class="tag na">N/A</span>'
      : `<span class="${signClass(adj)}">${adj > 0 ? '+' : ''}${adj.toFixed(1)}</span> pts`;

    return `<section class="sec" id="sec-h" data-sec="H">
      <div class="sec-head"><span class="n">H</span><h2>Sentiment &amp; positioning</h2><span class="sub">headlines + filings</span></div>
      <div class="kv">
        ${stock.isIndia ? kv('Promoter holding', fv(stock, 'promoter') != null ? pctPlain(fv(stock, 'promoter'), 1) : '<span class="tag na">N/A</span>') : ''}
        ${kv('Company tone', news ? `${badge(news.label)} ${counts(news.company)}` : '<span class="tag na">N/A</span>', '<span class="tag est">keywords</span>')}
        ${kv('National / policy tone', news ? `${badge(news.macroLabel)} ${counts(news.macro)}` : '<span class="tag na">N/A</span>', '<span class="tag est">keywords</span>')}
        ${kv('Announcement-type stories', news && news.company.count ? `${news.catalyst} of ${news.company.count}` : '<span class="tag na">N/A</span>')}
        ${kv('Confidence effect', adjTxt, news ? '<span class="tag">bounded</span>' : '')}
      </div>
      <p>Shareholding trend, FII and DII flows, bulk and block deals, pledge and insider activity live on exchange filings and still have no free keyless feed. The headlines above are the part that can be checked automatically; the rest is reported as a gap.</p>
      <p class="hint">Tone is a keyword count over headline titles, not a reading of the articles. It can trim confidence and block a fresh buy when a severe story appears; it never creates a buy on its own. Open the headline before acting on it.</p>
    </section>`;
  }

  function newsList(items, limit) {
    const list = (items || []).slice(0, limit);
    if (!list.length) return '<p class="hint">No headlines came back for this query. Treat that as missing information, not as calm.</p>';
    return `<ul class="newslist">${list.map(it => `<li>
      <a href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>
      <span class="newsmeta">${esc(it.source || 'source')}${it.t ? ' · ' + esc(dateLabel(it.t)) : ''}</span>
    </li>`).join('')}</ul>`;
  }

  function sectionI(a) {
    const { stock } = a;
    // a.news is the scored summary; the raw feed with titles lives on the stock.
    const raw = stock.news || {};
    const base = stock.symbol.replace(/\.(NS|BO)$/i, '');
    const links = stock.isIndia ? [
      ['NSE announcements', `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(base)}`],
      ['BSE announcements', `https://www.bseindia.com/stock-share-price/${encodeURIComponent(base.toLowerCase())}/`],
      ['Screener company page', `https://www.screener.in/company/${encodeURIComponent(base)}/consolidated/`]
    ] : [
      ['SEC filings', `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(stock.name)}&type=10-K`],
      ['Yahoo Finance news', `https://finance.yahoo.com/quote/${encodeURIComponent(stock.symbol)}/news`]
    ];

    const company = raw.company ? raw.company.items : [];
    const macro = raw.macro ? raw.macro.items : [];

    return `<section class="sec" id="sec-i" data-sec="I">
      <div class="sec-head"><span class="n">I</span><h2>News, announcements &amp; the political backdrop</h2><span class="sub">dated headlines</span></div>

      <div class="newsgroup">
        <h3>Around the company</h3>
        ${newsList(company, 6)}
      </div>

      <div class="newsgroup">
        <h3>National and policy backdrop${stock.isIndia ? ' — India' : ''}</h3>
        ${newsList(macro, 4)}
      </div>

      <p class="hint">Titles and dates come from the Bing News RSS feed at request time; the engine scores the titles only. Corporate announcements still need the exchange filing — these are the direct links:</p>
      <table class="tbl compact"><thead><tr><th>Check</th><th>Link</th></tr></thead><tbody>
        ${links.map(([label, url]) => `<tr><td>${esc(label)}</td><td><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">open →</a></td></tr>`).join('')}
      </tbody></table>
      <p class="hint">Next results date, concall, AGM and dividend record dates belong in your own notes; add them to the monitoring table below.</p>
    </section>`;
  }

  function sectionJ(a) {
    return `<section class="sec" id="sec-j" data-sec="J">
      <div class="sec-head"><span class="n">J</span><h2>Risks</h2><span class="sub">pre-mortem</span></div>
      <ol class="ul">
        ${a.risks.map((r, i) => `<li><strong>${esc(r.title)}</strong> <span class="tag">${esc(r.p)} probability · ${esc(r.i)} impact</span><br>${esc(r.detail)}<br><span class="hint">Early warning: ${esc(r.watch)}</span></li>`).join('')}
      </ol>
      <p class="note">What would make this call wrong: a guidance cut that breaks the base-case growth, or a close below ${money(a.plan.stop, a.stock.currency)} with the trend still down.</p>
    </section>`;
  }

  function sectionK(a) {
    const { stock, val } = a;
    if (!val.ok) return '';
    const rows = val.rows;
    const cells = rows.map(r => `<div class="scen" aria-pressed="false" data-scen="${esc(r.key)}">
        <span class="t">${esc(r.label)} <span>${r.prob}%</span></span>
        <span class="p">${money(r.target, stock.currency)}</span>
        <span class="d">${pctPlain(r.growth, 1)} growth · ${num(r.pe, 0)}× exit · ${pct(r.total, 1)} total</span>
      </div>`).join('');
    const pSum = U.sum(rows.map(r => r.prob));
    return `<section class="sec" id="sec-k" data-sec="K">
      <div class="sec-head"><span class="n">K</span><h2>Scenarios</h2><span class="sub">drag the assumptions</span></div>
      <div class="scen-grid">${cells}</div>
      <table class="tbl" style="margin-top:14px">
        <thead><tr><th>Scenario</th><th class="num">Probability</th><th class="num">Growth</th><th class="num">Exit P/E</th><th class="num">EPS</th><th class="num">Target</th><th class="num">Return</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td class="num">${r.prob}%</td><td class="num">${pctPlain(r.growth, 1)}</td><td class="num">${num(r.pe, 0)}×</td><td class="num">${num(r.eps1, 2)}</td><td class="num num-sig">${money(r.target, stock.currency)}</td><td class="num ${signClass(r.total)}">${pct(r.total, 1)}</td></tr>`).join('')}</tbody>
      </table>
      <div class="slider-row"><label for="sGrowth">Base growth</label><input id="sGrowth" type="range" min="-5" max="30" step="0.5" value="${val.baseGrowth}"><output>${pctPlain(val.baseGrowth, 1)}</output></div>
      <div class="slider-row"><label for="sPe">Exit P/E</label><input id="sPe" type="range" min="5" max="60" step="0.5" value="${val.exitPe}"><output>${num(val.exitPe, 1)}×</output></div>
      <div class="slider-row"><label for="sSpread">Bull/bear spread</label><input id="sSpread" type="range" min="1" max="15" step="0.5" value="${val.spread}"><output>±${pctPlain(val.spread, 1)}</output></div>
      <div class="note">Weighted value <strong>${money(val.weightedTarget, stock.currency)}</strong>, expected return <strong class="${signClass(val.expectedReturn)}">${pct(val.expectedReturn, 1)}</strong>. Probabilities sum to ${pSum}%. Dividends of ${pctPlain(val.divYield, 2)} are included in total return.</div>
      <p class="hint">Growth is the 12-month EPS path, and the exit multiple is what the market pays for it a year out. Both are your assumptions once you move the sliders; the rating below recomputes.</p>
    </section>`;
  }

  function sectionL(a) {
    const { stock } = a;
    const peers = (stock.peers || []).slice(0, 6);
    if (!peers.length) {
      return `<section class="sec" id="sec-l" data-sec="L">
        <div class="sec-head"><span class="n">L</span><h2>Peers</h2><span class="sub">relative call</span></div>
        <p>No peer table was available from the free source for this symbol.</p>
      </section>`;
    }
    const own = { name: stock.name.replace(/ Ltd\.?$/, ''), cmp: a.tech.price, pe: fv(stock, 'pe'), mcap: fv(stock, 'marketCap'), divYield: fv(stock, 'divYield'), roce: fv(stock, 'roce'), self: true };
    const all = [own].concat(peers);
    const minPe = Math.min.apply(null, all.map(p => p.pe).filter(U.isNum));
    const bestPe = all.filter(p => p.pe === minPe)[0];
    const bestRoce = all.slice().sort((x, y) => (y.roce || -1) - (x.roce || -1))[0];
    return `<section class="sec" id="sec-l" data-sec="L">
      <div class="sec-head"><span class="n">L</span><h2>Peers</h2><span class="sub">${all.length} names</span></div>
      <table class="tbl compact">
        <thead><tr><th>Company</th><th class="num">Price</th><th class="num">P/E</th><th class="num">Mkt cap</th><th class="num">Div yield</th><th class="num">ROCE</th></tr></thead>
        <tbody>
          ${all.map(p => `<tr><td class="key">${esc(p.name)}${p.self ? ' <span class="tag you">this</span>' : ''}</td><td class="num">${U.isNum(p.cmp) ? money(p.cmp, stock.currency) : '—'}</td><td class="num">${U.isNum(p.pe) ? num(p.pe, 1) + '×' : '—'}</td><td class="num">${U.isNum(p.mcap) ? compact(p.mcap * 1e7, stock.currency) : '—'}</td><td class="num">${U.isNum(p.divYield) ? pctPlain(p.divYield, 2) : '—'}</td><td class="num">${U.isNum(p.roce) ? pctPlain(p.roce, 1) : '—'}</td></tr>`).join('')}
        </tbody>
      </table>
      <p>Cheapest on P/E: <strong>${esc(bestPe ? bestPe.name : '—')}</strong>. Best return on capital: <strong>${esc(bestRoce ? bestRoce.name : '—')}</strong>. ${bestPe && bestRoce && bestPe.name !== bestRoce.name ? 'Value and quality do not point at the same name, so the choice is a trade-off rather than a free lunch.' : 'Value and quality point at the same name on this table.'}</p>
      <p class="hint">Peer multiples come from Screener's peer table and can lag the close by a day.</p>
    </section>`;
  }

  function sectionM(a) {
    const { stock, tech, plan, val } = a;
    const sizeLine = plan.size > 0
      ? `${pctPlain(plan.size, 1)} of portfolio at a ${pctPlain(plan.stopPct, 1)} stop risks ${pctPlain(plan.lossPctPortfolio, 2)} of portfolio.`
      : 'Stop distance is too wide for a sized position under your risk limit.';
    return `<section class="sec" id="sec-m" data-sec="M">
      <div class="sec-head"><span class="n">M</span><h2>Trade plan</h2><span class="sub">sized to your limits</span></div>
      <div class="kv">
        ${kv('Action', `<strong>${esc(a.action)}</strong>`)}
        ${kv('Entry zone', `${money(tech.price - 0.5 * plan.atr, stock.currency)} – ${money(tech.price + 0.3 * plan.atr, stock.currency)}`)}
        ${kv('Invalidation', `<span class="num-down">${money(plan.stop, stock.currency)}</span>`, `<span class="tag">${pctPlain(plan.stopPct, 1)} risk</span>`)}
        ${kv('Reward : risk', `${num(plan.rr, 2)} : 1 ${plan.qualifies ? '' : '<span class="tag na">below 2:1</span>'}`)}
        ${kv('Position size', pctPlain(plan.size, 1), `<span class="tag">cap ${pctPlain(U.settings().cap, 0)}</span>`)}
      </div>
      <table class="tbl compact">
        <thead><tr><th>Tranche</th><th class="num">Level</th><th class="num">Weight</th><th>Condition</th></tr></thead>
        <tbody>${plan.entry.map(t => `<tr><td>${esc(t.label)}</td><td class="num">${money(t.price, stock.currency)}</td><td class="num">${t.weight}%</td><td>${esc(t.condition)}</td></tr>`).join('')}</tbody>
      </table>
      <table class="tbl compact">
        <thead><tr><th>Target</th><th class="num">Price</th><th class="num">Return</th><th>Basis</th></tr></thead>
        <tbody>
          <tr><td>T1 — partial</td><td class="num">${money(plan.t1, stock.currency)}</td><td class="num ${signClass((plan.t1 / tech.price - 1) * 100)}">${pct((plan.t1 / tech.price - 1) * 100, 1)}</td><td>Nearest resistance or 1.5×ATR</td></tr>
          <tr><td>T2 — base case</td><td class="num num-sig">${money(plan.t2, stock.currency)}</td><td class="num ${signClass((plan.t2 / tech.price - 1) * 100)}">${pct((plan.t2 / tech.price - 1) * 100, 1)}</td><td>${val.ok ? 'Scenario base case' : 'Price + 10%'}</td></tr>
          <tr><td>Bull</td><td class="num">${money(plan.bull, stock.currency)}</td><td class="num ${signClass((plan.bull / tech.price - 1) * 100)}">${pct((plan.bull / tech.price - 1) * 100, 1)}</td><td>Bull scenario</td></tr>
        </tbody>
      </table>
      <p>${sizeLine} ${U.isNum(plan.participationPct) ? (() => {
        const share = plan.participationPct < 0.1 ? 'under 0.1%' : num(plan.participationPct, 1) + '%';
        return `A ${money(plan.notional, stock.currency, 0)} order is <strong>${share}</strong> of a day's 10% participation limit on average traded value${plan.participationPct > 100 ? ', so it would need more than one session to fill' : ', so it can be built in one go'}.`;
      })() : ''}</p>
      ${plan.qualifies ? '' : `<p class="note warn">Reward:risk is ${num(plan.rr, 2)}:1, under the 2:1 a buy needs. At ${money(plan.priceToQualify, stock.currency)} the same targets would clear the bar.</p>`}
      <p class="hint">${esc(plan.taxNote)}</p>
    </section>`;
  }

  function sectionN(a) {
    return `<section class="sec" id="sec-n" data-sec="N">
      <div class="sec-head"><span class="n">N</span><h2>Monitoring checklist</h2><span class="sub">what to watch</span></div>
      <table class="tbl compact">
        <thead><tr><th>Metric</th><th>Threshold</th><th>Why</th><th>When</th></tr></thead>
        <tbody>${a.monitoring.map(r => `<tr><td class="key">${esc(r.metric)}</td><td>${esc(r.threshold)}</td><td>${esc(r.why)}</td><td class="hint">${esc(r.when)}</td></tr>`).join('')}</tbody>
      </table>
    </section>`;
  }

  function sectionO(a) {
    const { stock, val, conf, plan, rating, news } = a;
    const target = val.ok ? val.rows[1].target : null;
    const targetBand = val.ok ? `${money(val.fairLow, stock.currency)} – ${money(val.fairHigh, stock.currency)}` : '<span class="tag na">N/A</span>';
    return `<section class="sec" id="sec-o" data-sec="O">
      <div class="sec-head"><span class="n">O</span><h2>Verdict</h2><span class="sub">never omitted</span></div>
      <div class="kv">
        ${kv('Rating', ratingBadge(rating))}
        ${kv('Confidence', `${conf.score}/10`)}
        ${kv('12-month target', target != null ? `<span class="num-sig">${money(target, stock.currency)}</span>` : '<span class="tag na">N/A</span>', target != null ? `<span class="tag">${pct((target / a.tech.price - 1) * 100, 1)}</span>` : '')}
        ${kv('Fair-value band', targetBand)}
        ${kv('Bull / bear', val.ok ? `${money(val.rows[0].target, stock.currency)} / ${money(val.rows[2].target, stock.currency)}` : '<span class="tag na">N/A</span>')}
      </div>
      <table class="tbl compact">
        <thead><tr><th>Confidence</th><th class="num">Score</th><th>What moves it</th></tr></thead>
        <tbody>
          <tr><td>Data quality</td><td class="num">${num(conf.parts.quality, 1)}</td><td>${conf.dataQuality.have} of ${conf.dataQuality.total} fields verified</td></tr>
          <tr><td>Thesis clarity</td><td class="num">${num(conf.parts.clarity, 1)}</td><td>Trend and valuation agreement, five-year history present</td></tr>
          <tr><td>Catalyst visibility</td><td class="num">${num(conf.parts.catalyst, 1)}</td><td>${news && news.catalyst ? `${news.catalyst} of ${news.company.count} headlines are announcement-type (results, dividend, merger, order, guidance…). No results date or filings in the free feed.` : 'No announcement-type headlines in the free feed. Results dates and filings need the exchange site.'}</td></tr>
          <tr><td>Valuation cushion</td><td class="num">${num(conf.parts.cushion, 1)}</td><td>Margin of safety ${val.ok ? pct(val.mos, 1) : 'unknown'}</td></tr>
        </tbody>
      </table>
      <p class="thesis">${esc(thesis(a).replace(/<[^>]+>/g, ''))}</p>
      <p><strong>Reassess if:</strong></p>
      <ul class="ul">
        <li>Price closes below ${money(plan.stop, stock.currency)} — the setup is invalidated.</li>
        <li>${val.ok ? `Base-case growth of ${pctPlain(val.baseGrowth, 1)} is cut by guidance for two quarters running.` : 'Earnings per share is published and the valuation can finally be computed.'}</li>
        <li>${stock.isIndia ? 'Brent, the rupee or the repo rate moves enough to change the sector math.' : 'Rates or the sector multiple move enough to change the exit assumption.'}</li>
      </ul>
      ${sources(stock)}
      <p class="hint" style="margin-top:16px">Analysis for informational purposes, not personalised investment advice. Verify before trading.</p>
    </section>`;
  }

  /* ---------------- render report ---------------- */

  function renderReport() {
    const a = state.analysis, stock = state.stock;
    if (!a) return;
    const head = $('#reportHead');
    head.innerHTML = `
      <div class="report-title">
        <div>
          <p class="kicker" style="margin-bottom:8px"><span class="rule-inline"></span>${esc(stock.exchange || 'listed')}</p>
          <h1>${esc(stock.name)}</h1>
          <p class="sym">${esc(stock.symbol)} · ${esc(stock.currency)} · close ${esc(stock.asOf)}</p>
        </div>
        <div class="report-meta">
          <span>${a.val.ok ? 'rating: ' + esc(a.rating) : 'rating: provisional'}</span>
          <span>confidence ${a.conf.score}/10</span>
          <span>route: ${esc(LG.data.Route.label)}</span>
          <span>generated ${U.timeLabel()}</span>
        </div>
      </div>
      <div class="rating-strip">
        <div class="rate-cell"><span class="k">Rating</span><span class="v">${esc(a.rating)}</span><span class="s">${esc(a.action)}</span></div>
        <div class="rate-cell"><span class="k">CMP</span><span class="v">${money(a.tech.price, stock.currency)}</span><span class="s ${signClass(a.tech.changePct)}">${pct(a.tech.changePct, 2)} today</span></div>
        <div class="rate-cell"><span class="k">12M target</span><span class="v sig">${a.val.ok ? money(a.val.rows[1].target, stock.currency) : 'N/A'}</span><span class="s">${a.val.ok ? pct((a.val.rows[1].target / a.tech.price - 1) * 100, 1) + ' upside' : 'needs EPS'}</span></div>
        <div class="rate-cell"><span class="k">Expected return</span><span class="v ${a.val.ok ? signClass(a.val.expectedReturn) : ''}">${a.val.ok ? pct(a.val.expectedReturn, 1) : 'N/A'}</span><span class="s">hurdle ${pctPlain(a.hurdle, 0)}</span></div>
        <div class="rate-cell"><span class="k">Confidence</span><span class="v">${a.conf.score}<span style="font-size:14px;color:var(--ink-faint)">/10</span></span><span class="s">${a.conf.dataQuality.have}/${a.conf.dataQuality.total} fields</span></div>
        <div class="rate-cell"><span class="k">Invalidation</span><span class="v down">${money(a.plan.stop, stock.currency)}</span><span class="s">${pctPlain(a.plan.stopPct, 1)} below CMP</span></div>
      </div>
      <div class="report-actions">
        <button class="ghost" type="button" id="refreshBtn">Refresh data</button>
        <button class="ghost" type="button" id="manualBtn">Add fundamentals</button>
        <button class="ghost" type="button" id="copyBtn">Copy prompt + data</button>
        <button class="ghost" type="button" id="mdBtn">Download .md</button>
        <button class="ghost" type="button" id="watchBtn">${isWatched(stock.symbol) ? 'In watchlist ✓' : 'Add to watchlist'}</button>
        <button class="ghost" type="button" onclick="window.print()">Print / PDF</button>
      </div>`;

    const body = $('#reportBody');
    body.innerHTML = [sectionA, sectionB, sectionC, sectionD, sectionE, sectionF, sectionG, sectionH, sectionI, sectionJ, sectionK, sectionL, sectionM, sectionN, sectionO]
      .map(fn => fn(a)).join('');

    buildNav();
    wireReportEvents();
  }

  function buildNav() {
    const nav = $('#reportNav');
    const secs = $$('#reportBody .sec');
    const names = { A: 'Bottom line', B: 'Snapshot', C: 'Quality', D: 'Financials', E: 'Sector KPIs', F: 'Valuation', G: 'Technicals', H: 'Sentiment', I: 'News', J: 'Risks', K: 'Scenarios', L: 'Peers', M: 'Trade plan', N: 'Monitoring', O: 'Verdict' };
    nav.innerHTML = secs.map(s => {
      const k = s.dataset.sec;
      return `<a href="#${s.id}" data-target="${s.id}"><span class="n">${esc(names[k] || k)}</span></a>`;
    }).join('');
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', ev => {
      ev.preventDefault();
      const t = document.getElementById(a.dataset.target);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(en => {
          if (!en.isIntersecting) return;
          const id = en.target.id;
          nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', a.dataset.target === id));
        });
      }, { rootMargin: '-80px 0px -70% 0px' });
      secs.forEach(s => io.observe(s));
      if (window.__ledgerIO) window.__ledgerIO.disconnect();
      window.__ledgerIO = io;
    }
  }

  function wireReportEvents() {
    const redo = () => {
      state.analysis = E.analyse(state.stock, state.indexRows, state.opts);
      renderReport();
      window.scrollTo({ top: 0 });
    };

    const bindSlider = (id, key, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', U.debounce(() => {
        const v = parseFloat(el.value);
        state.opts[key] = v;
        const out = el.parentElement.querySelector('output');
        if (out) out.textContent = key === 'exitPe' ? num(v, 1) + '×' : key === 'spread' ? '±' + pctPlain(v, 1) : pctPlain(v, 1);
        state.analysis = E.analyse(state.stock, state.indexRows, state.opts);
        renderReport();
      }, 220));
    };
    bindSlider('sGrowth', 'growth');
    bindSlider('sPe', 'exitPe');
    bindSlider('sSpread', 'spread');

    const refresh = $('#refreshBtn');
    if (refresh) refresh.addEventListener('click', () => loadSymbol(state.stock.symbol, { force: true }));

    const manual = $('#manualBtn');
    if (manual) manual.addEventListener('click', openManual);
    const manual2 = document.querySelector('[data-open-manual]');
    if (manual2) manual2.addEventListener('click', openManual);

    const copy = $('#copyBtn');
    if (copy) copy.addEventListener('click', copyPrompt);

    const md = $('#mdBtn');
    if (md) md.addEventListener('click', downloadMarkdown);

    const w = $('#watchBtn');
    if (w) w.addEventListener('click', () => {
      toggleWatch(state.stock);
      w.textContent = isWatched(state.stock.symbol) ? 'In watchlist ✓' : 'Add to watchlist';
    });
  }

  /* ---------------- prompt + markdown export ---------------- */

  const PROMPT_CORE = `You are a sell-side-grade equity analyst and an execution-minded broker in one voice.
Rules: every price, ratio and target carries a date and a source; never carry a number forward from memory; mark estimates "(est.)" with the basis; write [N/A] when a datum cannot be found; separate fact, estimate and opinion; lead with the call, then the evidence; no filler.
Modes: full report for a stock name; "Quick:" for a 250-word take; "Compare:" for head-to-head; "Days report" for a watchlist with delta updates; "Trade:" for the trade plan only; "Portfolio review" for holdings.
Full report order: A bottom line table (rating, confidence, CMP, 12M target, expected return, action, invalidation) → B snapshot → C business quality and governance → D financial health → E sector KPIs → F valuation with a reverse DCF → G technicals and flows → H sentiment → I dated news and catalyst calendar → J ranked pre-mortem risks → K bull/base/bear scenarios with probabilities summing to 100 → L peer comparison → M trade plan with entry tranches, stop, targets, R:R, position size and tax → N monitoring checklist → O verdict block.
Rating gates: STRONG BUY expected return ≥ +30%, confidence ≥ 8, R:R ≥ 2; BUY ≥ +15%, confidence ≥ 6, R:R ≥ 2; HOLD between −10% and +15%; SELL ≤ −10%; STRONG SELL ≤ −25% with confidence ≥ 8.
Confidence is the average of data quality, thesis clarity, catalyst visibility and valuation cushion, capped at 6 when key data is unverified.
End with a Sources list and: "Analysis for informational purposes, not personalised investment advice. Verify before trading. Investment disclaimer: this note is educational and informational only. It is not a research report, not a prospectus, and not a recommendation to buy, sell or hold. Nothing here is investment advice, a solicitation, or a forecast of returns. Figures come from free third-party sources that are not verified for accuracy and may be incomplete, stale or incorrect. Consult a qualified SEBI-registered investment adviser and read the company's own filings before acting on any figure or rating."`;

  function dataBlock() {
    const a = state.analysis, stock = state.stock;
    const f = (k, label, fmt) => {
      const v = fv(stock, k);
      const shown = v == null ? '[N/A]' : fmt ? fmt(v) : v;
      return `- ${label}: ${shown} (${v == null ? 'not found' : fsrc(stock, k)})`;
    };
    const n2 = (v) => (U.isNum(v) ? v.toFixed(2) : 'n/a');
    const lines = [
      `Stock: ${stock.name} (${stock.symbol}, ${stock.exchange})`,
      `Close: ${money(a.tech.price, stock.currency)} as of ${stock.asOf}`,
      f('pe', 'P/E (TTM)', v => num(v, 1) + '×'),
      f('eps', 'EPS (TTM)', v => money(v, stock.currency, 2)),
      f('bookValue', 'Book value', v => money(v, stock.currency, 0)),
      f('roe', 'ROE', v => pctPlain(v, 1)),
      f('roce', 'ROCE', v => pctPlain(v, 1)),
      f('divYield', 'Dividend yield', v => pctPlain(v, 2)),
      f('marketCap', 'Market cap', v => (stock.currency === 'INR' ? compact(v * 1e7, 'INR') : compact(v, stock.currency))),
      f('debtEquity', 'Debt/equity', v => num(v, 2)),
      f('promoter', 'Promoter holding', v => pctPlain(v, 1)),
      `52-week range: ${money(a.tech.low52, stock.currency)} – ${money(a.tech.high52, stock.currency)}; ${pctPlain(a.tech.fromHigh, 1)} from the high`,
      `Technicals: trend ${a.tech.trend} (weekly ${a.tech.weeklyTrend}); RSI14 ${num(a.tech.rsi14, 1)}; MACD ${a.tech.macd.state}; ATR14 ${money(a.tech.atr14, stock.currency, 2)} (${pctPlain(a.tech.atrPct, 1)} of price)`,
      `DMA: 20 ${n2(a.tech.ma.s20)} / 50 ${n2(a.tech.ma.s50)} / 100 ${n2(a.tech.ma.s100)} / 200 ${n2(a.tech.ma.s200)}`,
      `Swing support ${n2(a.tech.support)}, resistance ${n2(a.tech.resistance)}`,
      a.tech.rs ? `Relative strength vs index: 3m ${pctPlain(a.tech.rs.m3, 1)}, 12m ${pctPlain(a.tech.rs.m12, 1)}` : '',
      a.val.ok ? `Scenarios: bull ${money(a.val.rows[0].target, stock.currency)} (${a.val.rows[0].prob}%), base ${money(a.val.rows[1].target, stock.currency)} (${a.val.rows[1].prob}%), bear ${money(a.val.rows[2].target, stock.currency)} (${a.val.rows[2].prob}%); weighted ${money(a.val.weightedTarget, stock.currency)}; expected return ${pctPlain(a.val.expectedReturn, 1)}` : 'Valuation: EPS unavailable, no target computed',
      a.val.ok ? `Reverse DCF at 11% WACC / 4% terminal growth implies ${pctPlain(a.val.impliedGrowth * 100, 1)} five-year EPS growth` : '',
      `Engine rating: ${a.rating}; confidence ${a.conf.score}/10; invalidation ${money(a.plan.stop, stock.currency)}; R:R ${n2(a.plan.rr)}`,
      `Missing in this data set: segment mix, moat evidence, governance history, analyst targets, shareholding trend, dated news, results date.`
    ].filter(Boolean);
    return lines.join('\n');
  }

  async function copyPrompt() {
    const text = `${PROMPT_CORE}\n\nDATA (fetched ${new Date().toLocaleString('en-GB')}, free sources: Yahoo Finance and Screener.in)\n${dataBlock()}`;
    try {
      await navigator.clipboard.writeText(text);
      U.toast('Prompt and data copied — paste into any AI you already use.');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); U.toast('Copied.'); } catch (err) { U.toast('Copy failed — select the text from the console instead.'); }
      ta.remove();
    }
  }

  function downloadMarkdown() {
    const a = state.analysis, stock = state.stock;
    const md = [
      `# ${stock.name} (${stock.symbol})`,
      ``,
      `*${a.rating} · confidence ${a.conf.score}/10 · close ${money(a.tech.price, stock.currency)} (${stock.asOf})*`,
      ``,
      `## A. Bottom line`,
      thesis(a).replace(/<[^>]+>/g, ''),
      ``,
      `- 12M target: ${a.val.ok ? money(a.val.rows[1].target, stock.currency) : 'N/A'}`,
      `- Expected return: ${a.val.ok ? pctPlain(a.val.expectedReturn, 1) : 'N/A'}`,
      `- Invalidation: ${money(a.plan.stop, stock.currency)}`,
      `- Reward:risk ${num(a.plan.rr, 2)}:1`,
      ``,
      `## B. Snapshot`,
      dataBlock(),
      ``,
      `## G. Technicals`,
      `Trend ${a.tech.trend}; weekly ${a.tech.weeklyTrend}; RSI ${num(a.tech.rsi14, 1)}; support ${money(a.tech.support, stock.currency)}; resistance ${money(a.tech.resistance, stock.currency)}.`,
      ``,
      a.val.ok ? `## K. Scenarios\n\n| Scenario | Probability | Growth | Exit P/E | Target | Return |\n|---|---|---|---|---|---|\n` +
        a.val.rows.map(r => `| ${r.label} | ${r.prob}% | ${pctPlain(r.growth, 1)} | ${num(r.pe, 0)}× | ${money(r.target, stock.currency)} | ${pct(r.total, 1)} |`).join('\n') : '',
      ``,
      `## J. Risks`,
      a.risks.map((r, i) => `${i + 1}. **${r.title}** (${r.p} probability, ${r.i} impact) — ${r.detail}`).join('\n'),
      ``,
      `## M. Trade plan`,
      `Entry ${a.plan.entry.map(t => `${money(t.price, stock.currency)} (${t.weight}%)`).join(' / ')}; stop ${money(a.plan.stop, stock.currency)}; T1 ${money(a.plan.t1, stock.currency)}; T2 ${money(a.plan.t2, stock.currency)}; size ${pctPlain(a.plan.size, 1)} of portfolio.`,
      ``,
      `## O. Verdict`,
      `**${a.rating}**, confidence ${a.conf.score}/10. ${a.plan.qualifies ? `Reward:risk ${num(a.plan.rr, 2)}:1 clears the 2:1 bar at the current price.` : `Reward:risk ${num(a.plan.rr, 2)}:1 is below the 2:1 bar at the current price.`}`,
      ``,
      `---`,
      `Generated by Monolith on ${new Date().toLocaleString('en-GB')}. Free sources: Yahoo Finance, Screener.in. Analysis for informational purposes, not personalised investment advice. Verify before trading. Investment disclaimer: this note is educational and informational only. It is not a research report, not a prospectus, and not a recommendation to buy, sell or hold. Nothing here is investment advice, a solicitation, or a forecast of returns. Figures come from free third-party sources that are not verified for accuracy and may be incomplete, stale or incorrect. Consult a qualified SEBI-registered investment adviser and read the company's own filings before acting on any figure or rating.`
    ].filter(x => x != null && x !== false).join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${stock.symbol.replace(/\./g, '-')}-ledger-report.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    U.toast('Report downloaded.');
  }

  /* ---------------- loading ---------------- */

  async function indexRowsFor(stock) {
    const key = stock.isIndia ? '^NSEI' : '^GSPC';
    if (indexCache.has(key)) return indexCache.get(key);
    try {
      const chart = await LG.stock.loadStock(key, { market: 'ANY' });
      indexCache.set(key, chart.rows);
      return chart.rows;
    } catch (e) {
      return null;
    }
  }

  async function loadSymbol(symbol, { force = false } = {}) {
    showView('report');
    $('#reportHead').innerHTML = `<p class="kicker"><span class="rule-inline"></span>Fetching ${esc(symbol)}</p><p class="lede">Prices, five years of bars and the fundamentals. This takes a few seconds on the public route.</p>`;
    $('#reportBody').innerHTML = '';
    $('#reportNav').innerHTML = '';
    try {
      let stock = cache.get(symbol);
      if (!stock || force) {
        if (force) U.toast('Refreshing from source…');
        stock = await LG.stock.loadStock(symbol);
        cache.set(stock.symbol, stock);
      }
      state.stock = stock;
      state.opts = {};
      state.indexRows = await indexRowsFor(stock);
      state.analysis = E.analyse(stock, state.indexRows, state.opts);
      renderReport();
      document.title = `${stock.name} — Monolith v2`;
      updateFoot();
      history.replaceState(null, '', `#/s/${encodeURIComponent(stock.symbol)}`);
    } catch (e) {
      $('#reportHead').innerHTML = '';
      $('#reportBody').innerHTML = `<div class="error"><strong>Could not load ${esc(symbol)}.</strong><br>${esc(e.message)}</div>
        <p class="hint">If this is a rate limit, wait a minute or add a proxy URL in Settings. The included worker makes the route private and unlimited within the free tier.</p>
        <p><button class="ghost" type="button" onclick="location.hash='#/'">Back</button></p>`;
      U.toast('Load failed — see the message on the page.', 4200);
    }
  }

  /* ---------------- watchlist ---------------- */

  function isWatched(symbol) { return state.watch.some(w => w.symbol === symbol); }

  const cleanName = (w) => String((w && w.name) || (w && w.symbol) || '').replace(/ Ltd\.?$/, '');

  function saveWatch() {
    U.store('watchlist', state.watch);
    renderHomeWatch();
    renderWatchChips();
  }

  function addWatch(symbol, name) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return false;
    if (isWatched(sym)) { U.toast(`${sym} is already on the watchlist.`); return false; }
    state.watch = state.watch.concat([{ symbol: sym, name: name || sym }]);
    saveWatch();
    return true;
  }

  function removeWatch(symbol) {
    const before = state.watch.length;
    state.watch = state.watch.filter(w => w.symbol !== symbol);
    if (state.watch.length === before) return;
    saveWatch();
    // Drop the stored row too, so a deleted name cannot reappear in the table
    // on the next visit.
    const rows = (U.store('lastRows') || []).filter(r => r.symbol !== symbol);
    U.store('lastRows', rows);
    renderWatchRows(rows);
  }

  function toggleWatch(stock) {
    // `was` has to be read before the list changes: the old toast checked
    // membership afterwards and always claimed the opposite of what happened.
    const was = isWatched(stock.symbol);
    if (was) state.watch = state.watch.filter(w => w.symbol !== stock.symbol);
    else state.watch = state.watch.concat([{ symbol: stock.symbol, name: stock.name }]);
    saveWatch();
    U.toast(was ? 'Removed from watchlist.' : 'Added to watchlist.');
  }

  function renderHomeWatch() {
    const wrap = $('#homeWatch'), row = $('#homeWatchRow');
    if (!wrap || !row) return;
    wrap.hidden = state.watch.length === 0;
    row.innerHTML = state.watch.map(w => `<button class="chip" type="button" data-sym="${esc(w.symbol)}"><span>${esc(cleanName(w))}</span><span class="r">${esc(w.symbol)}</span></button>`).join('');
    row.querySelectorAll('[data-sym]').forEach(b => b.addEventListener('click', () => loadSymbol(b.dataset.sym)));
  }

  // The watchlist page shows the list itself, with a way out of each entry.
  // Before this, adding a name only produced a toast and the name vanished
  // from sight until a batch run had finished.
  function renderWatchChips() {
    const wrap = $('#watchList');
    if (!wrap) return;
    if (!state.watch.length) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = state.watch.map(w => `<span class="wchip">
        <b>${esc(cleanName(w))}</b><span class="s">${esc(w.symbol)}</span>
        <button type="button" data-rm="${esc(w.symbol)}" aria-label="Remove ${esc(cleanName(w))}">✕</button>
      </span>`).join('');
    wrap.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => removeWatch(b.dataset.rm)));
  }

  async function runWatchlist() {
    const body = $('#watchBody');
    if (!state.watch.length) {
      body.innerHTML = `<p class="batch-empty">Your watchlist is empty. Add a ticker above first.</p>`;
      return;
    }
    const btn = $('#watchRun');
    if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
    body.innerHTML = `<p class="lede">Running ${state.watch.length} names, one at a time, so the free data route is not rate limited.</p>`;
    const rows = [];
    try {
      for (const w of state.watch.slice()) {
        try {
          const stock = cache.get(w.symbol) || await LG.stock.loadStock(w.symbol);
          cache.set(stock.symbol, stock);
          // A ticker added by symbol gets the real company name on first run,
          // and the resolved symbol replaces the bare ticker. Without the
          // second half, "BPCL" and "BPCL.NS" are two different watchlist
          // entries and the report's toggle button cannot see the match.
          if (w.symbol !== stock.symbol || !w.name || w.name === w.symbol) {
            state.watch = normaliseWatch(state.watch.map(x => x.symbol === w.symbol
              ? { symbol: stock.symbol, name: stock.name || x.name }
              : x));
            U.store('watchlist', state.watch);
            renderWatchChips();
          }
          const idx = await indexRowsFor(stock);
          const a = E.analyse(stock, idx, {});
          const prev = U.store('last.' + stock.symbol);
          const delta = prev ? a.rating !== prev.rating || Math.abs(a.tech.price / prev.price - 1) > 0.02 : false;
          rows.push({
            symbol: stock.symbol,
            name: stock.name,
            currency: stock.currency,
            price: a.tech.price,
            changePct: a.tech.changePct,
            target: a.val.ok ? a.val.rows[1].target : null,
            expectedReturn: a.val.ok ? a.val.expectedReturn : null,
            rating: a.rating,
            conf: a.conf.score,
            delta
          });
          U.store('last.' + stock.symbol, { rating: a.rating, price: a.tech.price, at: Date.now() });
        } catch (e) {
          rows.push({ error: e.message, symbol: w.symbol, name: w.symbol });
        }
        renderWatchRows(rows);
        U.store('lastRows', rows);
        await new Promise(r => setTimeout(r, 350));
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Run report'; }
    }
  }

  function renderWatchRows(rows) {
    const body = $('#watchBody');
    if (!body) return;
    if (!rows.length) { body.innerHTML = `<p class="batch-empty">Nothing yet. Add a ticker and run the report.</p>`; return; }
    body.innerHTML = `<div class="batch-row head"><div>Name</div><div>Close</div><div>Target</div><div>Exp. return</div><div>Rating</div><div></div></div>` +
      rows.map(r => {
        if (r.error) return `<div class="batch-row"><div class="name">${esc(r.symbol)}<small>failed</small></div><div class="cell" style="grid-column:2/-1"><span class="tag na">${esc(r.error)}</span></div></div>`;
        const clean = String(r.name || r.symbol).replace(/ Ltd\.?$/, '');
        return `<div class="batch-row">
          <div class="name">${esc(clean)}<small>${esc(r.symbol)}${r.delta ? ' · changed' : ''}</small></div>
          <div class="cell">${money(r.price, r.currency)}<small class="${signClass(r.changePct)}">${pct(r.changePct, 2)}</small></div>
          <div class="cell">${r.target != null ? money(r.target, r.currency) : 'N/A'}<small>${r.target != null ? pct((r.target / r.price - 1) * 100, 1) : ''}</small></div>
          <div class="cell ${r.expectedReturn != null ? signClass(r.expectedReturn) : ''}">${r.expectedReturn != null ? pct(r.expectedReturn, 1) : 'N/A'}<small>conf ${r.conf}</small></div>
          <div class="cell">${ratingBadge(r.rating)}</div>
          <div class="cell"><button class="ghost" type="button" data-goto="${esc(r.symbol)}">Open</button></div>
        </div>`;
      }).join('');
    body.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => loadSymbol(b.dataset.goto)));
  }

  /* ---------------- compare ---------------- */

  async function runCompare(one, two) {
    const body = $('#compareBody');
    body.innerHTML = `<p class="lede">Loading both names…</p>`;
    try {
      const [s1, s2] = await Promise.all([LG.stock.loadStock(one), LG.stock.loadStock(two)]);
      const i1 = await indexRowsFor(s1), i2 = await indexRowsFor(s2);
      const a1 = E.analyse(s1, i1, {}), a2 = E.analyse(s2, i2, {});
      const row = (label, f1, f2, cls) => `<div class="k">${esc(label)}</div><div class="v ${cls || ''}">${f1}</div><div class="v ${cls || ''}">${f2}</div>`;
      const m = (a, s) => money(a.tech.price, s.currency);
      const better = (x1, x2, invert) => {
        if (!U.isNum(x1) || !U.isNum(x2)) return '';
        return invert ? (x1 < x2 ? 'num-up' : '') : (x1 > x2 ? 'num-up' : '');
      };
      body.innerHTML = `
        <div class="compare-grid">
          <div class="k">Metric</div><div class="k">${esc(s1.name)}</div><div class="k">${esc(s2.name)}</div>
          ${row('Rating', ratingBadge(a1.rating), ratingBadge(a2.rating))}
          ${row('Close', m(a1, s1), m(a2, s2))}
          ${row('Expected return', a1.val.ok ? pct(a1.val.expectedReturn, 1) : 'N/A', a2.val.ok ? pct(a2.val.expectedReturn, 1) : 'N/A', better(a1.val.expectedReturn, a2.val.expectedReturn))}
          ${row('12M target', a1.val.ok ? money(a1.val.rows[1].target, s1.currency) : 'N/A', a2.val.ok ? money(a2.val.rows[1].target, s2.currency) : 'N/A')}
          ${row('P/E', fv(s1, 'pe') != null ? num(fv(s1, 'pe'), 1) + '×' : 'N/A', fv(s2, 'pe') != null ? num(fv(s2, 'pe'), 1) + '×' : 'N/A', better(fv(s1, 'pe'), fv(s2, 'pe'), true))}
          ${row('ROE', fv(s1, 'roe') != null ? pctPlain(fv(s1, 'roe'), 1) : 'N/A', fv(s2, 'roe') != null ? pctPlain(fv(s2, 'roe'), 1) : 'N/A', better(fv(s1, 'roe'), fv(s2, 'roe')))}
          ${row('Trend', a1.tech.trend, a2.tech.trend)}
          ${row('Confidence', a1.conf.score + '/10', a2.conf.score + '/10')}
          ${row('Reward:risk', num(a1.plan.rr, 2) + ':1', num(a2.plan.rr, 2) + ':1')}
          ${row('Invalidation', money(a1.plan.stop, s1.currency), money(a2.plan.stop, s2.currency))}
        </div>
        <div class="verdict"><span class="k">The decisive call</span><p>${verdictText(a1, s1, a2, s2)}</p></div>`;
    } catch (e) {
      body.innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  }

  function verdictText(a1, s1, a2, s2) {
    if (!a1.val.ok || !a2.val.ok) {
      return `${esc(s1.name)} and ${esc(s2.name)} cannot be ranked on valuation because earnings data is missing for ${!a1.val.ok && !a2.val.ok ? 'both' : !a1.val.ok ? esc(s1.name) : esc(s2.name)}. On trend and risk alone, ${esc((a1.conf.score >= a2.conf.score ? s1 : s2).name)} carries the higher-confidence setup (${Math.max(a1.conf.score, a2.conf.score)}/10).`;
    }
    const score = (a) => a.val.expectedReturn + (a.conf.score - 5) * 2 + (a.plan.rr >= 2 ? 3 : 0);
    const win = score(a1) >= score(a2) ? { a: a1, s: s1 } : { a: a2, s: s2 };
    const lose = win.a === a1 ? { a: a2, s: s2 } : { a: a1, s: s1 };
    return `${esc(win.s.name)} is the better buy now: ${pct(win.a.val.expectedReturn, 1)} expected return at ${win.a.conf.score}/10 confidence, against ${pct(lose.a.val.expectedReturn, 1)} at ${lose.a.conf.score}/10 for ${esc(lose.s.name)}. ${win.a.plan.qualifies ? 'Its reward:risk clears 2:1.' : 'Neither clears 2:1 reward:risk, so this is a watch, not a chase.'}`;
  }

  /* ---------------- manual fundamentals ---------------- */

  let manualSymbol = null;
  function openManual() {
    if (!state.stock) return;
    manualSymbol = state.stock.symbol;
    const m = U.store('manual.' + manualSymbol) || {};
    $('#manualFor').textContent = `${state.stock.name} (${manualSymbol}) — everything here is optional.`;
    const set = (id, k) => { $('#' + id).value = m[k] != null ? m[k] : ''; };
    set('mPe', 'pe'); set('mEps', 'eps'); set('mRoe', 'roe'); set('mRoce', 'roce');
    set('mDe', 'debtEquity'); set('mDiv', 'divYield'); set('mMcap', 'marketCap'); set('mPromoter', 'promoter');
    $('#manualModal').hidden = false;
  }

  function saveManual() {
    const read = (id) => { const v = $('#' + id).value.trim(); return v === '' ? null : Number(v); };
    const data = {
      pe: read('mPe'), eps: read('mEps'), roe: read('mRoe'), roce: read('mRoce'),
      debtEquity: read('mDe'), divYield: read('mDiv'), marketCap: read('mMcap'), promoter: read('mPromoter')
    };
    U.store('manual.' + manualSymbol, data);
    $('#manualModal').hidden = true;
    cache.delete(manualSymbol);
    loadSymbol(manualSymbol, { force: true });
    U.toast('Applied. Values you entered are marked "yours".');
  }

  /* ---------------- settings ---------------- */

  function openSettings() {
    const s = U.settings();
    $('#setCap').value = s.cap;
    $('#setRisk').value = s.risk;
    $('#setHurdle').value = s.hurdle;
    $('#setProxy').value = s.proxy || '';
    $('#setMarket').value = s.market;
    $('#settingsModal').hidden = false;
  }

  function saveSettingsModal() {
    U.saveSettings({
      cap: U.clamp(Number($('#setCap').value) || 10, 1, 25),
      risk: U.clamp(Number($('#setRisk').value) || 1, 0.25, 5),
      hurdle: U.clamp(Number($('#setHurdle').value) || 15, 0, 50),
      proxy: $('#setProxy').value.trim(),
      market: $('#setMarket').value
    });
    $('#settingsModal').hidden = true;
    LG.data.detectRoute(true).then(() => {
      updateFoot();
      if (state.analysis) {
        state.analysis = E.analyse(state.stock, state.indexRows, state.opts);
        renderReport();
      }
    });
    U.toast('Settings saved.');
  }

  /* ---------------- routing ---------------- */

  function showView(name) {
    const map = { home: 'viewHome', report: 'viewReport', watchlist: 'viewWatchlist', compare: 'viewCompare', method: 'viewMethod' };
    Object.keys(map).forEach(k => { $('#' + map[k]).hidden = k !== name; });
    $$('.topnav a').forEach(a => a.removeAttribute('aria-current'));
    const nav = document.querySelector(`.topnav a[data-nav="${name === 'report' ? 'home' : name}"]`);
    if (nav) nav.setAttribute('aria-current', 'page');
  }

  async function route() {
    const hash = location.hash || '#/';
    if (hash.startsWith('#/s/')) {
      const sym = decodeURIComponent(hash.slice(4));
      showView('report');
      if (!state.stock || state.stock.symbol !== sym) await loadSymbol(sym);
      return;
    }
    if (hash === '#/watchlist') { showView('watchlist'); renderWatchPage(); return; }
    if (hash === '#/compare') { showView('compare'); return; }
    if (hash === '#/method') { showView('method'); return; }
    showView('home');
    renderHomeWatch();
    document.title = 'Monolith v2 — equity research, on the record';
  }

  function renderWatchPage() {
    renderWatchChips();
    const rows = (U.store('lastRows') || []).filter(r => !r.symbol || isWatched(r.symbol));
    renderWatchRows(rows);
  }

  function updateFoot() {
    const el = $('#footMeta');
    if (!el) return;
    el.textContent = `route ${LG.data.Route.label} · generated ${new Date().toLocaleString('en-GB')} · ${state.stock ? state.stock.provenance.length + ' sources' : 'no report loaded'}`;
  }

  /* ---------------- suggestions ---------------- */

  // One implementation for every stock field: the hero search, the top-bar
  // panel, the watchlist box and both compare inputs.
  //
  // Picking a row listens on pointerdown and calls preventDefault. The old
  // version listened for click, so the input blurred first, a 180 ms timer
  // hid the list, and the click landed on nothing — the reported "I can't
  // click the stock after I search it".
  function attachSuggest(input, box, onPick) {
    if (!input || !box) return { close() {}, hits: () => [] };

    let hits = [];
    let active = -1;

    const mark = () => box.querySelectorAll('[data-i]')
      .forEach(n => n.setAttribute('aria-selected', String(Number(n.dataset.i) === active)));
    const open = () => { box.hidden = false; input.setAttribute('aria-expanded', 'true'); };
    const close = () => { box.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };

    const paint = () => {
      box.innerHTML = hits.map((h, i) => `<button type="button" role="option" aria-selected="${i === active}" data-i="${i}">`
        + `<span>${esc(h.name)}</span><span class="sym">${esc(h.symbol)}</span><span class="ex">${esc(h.exchange)}</span></button>`).join('');
    };

    const pick = (i) => {
      const h = hits[i];
      if (!h) return;
      input.value = h.symbol;
      close();
      onPick(h);
    };

    const run = U.debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { hits = []; close(); return; }
      try {
        const found = await LG.stock.searchSymbols(q);
        // A slow request must not overwrite a newer query.
        if (input.value.trim() !== q) return;
        hits = found || [];
        active = -1;
        if (!hits.length) { close(); return; }
        paint();
        open();
      } catch (e) { hits = []; close(); }
    }, 260);

    input.addEventListener('input', run);
    input.addEventListener('focus', () => { if (hits.length) open(); });

    box.addEventListener('pointerdown', (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b) return;
      ev.preventDefault();
      pick(Number(b.dataset.i));
    });
    box.addEventListener('mousemove', (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (i === active) return;
      active = i;
      mark();
    });

    input.addEventListener('keydown', (ev) => {
      if (box.hidden) {
        if (ev.key === 'ArrowDown' && hits.length) { ev.preventDefault(); paint(); open(); mark(); }
        return;
      }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); active = Math.min(hits.length - 1, active + 1); mark(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); active = Math.max(0, active - 1); mark(); }
      else if (ev.key === 'Enter' && active >= 0) { ev.preventDefault(); pick(active); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    });

    document.addEventListener('pointerdown', (ev) => {
      if (box.hidden) return;
      if (box.contains(ev.target) || ev.target === input) return;
      close();
    });

    return { close, hits: () => hits };
  }

  /* ---------------- top-bar search ---------------- */

  function initSearchPanel() {
    const btn = $('#searchBtn'), panel = $('#searchPanel');
    const input = $('#globalTicker'), form = $('#searchPanelForm'), closeBtn = $('#closeSearch');
    if (!btn || !panel || !input || !form) return;

    const box = $('#globalSuggest');
    const suggest = attachSuggest(input, box, (h) => { hide(); loadSymbol(h.symbol); });

    function show() {
      const bar = $('.topbar');
      if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
      panel.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      input.focus();
      input.select();
    }
    function hide() {
      panel.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      suggest.close();
    }

    btn.addEventListener('click', () => { if (panel.hidden) show(); else hide(); });
    if (closeBtn) closeBtn.addEventListener('click', hide);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      hide();
      loadSymbol(v);
    });

    document.addEventListener('keydown', (ev) => {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tag);
      if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); show(); return; }
      if (ev.key === '/' && !typing) { ev.preventDefault(); show(); return; }
      if (ev.key === 'Escape' && !panel.hidden) hide();
    });

    document.addEventListener('pointerdown', (ev) => {
      if (panel.hidden) return;
      if (panel.contains(ev.target) || btn.contains(ev.target)) return;
      hide();
    });

    // A route change is a new page; the panel should not float over it.
    window.addEventListener('hashchange', hide);
  }

  /* ---------------- events ---------------- */

  function wire() {
    const heroInput = $('#ticker');
    const heroSuggest = attachSuggest(heroInput, $('#suggest'), (h) => loadSymbol(h.symbol));

    $('#searchForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = heroInput.value.trim();
      if (!v) return;
      heroSuggest.close();
      loadSymbol(v);
    });

    $$('[data-quick]').forEach(b => b.addEventListener('click', () => loadSymbol(b.dataset.quick)));
    const days = $('#daysBtn');
    if (days) days.addEventListener('click', () => { location.hash = '#/watchlist'; });

    const watchInput = $('#watchInput');
    attachSuggest(watchInput, $('#watchSuggest'), (h) => {
      if (addWatch(h.symbol, h.name)) U.toast(`${h.symbol} added. Run the report when ready.`);
      watchInput.value = '';
      watchInput.focus();
      renderWatchRows((U.store('lastRows') || []).filter(r => r.symbol !== h.symbol));
    });

    $('#watchForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const v = watchInput.value.trim();
      if (!v) { watchInput.focus(); return; }
      if (addWatch(v, v)) {
        watchInput.value = '';
        U.toast(`Added. Run the report to fetch it.`);
      }
      watchInput.focus();
    });
    $('#watchRun').addEventListener('click', runWatchlist);
    $('#watchClear').addEventListener('click', () => {
      if (!state.watch.length) { U.toast('The watchlist is already empty.'); return; }
      state.watch = [];
      saveWatch();
      U.store('lastRows', []);
      renderWatchRows([]);
      U.toast('Watchlist cleared.');
    });

    $('#compareForm').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const a = $('#cmpA').value.trim(), b = $('#cmpB').value.trim();
      if (!a || !b) { U.toast('Two tickers, please.'); return; }
      runCompare(a, b);
    });
    attachSuggest($('#cmpA'), $('#cmpASuggest'), () => {});
    attachSuggest($('#cmpB'), $('#cmpBSuggest'), () => {});

    $('#settingsBtn').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', () => { $('#settingsModal').hidden = true; });
    $('#saveSettings').addEventListener('click', saveSettingsModal);
    $('#resetSettings').addEventListener('click', () => {
      U.drop('settings');
      openSettings();
      U.toast('Reset to defaults.');
    });
    $('#closeManual').addEventListener('click', () => { $('#manualModal').hidden = true; });
    $('#saveManual').addEventListener('click', saveManual);
    $('#clearManual').addEventListener('click', () => {
      U.drop('manual.' + manualSymbol);
      $('#manualModal').hidden = true;
      cache.delete(manualSymbol);
      loadSymbol(manualSymbol, { force: true });
    });

    $$('.modal').forEach(m => m.addEventListener('click', (ev) => { if (ev.target === m) m.hidden = true; }));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') $$('.modal').forEach(m => { m.hidden = true; });
    });

    window.addEventListener('hashchange', route);
  }

  /* ---------------- hero ---------------- */

  // The hero carries the two Lithos frames: a dark rock ridge, and the same
  // ridge in bloom. The second is masked to the cursor, so the ground turns
  // green where you look. Both are black-background frames, so they are
  // screened over the bottle green rather than pasted as black boxes.

  // Keeps the hero exactly one screen tall whatever the topbar measures.
  function sizeHero() {
    const bar = $('.topbar');
    if (!bar) return;
    document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
  }

  // Lithos spotlight: a radial mask that trails the pointer. Touch and reduced
  // motion keep the lit frame in full instead of chasing a cursor that is not there.
  function initHero() {
    const hero = $('#hero'), reveal = $('#heroReveal');
    if (!hero) return;

    sizeHero();
    window.addEventListener('resize', sizeHero);

    if (!reveal || !window.matchMedia) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (matchMedia('(pointer: coarse)').matches) return;

    hero.classList.add('spotlight');

    const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
    let started = false, raf = null;
    const tick = () => {
      cur.x += (target.x - cur.x) * 0.14;
      cur.y += (target.y - cur.y) * 0.14;
      reveal.style.setProperty('--mx', cur.x.toFixed(1) + 'px');
      reveal.style.setProperty('--my', cur.y.toFixed(1) + 'px');
      const settled = Math.abs(target.x - cur.x) < 0.4 && Math.abs(target.y - cur.y) < 0.4;
      raf = settled ? null : requestAnimationFrame(tick);
    };
    hero.addEventListener('pointermove', (ev) => {
      const r = hero.getBoundingClientRect();
      target.x = ev.clientX - r.left;
      target.y = ev.clientY - r.top;
      if (!started) {
        started = true;
        cur.x = target.x; cur.y = target.y;
      }
      hero.classList.remove('out');
      if (!raf) raf = requestAnimationFrame(tick);
    });
    hero.addEventListener('pointerleave', () => hero.classList.add('out'));
  }

  function boot() {
    wire();
    initHero();
    initSearchPanel();
    LG.data.detectRoute().then(() => {
      const pill = $('#routePill');
      if (pill) pill.classList.add('live');
      updateFoot();
    });
    renderHomeWatch();
    renderWatchChips();
    route();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  LG.app = { loadSymbol, runWatchlist, runCompare, state };
})();
