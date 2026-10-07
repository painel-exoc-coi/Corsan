/**
 * BANCO DO PAINEL EXOC (Google Sheets)
 * ------------------------------------------------------------------
 * Abas que este script cuida sozinho (cria se nao existirem):
 *   - Historico         -> base FIXA de cada dia (a 1a da manha). Reenviar a
 *                          base inicial no mesmo dia substitui (corrige base errada).
 *   - UltimaAtualizacao -> ultima base enviada em cada dia (usada no painel).
 *   - Atualizacoes      -> registro de TODA subida (nunca apaga): data/hora,
 *                          tipo, arquivo, volumetria e as chaves das EXOCs.
 *   - ResumoDiario      -> resultado 24h por dia, legivel, refeito a cada subida.
 *
 * Regra da meta 24h (igual ao painel):
 *   volumetria do dia = base fixa da manha (vencidas + no prazo, ja tratada)
 *   dentro da meta    = nao aparece mais na base fixa do dia seguinte
 *   fora da meta      = continua na base fixa do dia seguinte
 *   ultimo dia        = em andamento ate chegar a proxima base fixa
 *
 * Cada linha de Historico/UltimaAtualizacao: dateKey | type | fileName | uploadedAt | json (partes)
 * O JSON e dividido em varias celulas (limite de 50.000 caracteres por celula).
 */
const DB_VERSION = 'EXOC_2026_10_MENSAL24H';
const HISTORY_SHEET = 'Historico';
const LATEST_SHEET = 'UltimaAtualizacao';
const LOG_SHEET = 'Atualizacoes';
const SUMMARY_SHEET = 'ResumoDiario';
const CHUNK_SIZE = 45000;
const MAX_BODY_CHARS = 8000000; // ~8 MB por envio

// Abrir o link /exec no navegador so mostra se esta no ar.
function doGet() {
  return json_({ ok: true, version: DB_VERSION, message: 'Painel EXOC online.' });
}

// O painel usa POST: { action: 'history' | 'save', snapshot }
function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > MAX_BODY_CHARS) return json_({ ok: false, error: 'envio grande demais' });
    const payload = JSON.parse(raw);
    if (payload.action === 'history') return json_(databasePayload_());
    return json_(saveSnapshot(payload.snapshot || payload));
  } catch (err) {
    return json_({ ok: false, version: DB_VERSION, error: String(err && err.message ? err.message : err) });
  }
}

function saveSnapshot(snapshot) {
  if (!snapshot || !snapshot.dateKey) {
    return { ok: false, version: DB_VERSION, error: 'base sem data' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (snapshot.type === 'base_inicial') upsertByDate_(HISTORY_SHEET, snapshot);
    upsertByDate_(LATEST_SHEET, snapshot);
    appendLog_(snapshot);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  try {
    rebuildSummary_();
  } catch (err) {
    // o resumo e so leitura humana: se falhar, a base continua salva
    console.error('Resumo nao atualizado: ' + err);
  }
  return { ok: true, version: DB_VERSION };
}

function databasePayload_() {
  const history = readSnapshots_(HISTORY_SHEET);
  const latestList = readSnapshots_(LATEST_SHEET);
  const last = latestList.length ? latestList[latestList.length - 1] : null;
  return {
    ok: true,
    version: DB_VERSION,
    history: history,
    // para a ultima atualizacao o painel so precisa das chaves
    latest: last ? { dateKey: last.dateKey, type: last.type, fileName: last.fileName, uploadedAt: last.uploadedAt, keys: keysOf_(last) } : null,
    currentBase: history.length ? history[history.length - 1] : null,
  };
}

// ---------------------------------------------------------------------
// Registro de cada subida (aba Atualizacoes)
// ---------------------------------------------------------------------
function appendLog_(snapshot) {
  const sheet = ensureSheet_(LOG_SHEET, ['Enviado em', 'Dia', 'Tipo', 'Arquivo', 'EXOCs na base enviada', 'Chaves (JSON)']);
  const keys = keysOf_(snapshot);
  const text = JSON.stringify(keys);
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
  const row = [
    snapshot.uploadedAt || new Date().toISOString(),
    String(snapshot.dateKey || ''),
    snapshot.type === 'base_inicial' ? 'Base fixa do dia' : 'Atualizacao',
    snapshot.fileName || '',
    keys.length,
  ].concat(chunks);
  const rowNumber = sheet.getLastRow() + 1;
  if (sheet.getMaxColumns() < row.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
  const range = sheet.getRange(rowNumber, 1, 1, row.length);
  range.setNumberFormat('@');
  range.setValues([row.map(String)]);
}

// ---------------------------------------------------------------------
// Resumo diario (aba ResumoDiario) - mesma regra do painel, sem filtros
// ---------------------------------------------------------------------
function rebuildSummary_() {
  const history = dedupeByDay_(readSnapshots_(HISTORY_SHEET));
  const latestList = readSnapshots_(LATEST_SHEET);
  const last = latestList.length ? latestList[latestList.length - 1] : null;
  const header = ['Dia', 'Arquivo da base fixa', 'Base fixa (volumetria)', 'Novas no dia', 'Vindas de dias anteriores',
    'Ja vencidas na extracao', 'Tratadas na meta', 'Nao tratadas -> dia seguinte (fora da meta)', 'Em andamento',
    '% na meta', 'Situacao do dia', 'Base fixa enviada em'];
  const rows = [];
  const seen = {};
  const months = {};
  history.forEach(function (snap, i) {
    const next = history[i + 1] || null;
    const nextKeys = next ? toSet_(keysOf_(next)) : null;
    const partial = !next && last && last.dateKey === snap.dateKey && last.type !== 'base_inicial' ? toSet_(keysOf_(last)) : null;
    const baseAt = Date.parse(snap.uploadedAt || '') || 0;
    const d = { total: 0, novas: 0, vindas: 0, vencidas: 0, treated: 0, late: 0, open: 0, partialOut: 0 };
    (snap.records || []).forEach(function (r) {
      d.total += 1;
      if (seen[r.key]) d.vindas += 1; else d.novas += 1;
      if (r.referenceMs && baseAt && r.referenceMs + 864e5 < baseAt) d.vencidas += 1;
      if (!next) {
        d.open += 1;
        if (partial && !partial[r.key]) d.partialOut += 1;
      } else if (nextKeys[r.key]) d.late += 1;
      else d.treated += 1;
    });
    (snap.records || []).forEach(function (r) { seen[r.key] = true; });
    const situacao = next ? 'Fechado (conferido na base de ' + br_(next.dateKey) + ')'
      : partial ? 'Em andamento: ' + d.partialOut + ' ja sairam ate ' + hour_(last.uploadedAt)
      : 'Em andamento';
    rows.push([br_(snap.dateKey) + '/' + String(snap.dateKey).slice(0, 4), snap.fileName || '', d.total, d.novas, d.vindas,
      d.vencidas, d.treated, d.late, d.open, pct_(d.treated, d.late), situacao, snap.uploadedAt || '']);
    const m = String(snap.dateKey).slice(0, 7);
    months[m] = months[m] || { total: 0, treated: 0, late: 0, open: 0 };
    months[m].total += d.total; months[m].treated += d.treated; months[m].late += d.late; months[m].open += d.open;
  });
  Object.keys(months).sort().forEach(function (m) {
    const t = months[m];
    rows.push(['Total ' + m.slice(5, 7) + '/' + m.slice(0, 4), '', t.total, '', '', '', t.treated, t.late, t.open,
      pct_(t.treated, t.late), t.open ? 'Mes com dia em andamento' : 'Mes fechado', '']);
  });

  const sheet = ensureSheet_(SUMMARY_SHEET, header);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    const range = sheet.getRange(2, 1, rows.length, header.length);
    range.setNumberFormat('@');
    range.setValues(rows.map(function (r) { return r.map(String); }));
  }
  sheet.setFrozenRows(1);
}

// Rode esta funcao manualmente (Executar) se quiser refazer o resumo.
function atualizarResumo() {
  rebuildSummary_();
}

// ---------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ensureSheet_(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(header || ['dateKey', 'type', 'fileName', 'uploadedAt', 'snapshotJson']);
  return sheet;
}

function readSnapshots_(sheetName) {
  const sheet = ensureSheet_(sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = Math.max(sheet.getLastColumn(), 5);
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values
    .map(function (row) {
      const text = row.slice(4).join('');
      if (!text) return null;
      try {
        const snap = JSON.parse(text);
        snap.dateKey = String(snap.dateKey || '').slice(0, 10);
        return snap;
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean)
    .sort(function (a, b) { return String(a.dateKey).localeCompare(String(b.dateKey)); });
}

function dedupeByDay_(list) {
  const byDay = {};
  list.forEach(function (s) { if (!byDay[s.dateKey]) byDay[s.dateKey] = s; });
  return Object.keys(byDay).sort().map(function (k) { return byDay[k]; });
}

function upsertByDate_(sheetName, snapshot) {
  const sheet = ensureSheet_(sheetName);
  const existingRow = findRowByDate_(sheet, snapshot.dateKey);
  writeRow_(sheet, existingRow || sheet.getLastRow() + 1, snapshot);
}

function writeRow_(sheet, rowNumber, snapshot) {
  const text = JSON.stringify(snapshot);
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));
  const row = [
    String(snapshot.dateKey || ''),
    snapshot.type || '',
    snapshot.fileName || '',
    snapshot.uploadedAt || new Date().toISOString(),
  ].concat(chunks);
  // limpa partes antigas da linha antes de gravar (caso a base nova seja menor)
  const lastCol = sheet.getLastColumn();
  if (lastCol > 0 && rowNumber <= sheet.getLastRow()) sheet.getRange(rowNumber, 1, 1, lastCol).clearContent();
  if (sheet.getMaxColumns() < row.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), row.length - sheet.getMaxColumns());
  const range = sheet.getRange(rowNumber, 1, 1, row.length);
  range.setNumberFormat('@'); // guarda tudo como texto
  range.setValues([row]);
}

function findRowByDate_(sheet, dateKey) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const dates = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const wanted = String(dateKey).slice(0, 10);
  const tz = Session.getScriptTimeZone();
  for (let i = 0; i < dates.length; i += 1) {
    const cell = dates[i][0];
    const key = cell instanceof Date ? Utilities.formatDate(cell, tz, 'yyyy-MM-dd') : String(cell).slice(0, 10);
    if (key === wanted) return i + 2;
  }
  return 0;
}

function keysOf_(snap) {
  if (!snap) return [];
  if (snap.keys && snap.keys.length) return snap.keys;
  return (snap.records || []).map(function (r) { return r.key; });
}

function toSet_(list) {
  const set = {};
  list.forEach(function (k) { set[k] = true; });
  return set;
}

function br_(dateKey) {
  const k = String(dateKey || '');
  return k.slice(8, 10) + '/' + k.slice(5, 7);
}

function hour_(iso) {
  const d = new Date(iso || '');
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, 'America/Sao_Paulo', 'HH:mm');
}

function pct_(treated, late) {
  const closed = treated + late;
  return closed ? (Math.round((treated / closed) * 1000) / 10).toString().replace('.', ',') + '%' : '';
}
