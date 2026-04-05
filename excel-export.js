'use strict';
const XLSX = require('xlsx');

function parseJSON(str, fallback) {
  try { return JSON.parse(str || JSON.stringify(fallback)); } catch (e) { return fallback; }
}

function generateBudgetExcel(db, tenantId) {
  // ── Fetch data ────────────────────────────────────────────────────────────
  const partnerQuery = tenantId
    ? "SELECT * FROM partners WHERE tenant_id = ? ORDER BY id"
    : "SELECT * FROM partners ORDER BY id";
  const rawPartners = tenantId
    ? db.prepare(partnerQuery).all(tenantId)
    : db.prepare(partnerQuery).all();

  const wpQuery = tenantId
    ? "SELECT * FROM wps WHERE tenant_id = ? ORDER BY sort_order"
    : "SELECT * FROM wps ORDER BY sort_order";
  const wps = tenantId
    ? db.prepare(wpQuery).all(tenantId)
    : db.prepare(wpQuery).all();

  const tasks = db.prepare("SELECT * FROM tasks ORDER BY wp_id, sort_order").all();
  wps.forEach(wp => { wp.tasks = tasks.filter(t => t.wp_id === wp.id); });

  // Build task→WP map
  const taskToWp = {};
  wps.forEach(wp => wp.tasks.forEach(t => { taskToWp[t.id] = wp.id; }));

  // Settings
  const getSetting = (key, def) => {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row ? row.value : def;
  };
  const indirectPct = parseFloat(getSetting('indirect_cost_percentage', '25')) / 100;
  const projectMonths = parseFloat(getSetting('project_duration_months', '48'));

  // Parse partners
  const partners = rawPartners.map(p => ({
    ...p,
    wp_data: parseJSON(p.wp_data, {}),
    travel_meetings: parseJSON(p.travel_meetings, []),
    travel_dissem: parseJSON(p.travel_dissem, []),
    other_costs: parseJSON(p.other_costs, []),
    subcontracting_costs: parseJSON(p.subcontracting_costs, []),
  }));

  // ── Compute per-partner financials ────────────────────────────────────────
  function calcPartner(p) {
    const wpData = p.wp_data || {};
    let totalPM = 0;
    Object.values(wpData).forEach(v => { totalPM += Number(v) || 0; });
    const rate = Number(p.rate) || 0;
    const pmCost = totalPM * rate;

    const travel = [
      ...(p.travel_meetings || []),
      ...(p.travel_dissem || []),
    ];
    const travelTotal = travel.reduce((s, t) => s + (Number(t.cost) || 0), 0);
    const otherTotal = (p.other_costs || []).reduce((s, o) => s + (Number(o.cost) || 0), 0);
    const otherCost = travelTotal + otherTotal;
    const sub = (p.subcontracting_costs || []).reduce((s, c) => s + (Number(c.cost) || 0), 0);

    const tdc = pmCost + otherCost + sub;
    const indirect = (pmCost + otherCost) * indirectPct;
    const totalBudget = tdc + indirect;
    const fundingRate = Number(p.funding_rate) || 1;
    const totalFunding = totalBudget * fundingRate;
    const personsYear = projectMonths > 0 ? (totalPM / projectMonths) * 12 : 0;

    // PM per WP
    const pmPerWp = {};
    wps.forEach(wp => {
      let wpPm = 0;
      wp.tasks.forEach(t => { wpPm += Number(wpData[t.id]) || 0; });
      pmPerWp[wp.id] = wpPm;
    });

    return { totalPM, rate, pmCost, otherCost, sub, tdc, indirect, totalBudget, fundingRate, totalFunding, personsYear, pmPerWp };
  }

  const computed = partners.map(p => ({ p, c: calcPartner(p) }));

  // ── Helpers ───────────────────────────────────────────────────────────────
  const EUR = v => Math.round(Number(v) || 0);
  const NUM = v => Math.round((Number(v) || 0) * 100) / 100;

  function makeSheet(aoa) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    return ws;
  }

  // ── Sheet 1: Resources ────────────────────────────────────────────────────
  function buildResourcesSheet() {
    const rows = [];

    // --- Section 1: Partner rates ---
    rows.push(['#', 'Partner', 'PIC', 'Monthly Rate (€/month)']);
    partners.forEach((p, i) => {
      rows.push([i + 1, p.name, p.pic || '', Number(p.rate) || 0]);
    });
    rows.push([]); // blank

    // --- Section 2: PM per WP ---
    rows.push([]);
    const wpHeader = ['#', 'Partner', ...wps.map(w => w.name), 'Total PM', 'Persons/year'];
    rows.push(wpHeader);
    const wpColTotals = Array(wps.length).fill(0);
    let grandTotalPM = 0;
    computed.forEach(({ p, c }, i) => {
      const wpVals = wps.map((w, wi) => {
        const v = c.pmPerWp[w.id] || 0;
        wpColTotals[wi] += v;
        return NUM(v);
      });
      grandTotalPM += c.totalPM;
      rows.push([i + 1, p.name, ...wpVals, NUM(c.totalPM), NUM(c.personsYear)]);
    });
    // Grand total row
    const grandPY = projectMonths > 0 ? (grandTotalPM / projectMonths) * 12 : 0;
    rows.push(['', 'TOTAL', ...wpColTotals.map(v => NUM(v)), NUM(grandTotalPM), NUM(grandPY)]);
    rows.push([]);

    // --- Section 3: Budget summary ---
    rows.push([]);
    rows.push(['#', 'Partner', 'PM Cost (€)', 'Other Direct Cost (€)', 'Subcontracting (€)', 'TDC (€)', 'Indirect Cost (€)', 'Total Budget (€)', 'Funding Rate', 'Total Funding (€)', 'Total PM', 'Type', 'Country']);
    let gPmCost = 0, gOther = 0, gSub = 0, gTdc = 0, gIndirect = 0, gBudget = 0, gFunding = 0, gTotalPM = 0;
    computed.forEach(({ p, c }, i) => {
      rows.push([
        i + 1, p.name,
        EUR(c.pmCost), EUR(c.otherCost), EUR(c.sub),
        EUR(c.tdc), EUR(c.indirect), EUR(c.totalBudget),
        c.fundingRate, EUR(c.totalFunding),
        NUM(c.totalPM), p.type || '', p.country || ''
      ]);
      gPmCost += c.pmCost; gOther += c.otherCost; gSub += c.sub;
      gTdc += c.tdc; gIndirect += c.indirect; gBudget += c.totalBudget;
      gFunding += c.totalFunding; gTotalPM += c.totalPM;
    });
    rows.push(['', 'GRAND TOTAL', EUR(gPmCost), EUR(gOther), EUR(gSub), EUR(gTdc), EUR(gIndirect), EUR(gBudget), '', EUR(gFunding), NUM(gTotalPM), '', '']);

    return makeSheet(rows);
  }

  // ── Sheet 2: PM per task ──────────────────────────────────────────────────
  function buildPmPerTaskSheet() {
    const rows = [];
    const pNames = partners.map(p => p.name);

    wps.forEach(wp => {
      // WP header
      rows.push([wp.name, ...pNames, 'Total PM']);
      // Task rows
      wp.tasks.forEach(t => {
        const vals = partners.map(p => NUM(Number((p.wp_data || {})[t.id]) || 0));
        const rowTotal = vals.reduce((s, v) => s + v, 0);
        rows.push([t.name, ...vals, NUM(rowTotal)]);
      });
      // WP subtotal
      const wpTotals = partners.map(p => {
        let s = 0;
        wp.tasks.forEach(t => { s += Number((p.wp_data || {})[t.id]) || 0; });
        return NUM(s);
      });
      const wpGrand = wpTotals.reduce((s, v) => s + v, 0);
      rows.push([`${wp.name} Total`, ...wpTotals, NUM(wpGrand)]);
      rows.push([]); // blank between WPs
    });

    // Grand totals row
    const grandTotals = partners.map(p => {
      let s = 0;
      Object.values(p.wp_data || {}).forEach(v => { s += Number(v) || 0; });
      return NUM(s);
    });
    const grandSum = grandTotals.reduce((s, v) => s + v, 0);
    rows.push(['GRAND TOTAL', ...grandTotals, NUM(grandSum)]);

    return makeSheet(rows);
  }

  // ── Sheet 3: Other direct cost ────────────────────────────────────────────
  function buildOtherCostSheet() {
    const rows = [];

    // Summary by partner
    rows.push(['Partner', 'Other Direct Cost (€)']);
    let gOther = 0;
    computed.forEach(({ p, c }) => {
      rows.push([p.name, EUR(c.otherCost)]);
      gOther += c.otherCost;
    });
    rows.push(['TOTAL', EUR(gOther)]);
    rows.push([]);

    // Itemised
    rows.push(['Partner', 'Cost Type', 'Cost (€)', 'Justification']);
    partners.forEach(p => {
      (p.other_costs || []).forEach(o => {
        rows.push([p.name, o.description || o.type || 'Other', EUR(Number(o.cost) || 0), o.justification || '']);
      });
    });

    return makeSheet(rows);
  }

  // ── Sheet 4: Subcontracting ───────────────────────────────────────────────
  function buildSubcontractingSheet() {
    const rows = [];

    rows.push(['Partner', 'Subcontracting Cost (€)']);
    let gSub = 0;
    computed.forEach(({ p, c }) => {
      rows.push([p.name, EUR(c.sub)]);
      gSub += c.sub;
    });
    rows.push(['TOTAL', EUR(gSub)]);
    rows.push([]);

    rows.push(['Partner', 'Description', 'Cost (€)', 'Justification']);
    partners.forEach(p => {
      (p.subcontracting_costs || []).forEach(s => {
        rows.push([p.name, s.description || s.type || 'Subcontracting', EUR(Number(s.cost) || 0), s.justification || '']);
      });
    });

    return makeSheet(rows);
  }

  // ── Sheet 5: Travel ───────────────────────────────────────────────────────
  function buildTravelSheet() {
    const rows = [];

    rows.push(['Partner', 'Travel Cost (€)']);
    let gTravel = 0;
    partners.forEach(p => {
      const tCost = [
        ...(p.travel_meetings || []),
        ...(p.travel_dissem || []),
      ].reduce((s, t) => s + (Number(t.cost) || 0), 0);
      rows.push([p.name, EUR(tCost)]);
      gTravel += tCost;
    });
    rows.push(['TOTAL', EUR(gTravel)]);
    rows.push([]);

    rows.push(['Partner', 'Type', 'Cost (€)', 'Description']);
    partners.forEach(p => {
      (p.travel_meetings || []).forEach(t => {
        rows.push([p.name, 'Meetings', EUR(Number(t.cost) || 0), t.description || '']);
      });
      (p.travel_dissem || []).forEach(t => {
        rows.push([p.name, 'Dissemination', EUR(Number(t.cost) || 0), t.description || '']);
      });
    });

    return makeSheet(rows);
  }

  // ── Assemble workbook ─────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildResourcesSheet(), 'Resources');
  XLSX.utils.book_append_sheet(wb, buildPmPerTaskSheet(), 'PM per task');
  XLSX.utils.book_append_sheet(wb, buildOtherCostSheet(), 'Other direct cost');
  XLSX.utils.book_append_sheet(wb, buildSubcontractingSheet(), 'Subcontracting');
  XLSX.utils.book_append_sheet(wb, buildTravelSheet(), 'Travel');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateBudgetExcel };
