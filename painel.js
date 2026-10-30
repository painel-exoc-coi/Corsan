window.addEventListener("error", function(event) {
  if (!event.message || event.message === "Script error.") return;
  var box = document.querySelector("#loadNotice");
  if (box) {
    box.textContent = "Erro no painel: " + (event.message || "erro desconhecido");
    box.className = "notice error";
  }
});
const STORAGE_KEY = "painel-exoc-config-v2";
const DB_NAME = "painel-exoc-db";
const DB_STORE = "dados";
const DB_VERSION = 1;
const INTERNAL_MICRO_MAP = {};
const INTERNAL_SERVICE_MAP = {};
const SHEETS_CONFIG_KEY = "painel-exoc-sheets-config-v1";
const DEFAULT_SHEETS_TOKEN = "";
const DEFAULT_SHEETS_URL = String((window.EXOC_CONFIG && window.EXOC_CONFIG.APPS_SCRIPT_URL) || "").trim();
const PRELOADED_TRACKING_STATE = window.PRELOADED_TRACKING_STATE || {};
const SERVICE_GROUP_MAP = window.SERVICE_GROUP_MAP || {};
const PRELOADED_TRACKING_KEY = "painel-exoc-preload-" + PRELOADED_TRACKING_STATE.id;


const state = {
  baseline: [],
  records: [],
  latestKeys: null,
  latestFileName: "",
  baselineFileName: "",
  manualStatus: {},
  baselineDay: "",
  latestSnap: null,
  selectedMonth: "",
  duplicateCount: 0,
  history: [],
  microMap: INTERNAL_MICRO_MAP,
  serviceMap: INTERNAL_SERVICE_MAP,
  auxStatus: {
    micro: Object.keys(INTERNAL_MICRO_MAP).length > 0,
    service: Object.keys(INTERNAL_SERVICE_MAP).length > 0,
  },
  filters: {
    search: "",
    status: ["todos"],
    diretoria: ["todos"],
    micro: ["todos"],
    ocorrencia: ["todos"],
    servico: ["todos"],
    grupoServico: ["todos"],
  },
};

const els = {
  notice: document.querySelector("#loadNotice"),
  total: document.querySelector("#totalCount"),
  treated: document.querySelector("#treatedCount"),
  open: document.querySelector("#openCount"),
  progress: document.querySelector("#progressCount"),
  overdue: document.querySelector("#overdueCount"),
  dueSoon: document.querySelector("#dueSoonCount"),
  latestFile: document.querySelector("#latestFile"),
  baselineFile: document.querySelector("#baselineFile"),
  stateFile: document.querySelector("#stateFile"),
  exportState: document.querySelector("#exportState"),
  exportCsv: document.querySelector("#exportCsv"),
  clearData: document.querySelector("#clearData"),
  search: document.querySelector("#searchBox"),
  status: document.querySelector("#statusFilter"),
  diretoria: document.querySelector("#diretoriaFilter"),
  micro: document.querySelector("#microFilter"),
  ocorrencia: document.querySelector("#ocorrenciaFilter"),
  servico: document.querySelector("#servicoFilter"),
  grupoServico: document.querySelector("#grupoServicoFilter"),
  baselineDate: document.querySelector("#baselineDate"),
  latestDate: document.querySelector("#latestDate"),
  duplicateText: document.querySelector("#duplicateText"),
  auxText: document.querySelector("#auxText"),
  viewTitle: document.querySelector("#viewTitle"),
  monthRateCount: document.querySelector("#monthRateCount"),
  monthlyView: document.querySelector("#monthlyView"),
  viewMonthly: document.querySelector("#viewMonthly"),
  monthEligible: document.querySelector("#monthEligible"),
  monthTreated: document.querySelector("#monthTreated"),
  monthPending: document.querySelector("#monthPending"),
  monthRate: document.querySelector("#monthRate"),
  monthlyBody: document.querySelector("#monthlyBody"),
  pivotRow1: document.querySelector("#pivotRow1"),
  pivotRow2: document.querySelector("#pivotRow2"),
  pivotColumn: document.querySelector("#pivotColumn"),
  pivotTable: document.querySelector("#pivotTable"),
  resultText: document.querySelector("#resultText"),
  body: document.querySelector("#tableBody"),
  tableView: document.querySelector("#tableView"),
  chartView: document.querySelector("#chartView"),
  slaView: document.querySelector("#slaView"),
  viewTable: document.querySelector("#viewTable"),
  viewCharts: document.querySelector("#viewCharts"),
  occurrenceBars: document.querySelector("#occurrenceBars"),
  cityBars: document.querySelector("#cityBars"),
  slaBody: document.querySelector("#slaBody"),
};

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key, fallback) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result != null ? request.result : fallback);
    request.onerror = () => reject(request.error);
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function sheetsConfig() {
  return { url: DEFAULT_SHEETS_URL, token: "" };
}

// Bases gravadas antes das regras atuais podem ter EXOCs que nao deveriam entrar
// (ex.: "Executado"). Limpa usando a data da PROPRIA base, entao o numero e sempre o mesmo.
function sanitizeStoredRecords(records, dateKey) {
  return (records || []).filter((r) => {
    if (r.meta) return true; // mes importado ja tratado: nao refiltra
    if (r.visitadoEmMs) {
      if (new Date(r.visitadoEmMs).getFullYear() <= 2025) return false;
      if (dateKey && dateKeyFromMs(r.visitadoEmMs) >= dateKey) return false;
    }
    const code = serviceCode(r.codigoServico || String(r.key || "").split("|")[2] || "");
    const info = code ? state.serviceMap[code] : null;
    const resp = info ? normalize(info.responsabilidade) : normalize(r.procxCoi);
    if (resp && normKey(resp) !== "COI") return false;
    return true;
  });
}

function sanitizeSnapshot(snap) {
  if (!snap || !Array.isArray(snap.records) || !snap.records.length) return snap;
  const dateKey = normalizeHistoryDateKey(snap.dateKey);
  const records = sanitizeStoredRecords(snap.records, dateKey);
  return Object.assign({}, snap, { dateKey, records, keys: records.map((r) => r.key) });
}

function applyDatabasePayload(payload) {
  if (!Object.keys(state.serviceMap || {}).length) loadInternalAuxiliaries();
  const remote = fixedDailyHistory(payload && Array.isArray(payload.history) ? payload.history : []).map(sanitizeSnapshot);
  const latest = (payload && payload.latest) || (remote.length ? remote[remote.length - 1] : null) || null;
  const currentBase = remote.length ? remote[remote.length - 1] : sanitizeSnapshot(payload && payload.currentBase) || null;
  if (remote.length) state.history = remote;
  state.histVersion = (state.histVersion || 0) + 1;
  const raw = (payload && Array.isArray(payload.history) ? payload.history : []).map((x) => x.uploadedAt || "");
  if (payload && payload.latest) raw.push(payload.latest.uploadedAt || "");
  state.remoteStamp = raw.sort().pop() || "";
  const stamps = [latest, currentBase].filter(Boolean).map((snap) => ({ at: snap.uploadedAt || "", file: snap.fileName || "" }))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (stamps.length && stamps[0].at) state.lastUpdate = stamps[0];
  if (currentBase && currentBase.records && currentBase.records.length) {
    // base fixa do dia: exatamente como foi gravada na 1a subida (nao recalcula)
    state.baseline = currentBase.records;
    state.baselineFileName = currentBase.fileName || `Base de ${currentBase.dateKey}`;
    state.baselineDay = currentBase.dateKey || "";
  }
  state.latestSnap = latest && latest.keys ? { dateKey: latest.dateKey, type: latest.type, uploadedAt: latest.uploadedAt, fileName: latest.fileName, keys: latest.keys } : null;
  if (latest && latest.keys && latest.type !== "base_inicial" && state.baselineDay && normalizeHistoryDateKey(latest.dateKey) === state.baselineDay) {
    state.latestKeys = new Set(latest.keys || []);
    state.latestFileName = latest.fileName || `Atualização de ${latest.dateKey}`;
  } else {
    state.latestKeys = null;
    state.latestFileName = "";
  }
  return !!remote.length || !!latest;
}

async function callSheets(body) {
  const config = sheetsConfig();
  if (!config.url) return { ok: false, skipped: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ token: config.token }, body)),
      signal: controller.signal,
      credentials: "omit",
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: "o servidor de dados respondeu em formato inesperado" };
    }
  } catch (error) {
    return { ok: false, error: error && error.name === "AbortError" ? "o servidor de dados demorou demais para responder" : "sem conexão com o servidor de dados" };
  } finally {
    clearTimeout(timer);
  }
}

let sheetsQueue = Promise.resolve();
function syncSnapshotToSheets(snapshot) {
  sheetsQueue = sheetsQueue.then(async () => {
    const body = JSON.stringify(snapshot);
    if (body.length > 7500000) {
      setNotice(`A base NÃO foi salva: ficou com ${number((snapshot.records || []).length || (snapshot.keys || []).length)} EXOCs depois do tratamento (${(body.length / 1e6).toFixed(1)} MB), muito acima do normal. Confira se o arquivo é a extração certa e veja o quadro de reconciliação.`, "error");
      return;
    }
    const result = await callSheets({ action: "save", snapshot });
    if (result.skipped) return;
    if (!result.ok) {
      setNotice("A base NÃO foi salva: " + (result.error || "erro desconhecido") + ". Quem abrir o link não vai ver esta base. Tente subir de novo.", "error");
      return;
    }
    setNotice(`${snapshot.type === "base_inicial" ? "Base fixa do dia" : "Atualização"} salva ✓ Quem abrir o link já vê estes mesmos números.`, "ok");
  });
  return sheetsQueue;
}

async function getSheetsHistory() {
  const config = sheetsConfig();
  try {
    const sep = config.url.includes("?") ? "&" : "?";
    const response = await fetch(`${config.url}${sep}action=history`, { credentials: "omit" });
    return JSON.parse(await response.text());
  } catch {
    return { ok: false, error: "não consegui ler os dados salvos" };
  }
}

async function loadSheetsHistory() {
  let result = await callSheets({ action: "history" });
  if (result.skipped) return false;
  if (!result.ok || !Array.isArray(result.history)) {
    const viaGet = await getSheetsHistory();
    if (viaGet && Array.isArray(viaGet.history)) result = Object.assign({ ok: true }, viaGet);
  }
  if (!result.ok) {
    setNotice("Não consegui carregar os dados: " + (result.error || "erro desconhecido") + ". Atualize a página (F5).", "error");
    return false;
  }
  return applyDatabasePayload(result);
}
function esc(value) {
  return String(value != null ? value : "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function normalize(value) {
  return String(value != null ? value : "").trim();
}

function normKey(value) {
  return normalize(value)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}
function serviceGroupFor(code) {
  const group = SERVICE_GROUP_MAP[normKey(code)] || "";
  return group || "Sem grupo";
}

function findColumn(row, parts) {
  const keys = Object.keys(row);
  return keys.find((key) => {
    const normalized = normKey(key);
    return parts.some((part) => normalized.includes(normKey(part)));
  });
}

function pick(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const wanted = names.map((name) => name.toLowerCase());
  const key = Object.keys(row).find((item) => wanted.includes(item.trim().toLowerCase()));
  return key ? row[key] : "";
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateKeyFromMs(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKeyFromMs(ms) {
  if (!ms) return "Sem data";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayLabel(ms) {
  if (!ms) return "Sem data";
  const date = new Date(ms);
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function pivotDayLabel(ms) {
  if (!ms) return "Sem data";
  const date = new Date(ms);
  const months = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  return `${String(date.getDate()).padStart(2, "0")}/${months[date.getMonth()]}`;
}

function parseExcelDate(value) {
  if (!value) return { display: "", ms: null };
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return { display: value.toLocaleString("pt-BR"), ms: value.getTime() };
  }
  const number = Number(value);
  if (Number.isFinite(number) && number > 1) {
    const dateInfo = new Date(Math.round((number - 25569) * 86400 * 1000));
    dateInfo.setTime(dateInfo.getTime() + dateInfo.getTimezoneOffset() * 60000);
    if (dateInfo.getFullYear() >= 2000) {
      return {
        display: dateInfo.toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        ms: dateInfo.getTime(),
      };
    }
  }
  const txt = normalize(value);
  const br = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  const iso = txt.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  const parsed = br ? new Date(+br[3], +br[2] - 1, +br[1], +(br[4] || 0), +(br[5] || 0), +(br[6] || 0))
    : iso ? new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0))
    : new Date(value);
  return Number.isNaN(parsed.getTime())
    ? { display: normalize(value), ms: null }
    : { display: parsed.toLocaleString("pt-BR"), ms: parsed.getTime() };
}

function makeKey(record) {
  return [record.solicitacao, record.ligacao, record.codigoServico].map(normalize).join("|");
}

function cleanRows(rows) {
  const cleaned = rows
    .map((row) => {
      const dataSolicitacao = parseExcelDate(pick(row, ["Data Solicitação"]));
      const visitadoEm = parseExcelDate(pick(row, ["Visitado em"]));
      const record = {
        zona: normalize(pick(row, ["Zona"])),
        localidade: normalize(pick(row, ["Localidade"])),
        diretoria: normalize(pick(row, ["Diretoria"])),
        micro: normalize(pick(row, ["Micro"])),
        procxCoi: normalize(pick(row, ["PROCX COI", "ReQ", "COI", "Responsabilidade", "Responsável", "Responsavel"])),
        ligacao: normalize(pick(row, ["Nº Ligação", "No Ligação", "Numero Ligação"])),
        dataSolicitacao: dataSolicitacao.display,
        dataSolicitacaoMs: dataSolicitacao.ms,
        anoSolicitacao: normalize(pick(row, ["Ano Solicitação"])),
        solicitacao: normalize(pick(row, ["Nº Solicitação", "No Solicitação", "Numero Solicitação"])),
        codigoServico: normalize(pick(row, ["Código do Serviço", "Codigo do Serviço"])),
        servico: normalize(pick(row, ["Tipo de Solicitação"])),
        visitadoEm: visitadoEm.display,
        visitadoEmMs: visitadoEm.ms,
        situacao: normalize(pick(row, ["Situação", "Situacao"])),
        comunidade: normalize(pick(row, ["Comunidade"])),
        comunidadeExecutada: normalize(pick(row, ["Solicitações Executadas em Comunidades"])),
        executor: normalize(pick(row, ["Execultor", "Executor"])),
        tipoEncerramento: normalize(pick(row, ["Tipo Encerramento", "Tipo Encerramento "])),
        descricaoEncerramento: normalize(pick(row, ["Descrição Tipo Encerramento", "Descricao Tipo Encerramento"])) || normalize(pick(row, ["Tipo Encerramento", "Tipo Encerramento "])),
      };
      record.grupoServico = serviceGroupFor(record.codigoServico);
      record.key = makeKey(record);
      record.referenceMs = record.visitadoEmMs || record.dataSolicitacaoMs;
      record.referenceDate = record.visitadoEm || record.dataSolicitacao;
      return record;
    })
    .filter((record) => record.solicitacao || record.ligacao || record.servico);

  // Não remove duplicadas: a volumetria conta linha a linha, igual ao tratamento no Excel.
  const seen = new Set();
  let duplicates = 0;
  cleaned.forEach((record) => { if (seen.has(record.key)) duplicates += 1; else seen.add(record.key); });
  return { rows: cleaned, duplicates, discarded: rows.length - cleaned.length };
}

function dayFromFileName(fileName) {
  const name = String(fileName || "");
  let m = name.match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = name.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

function serviceCode(value) {
  return normKey(value).replace(/\.0+$/, "");
}

// Fica so "encerrado com ocorrencia / nao executado". Sai tudo que foi executado (ex.: "0-Executado").
function encerradaComOcorrencia(record) {
  // Situação diz que foi encerrada com ocorrência / não executada: conta, mesmo que a
  // descrição da ocorrência fale em "executado" (ex.: "124 - Serviço já executado").
  const sit = normKey(record.situacao);
  if (sit.includes("OCORRENCIA") || sit.includes("NAO EXECUTAD")) return true;
  const campos = [record.situacao, record.tipoEncerramento, record.descricaoEncerramento].map(normKey);
  const texto = campos.join(" | ");
  const naoExecutado = texto.includes("NAO EXECUTAD") || texto.includes("OCORRENCIA");
  const executado = campos.some((c) => /EXECUTAD/.test(c.replace(/NAO EXECUTAD/g, "")));
  return naoExecutado && !executado;
}

// Regras do tratamento EXOC:
// 1) responsabilidade COI pela tabela auxiliar (código do serviço)
// 2) somente encerradas com ocorrência (coluna Situação)
// 3) fora tudo que foi visitado no dia atual da base (eles nunca tratam as do dia)
function applyBusinessRules(rows, referenceDay) {
  const currentDay = referenceDay || todayKey();
  const hasSituacao = rows.some((record) => normalize(record.situacao));
  const enrichedRows = rows
    .map((record) => {
      const microInfo = state.microMap[normKey(record.localidade)] || state.microMap[normKey(record.micro)] || {};
      const code = serviceCode(record.codigoServico);
      const serviceInfo = (code ? state.serviceMap[code] : state.serviceMap[normKey(record.servico)]) || {};
      const svcResp = normalize(serviceInfo.responsabilidade);
      return Object.assign({}, record, {
        diretoria: microInfo.diretoria || record.diretoria || "",
        micro: microInfo.micro || record.localidade || "",
        responsavel: svcResp,
        responsabilidade: svcResp,
        procxCoi: svcResp,
        _semTabela: !svcResp,
        afetaCliente: serviceInfo.afetaCliente || "",
        grupoServico: serviceGroupFor(code || record.servico),
      });
    });
  const f = { semData: 0, outroAno: 0, hoje: 0, semCoi: 0, semTabela: 0, naoEncerrada: 0, semSituacao: !hasSituacao, diaBase: currentDay };
  const out = enrichedRows.filter((record) => {
    // Tratamento oficial (só 2 regras):
    // 1) "Visitado em": sai 2025 (ou antes) e o dia da base em diante
    // 2) só responsabilidade COI pela tabela auxiliar (código do serviço)
    const date = record.visitadoEmMs ? new Date(record.visitadoEmMs) : null;
    if (!date) f.semData += 1; // sem data em "Visitado em": fica (não é filtrada)
    else if (date.getFullYear() <= 2025) { f.outroAno += 1; return false; }
    else if (dateKeyFromMs(record.visitadoEmMs) >= currentDay) { f.hoje += 1; return false; }
    if (record._semTabela) { f.semTabela += 1; return false; }
    if (normKey(record.procxCoi) !== "COI") { f.semCoi += 1; return false; }
    return true;
  });
  out.funnel = f;
  return out;
}


const XLSX_SOURCES = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
];
let xlsxPromise = null;
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve(true);
  if (xlsxPromise) return xlsxPromise;
  xlsxPromise = (async () => {
    for (const url of XLSX_SOURCES) {
      const ok = await new Promise((resolve) => {
        const el = document.createElement("script");
        el.src = url;
        el.onload = () => resolve(true);
        el.onerror = () => { el.remove(); resolve(false); };
        setTimeout(() => resolve(!!window.XLSX), 15000);
        document.head.appendChild(el);
      });
      if (ok && window.XLSX) return true;
    }
    xlsxPromise = null;
    return false;
  })();
  return xlsxPromise;
}

/* Leitor nativo (sem biblioteca externa): .xlsx e .csv */
function gridToRows(grid) {
  const head = (grid.shift() || []).map((h) => String(h != null ? h : "").trim());
  return grid
    .filter((r) => r.some((x) => x !== "" && x !== undefined))
    .map((r) => { const o = {}; head.forEach((h, i) => { if (h) o[h] = r[i] != null ? r[i] : ""; }); return o; });
}
function csvRows(text) {
  const first = text.split(/\r?\n/, 1)[0];
  const d = [";", "\t", ","].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const grid = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); grid.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); grid.push(row); }
  return gridToRows(grid);
}
async function unzipXlsx(buffer) {
  const u8 = new Uint8Array(buffer), dv = new DataView(buffer), files = {};
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("Arquivo .xlsx inválido.");
  let p = dv.getUint32(e + 16, true);
  const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    files[name] = { method, data: u8.subarray(start, start + csize) };
    p += 46 + nl + xl + cl;
  }
  return files;
}
async function zipText(files, name) {
  const f = files[name];
  if (!f) return "";
  let bytes = f.data;
  if (f.method !== 0) {
    const ds = new DecompressionStream("deflate-raw");
    const w = ds.writable.getWriter(); w.write(f.data); w.close();
    bytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }
  return new TextDecoder("utf-8").decode(bytes);
}
async function nativeRows(buffer, name) {
  if (/\.csv$/i.test(name)) return csvRows(new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, ""));
  if (!/\.xlsx$/i.test(name)) {
    throw new Error("Não consegui carregar a biblioteca de Excel (sem internet ou bloqueio de rede). Salve a base como .xlsx ou .csv e tente de novo.");
  }
  const dom = (t) => new DOMParser().parseFromString(t, "application/xml");
  const files = await unzipXlsx(buffer);
  const wb = dom(await zipText(files, "xl/workbook.xml"));
  const rels = dom(await zipText(files, "xl/_rels/workbook.xml.rels"));
  const firstSheet = wb.getElementsByTagName("sheet")[0]; const rid = firstSheet ? firstSheet.getAttribute("r:id") : "";
  const rel = Array.from(rels.getElementsByTagName("Relationship")).find((r) => r.getAttribute("Id") === rid);
  const target = "xl/" + (rel ? rel.getAttribute("Target") : "worksheets/sheet1.xml").replace(/^\//, "").replace(/^xl\//, "");
  const sst = Array.from(dom(await zipText(files, "xl/sharedStrings.xml")).getElementsByTagName("si"))
    .map((si) => Array.from(si.getElementsByTagName("t")).map((t) => t.textContent).join(""));
  const sheet = dom(await zipText(files, target));
  const grid = [];
  for (const row of sheet.getElementsByTagName("row")) {
    const arr = []; let idx = 0;
    for (const c of row.getElementsByTagName("c")) {
      const ref = c.getAttribute("r");
      if (ref) { let n = 0; for (const ch of ref.replace(/\d/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; idx = n - 1; }
      const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0];
      let val = "";
      if (t === "inlineStr") val = Array.from(c.getElementsByTagName("t")).map((x) => x.textContent).join("");
      else if (v) val = t === "s" ? (sst[+v.textContent] != null ? sst[+v.textContent] : "") : (t === "str" || t === "b" || t === "e") ? v.textContent : Number(v.textContent);
      arr[idx++] = val;
    }
    grid.push(arr);
  }
  return gridToRows(grid);
}
async function sheetRows(buffer, name) {
  if (await ensureXLSX()) {
    if (!state.auxStatus.micro && !state.auxStatus.service) loadInternalAuxiliaries();
    const wb = XLSX.read(buffer, { type: "array", cellDates: false });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
  }
  return nativeRows(buffer, name);
}

async function parseWorkbookFromArrayBuffer(buffer, fileName = "") {
  const raw = await sheetRows(buffer, fileName);
  const cleaned = cleanRows(raw);
  const rows = applyBusinessRules(cleaned.rows, dayFromFileName(fileName) || todayKey());
  return {
    rows,
    duplicates: cleaned.duplicates,
    funnel: Object.assign({ brutas: raw.length, semChave: cleaned.discarded, duplicadas: cleaned.duplicates }, rows.funnel, { final: rows.length }),
  };
}

async function readFile(file) {
  return parseWorkbookFromArrayBuffer(await file.arrayBuffer(), file.name);
}

async function readRawRows(file) {
  return sheetRows(await file.arrayBuffer(), file.name);
}

function buildMicroMap(rows) {
  const map = {};
  rows.forEach((row) => {
    const localidadeCol = findColumn(row, ["localidade", "municipio", "cidade"]);
    const microCol = findColumn(row, ["micro"]);
    const diretoriaCol = findColumn(row, ["diretoria"]);
    const responsavelCol = findColumn(row, ["responsavel", "responsabilidade"]);
    const localidade = normalize(row[localidadeCol]);
    const micro = normalize(row[microCol]) || localidade;
    if (!localidade && !micro) return;
    const item = {
      diretoria: normalize(row[diretoriaCol]),
      micro,
      responsavel: normalize(row[responsavelCol]),
      responsabilidade: normalize(row[responsavelCol]),
    };
    if (localidade) map[normKey(localidade)] = item;
    if (micro) map[normKey(micro)] = item;
  });
  return map;
}

function buildServiceMap(rows) {
  const map = {};
  const seen = {};
  const ambiguous = new Set();
  rows.forEach((row) => {
    const codeCol = findColumn(row, ["codigo", "código", "cod"]);
    const serviceCol = findColumn(row, ["servico", "serviço", "descricao", "descrição"]);
    const respCol = findColumn(row, ["responsavel", "responsabilidade", "area", "área"]);
    const afetaCol = findColumn(row, ["afeta"]);
    const code = normalize(row[codeCol]);
    const service = normalize(row[serviceCol]);
    const item = {
      responsabilidade: normalize(row[respCol]),
      responsavel: normalize(row[respCol]),
      afetaCliente: normalize(row[afetaCol]),
    };
    if (code) map[serviceCode(code)] = item;
    if (service) {
      const k = normKey(service);
      if (k in seen && seen[k] !== item.responsabilidade) ambiguous.add(k);
      seen[k] = item.responsabilidade;
      map[k] = item;
    }
  });
  ambiguous.forEach((k) => delete map[k]);
  return map;
}

function rowsFromEmbeddedWorkbook(base64) {
  if (!base64 || !window.XLSX) return [];
  const workbook = XLSX.read(base64, { type: "base64", cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

function loadInternalAuxiliaries() {
  try {
    const microRows = window.INTERNAL_MICRO_ROWS || [];
    const serviceRows = window.INTERNAL_SERVICE_ROWS || [];
    state.microMap = buildMicroMap(microRows);
    state.serviceMap = buildServiceMap(serviceRows);
    state.auxStatus = {
      micro: Object.keys(state.microMap).length > 0,
      service: Object.keys(state.serviceMap).length > 0,
    };
  } catch {
    state.microMap = {};
    state.serviceMap = {};
    state.auxStatus = { micro: false, service: false };
  }
}

function setNotice(message, type = "") {
  els.notice.className = `notice ${type}`.trim();
  els.notice.textContent = message;
}

async function loadSavedState() {
  localStorage.removeItem("painel-exoc-acompanhamento-v1");
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.latestFileName = saved.latestFileName || "";
    state.baselineFileName = saved.baselineFileName || "";
    state.duplicateCount = saved.duplicateCount || 0;
  } catch {
    state.latestFileName = "";
  }
  const hasSheets = !!sheetsConfig().url;
  if (hasSheets) {
    // dados salvos sao a unica fonte: todo mundo ve o mesmo numero
    state.baseline = [];
    state.manualStatus = {};
    state.history = [];
    state.latestKeys = null;
    state.latestFileName = "";
    state.baselineFileName = "";
    setNotice("Carregando dados do painel...");
    const ok = await loadSheetsHistory();
    if (ok && !state.baseline.length) setNotice("Ainda não há base fixa enviada. Carregue a base da manhã para começar.", "");
    return;
  }
  state.baseline = await dbGet("baseline", []);
  state.manualStatus = await dbGet("manualStatus", {});
  state.history = hasSheets ? [] : fixedDailyHistory(await dbGet("history", []));
  const latestKeys = hasSheets ? null : await dbGet("latestKeys", null);
  state.latestKeys = latestKeys ? new Set(latestKeys) : null;
  await loadSheetsHistory();
}

function normalizeHistoryDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : dateKeyFromMs(date.getTime());
}

function normalizeHistorySnapshots(history) {
  return (history || [])
    .map((snapshot) => Object.assign({}, snapshot, {
      dateKey: normalizeHistoryDateKey(snapshot.dateKey),
      keys: snapshot.keys || (snapshot.records || []).map((record) => record.key),
      records: snapshot.records || [],
    }))
    .filter((snapshot) => snapshot.dateKey)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

function fixedDailyHistory(history) {
  const today = todayKey();
  const locked = new Map();
  normalizeHistorySnapshots((PRELOADED_TRACKING_STATE && PRELOADED_TRACKING_STATE.history) || []).forEach((snapshot) => {
    if (snapshot.dateKey < today && !locked.has(snapshot.dateKey)) locked.set(snapshot.dateKey, snapshot);
  });

  const byDay = new Map(locked);
  normalizeHistorySnapshots(history).forEach((snapshot) => {
    if (locked.has(snapshot.dateKey)) return;
    if (!byDay.has(snapshot.dateKey)) {
      byDay.set(snapshot.dateKey, snapshot);
      return;
    }
    const current = byDay.get(snapshot.dateKey);
    const currentAt = Date.parse(current.uploadedAt || "") || Number.MAX_SAFE_INTEGER;
    const incomingAt = Date.parse(snapshot.uploadedAt || "") || Number.MAX_SAFE_INTEGER;
    if (incomingAt < currentAt) byDay.set(snapshot.dateKey, snapshot);
  });
  return Array.from(byDay.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}
async function applyPreloadedTrackingState() {
  if (!PRELOADED_TRACKING_STATE || !PRELOADED_TRACKING_STATE.id) return;
  if (sheetsConfig().url) return;
  if (localStorage.getItem(PRELOADED_TRACKING_KEY) === "applied") return;
  state.baseline = PRELOADED_TRACKING_STATE.baseline || [];
  state.history = fixedDailyHistory(PRELOADED_TRACKING_STATE.history || []);
  state.latestKeys = new Set(PRELOADED_TRACKING_STATE.latestKeys || []);
  state.latestFileName = PRELOADED_TRACKING_STATE.latestFileName || "";
  state.baselineFileName = PRELOADED_TRACKING_STATE.baselineFileName || "";
  state.duplicateCount = PRELOADED_TRACKING_STATE.duplicateCount || 0;
  state.manualStatus = PRELOADED_TRACKING_STATE.manualStatus || {};
  state.funnel = {
    brutas: (PRELOADED_TRACKING_STATE.summary && PRELOADED_TRACKING_STATE.summary.rawRows) || state.baseline.length,
    semChave: (PRELOADED_TRACKING_STATE.summary && PRELOADED_TRACKING_STATE.summary.discardedRows) || 0,
    duplicadas: PRELOADED_TRACKING_STATE.duplicateCount || 0,
    semData: 0,
    outroAno: 0,
    hoje: 0,
    semCoi: 0,
    semTabela: 0,
    final: state.baseline.length,
  };
  await saveState();
  localStorage.setItem(PRELOADED_TRACKING_KEY, "applied");
}
async function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        latestFileName: state.latestFileName,
        baselineFileName: state.baselineFileName,
        duplicateCount: state.duplicateCount,
        savedAt: new Date().toISOString(),
      })
    );
  } catch {
    localStorage.removeItem("painel-exoc-acompanhamento-v1");
  }
  state.histVersion = (state.histVersion || 0) + 1;
  if (sheetsConfig().url) return; // dados ficam no servidor; nao copia tudo para o navegador
  await dbSet("baseline", state.baseline);
  await dbSet("manualStatus", state.manualStatus);
  await dbSet("latestKeys", state.latestKeys ? Array.from(state.latestKeys) : null);
  await dbSet("history", state.history);
}

function statusFor(record) {
  if (!state.latestKeys) return "nao-tratado";
  return state.latestKeys.has(record.key) ? "nao-tratado" : "tratado";
}

function deadlineInfo(record) {
  if (!record.referenceMs) return { label: "Sem data", className: "neutral" };
  const diffHours = (record.referenceMs + 24 * 60 * 60 * 1000 - Date.now()) / 36e5;
  if (record.status === "tratado") return { label: "Tratado", className: "ok" };
  if (diffHours < 0) return { label: "Vencido", className: "danger" };
  if (diffHours <= 4) return { label: "Vence em até 4h", className: "warn" };
  return { label: "No prazo", className: "ok" };
}

function decorateRecords() {
  state.records = state.baseline.map((record) => {
    const status = statusFor(record);
    const enriched = Object.assign({}, record, {
      status,
      appearsLatest: state.latestKeys ? state.latestKeys.has(record.key) : true,
      grupoServico: serviceGroupFor(record.codigoServico || record.servico),
    });
    enriched.deadline = deadlineInfo(enriched);
    return enriched;
  });
}

function uniqueSorted(field) {
  return Array.from(new Set(state.records.map((item) => item[field]).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, "pt-BR")
  );
}

function normalizeFilterValues(values) {
  const list = Array.isArray(values) ? values : [values];
  const picked = list.filter((value) => value && value !== "todos");
  return picked.length ? picked : ["todos"];
}

function selectedValues(select) {
  return normalizeFilterValues(Array.from(select.selectedOptions).map((option) => option.value));
}

function setSelectValues(select, values) {
  const selected = normalizeFilterValues(values);
  Array.from(select.options).forEach((option) => {
    option.selected = selected.includes(option.value) || (selected.includes("todos") && option.value === "todos");
  });
  return selectedValues(select);
}

function filterMatches(key, value) {
  const selected = normalizeFilterValues(state.filters[key]);
  return selected.includes("todos") || selected.includes(value);
}

function fillSelect(select, values, firstLabel, selected) {
  const current = selected ? normalizeFilterValues(selected) : selectedValues(select);
  select.innerHTML = `<option value="todos">${firstLabel}</option>`;
  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  return setSelectValues(select, current);
}

function updateFilterOptions() {
  state.filters.status = setSelectValues(els.status, state.filters.status);
  state.filters.diretoria = fillSelect(els.diretoria, uniqueSorted("diretoria"), "Todas", state.filters.diretoria);
  const dirSel = normalizeFilterValues(state.filters.diretoria);
  const microList = Array.from(new Set(state.records.filter((r) => dirSel.includes("todos") || dirSel.includes(r.diretoria)).map((r) => r.micro).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  state.filters.micro = fillSelect(els.micro, microList, "Todas", state.filters.micro);
  state.filters.ocorrencia = fillSelect(els.ocorrencia, uniqueSorted("descricaoEncerramento"), "Todas", state.filters.ocorrencia);
  state.filters.servico = fillSelect(els.servico, uniqueSorted("servico"), "Todos", state.filters.servico);
  if (els.grupoServico) state.filters.grupoServico = fillSelect(els.grupoServico, uniqueSorted("grupoServico"), "Todos", state.filters.grupoServico);
}

function filteredRecords() {
  const term = state.filters.search.toLowerCase();
  return state.records.filter((record) => {
    const text = [
      record.solicitacao,
      record.ligacao,
      record.localidade,
      record.servico,
      record.grupoServico || "Sem grupo",
      record.descricaoEncerramento,
      record.codigoServico,
    ]
      .join(" ")
      .toLowerCase();
    return (
      (!term || text.includes(term)) &&
      filterMatches("status", record.status) &&
      filterMatches("diretoria", record.diretoria) &&
      filterMatches("micro", record.micro) &&
      filterMatches("ocorrencia", record.descricaoEncerramento) &&
      filterMatches("servico", record.servico) &&
      filterMatches("grupoServico", record.grupoServico || "Sem grupo")
    );
  });
}

function number(value) {
  return value.toLocaleString("pt-BR");
}

function renderSummary(records) {
  const total = state.records.length;
  const treated = state.records.filter((record) => record.status === "tratado").length;
  const open = total - treated;
  const overdue = state.records.filter((record) => record.deadline.className === "danger").length;
  const dueSoon = state.records.filter((record) => record.deadline.className === "warn").length;
  els.total.textContent = number(total);
  els.treated.textContent = number(treated);
  els.open.textContent = number(open);
  els.overdue.textContent = number(overdue);
  els.dueSoon.textContent = number(dueSoon);
  els.progress.textContent = total ? `${Math.round((treated / total) * 100)}%` : "0%";
  const monthly = calculateMonthly();
  els.monthRateCount.textContent = pctText(monthly.current.rate);
  const totalLabel = document.getElementById("totalLabel");
  if (totalLabel) totalLabel.innerHTML = state.baselineDay ? `Volumetria diária <span class="card-sub">base fixa de ${esc(shortDay(state.baselineDay))}</span>` : "Volumetria diária";
  els.resultText.textContent = document.body.dataset.view === "monthly"
    ? monthlyResultText(monthly)
    : `${number(records.length)} EXOC(s) na visão atual. Prazo contado por Visitado em; se vazio, Data Solicitação.`;
  els.latestDate.textContent = state.latestFileName || "não enviada";
  els.baselineDate.textContent = state.baselineFileName || (state.baseline.length ? "carregada" : "não carregada");
  els.duplicateText.textContent = state.duplicateCount ? `${number(state.duplicateCount)} duplicidade(s) removida(s)` : "sem duplicidade";
  const aux = [];
  if (state.auxStatus.micro) aux.push("micro");
  if (state.auxStatus.service) aux.push("serviço");
  els.auxText.textContent = aux.length ? `${aux.join(" + ")} internos` : "internos pendentes";
  const box = document.getElementById("funnelBox");
  if (box) {
    const f = state.funnel;
    box.hidden = !f;
    if (f) {
      box.innerHTML = `<strong>Reconciliação da volumetria</strong> (base fixa de ${f.diaBase ? shortDay(f.diaBase) : "hoje"}): ${number(f.brutas)} linhas na planilha`
        + ` − ${number(f.semChave)} linhas vazias (sem solicitação, ligação e serviço)`
        + ` − ${number(f.outroAno)} visitadas em 2025`
        + ` − ${number(f.hoje)} visitadas no dia da base${f.diaBase ? ` (${f.diaBase.slice(8)}/${f.diaBase.slice(5, 7)})` : ""} ou depois`
        + ` − ${number(f.semTabela || 0)} com código fora da tabela auxiliar`
        + ` − ${number(f.semCoi)} de outra responsabilidade (não COI)`
        + ` = <strong>${number(f.final)}</strong> para tratar.`
        + (f.semData ? ` Obs.: ${number(f.semData)} sem data em "Visitado em" foram mantidas.` : "")
        + (f.duplicadas ? ` Obs.: ${number(f.duplicadas)} linha(s) repetida(s) (mesma solicitação + ligação + código) foram mantidas.` : "");
    }
  }
}

function renderTable(records) {
  const visible = records.slice(0, 200);
  els.body.innerHTML = "";
  const fragment = document.createDocumentFragment();
  visible.forEach((record) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${esc(record.procxCoi || "Não localizado")}</td>
      <td>${esc(record.diretoria || "Não localizado")}</td>
      <td>${esc(record.micro || "Não localizado")}</td>
      <td>${esc(record.solicitacao)}</td>
      <td>${esc(record.ligacao)}</td>
      <td>${esc(record.localidade)}</td>
      <td>${esc(record.servico)}</td>
      <td>${esc(record.grupoServico || "Sem grupo")}</td>
      <td>${esc(record.descricaoEncerramento)}</td>
      <td>${esc(record.visitadoEm)}</td>
      <td><span class="pill ${esc(record.deadline.className)}">${esc(record.deadline.label)}</span></td>
      <td><span class="pill ${record.appearsLatest ? "open" : "ok"}">${
      record.appearsLatest ? "Permanece" : "Saiu"
    }</span></td>
    `;
    fragment.appendChild(tr);
  });
  els.body.appendChild(fragment);
  if (records.length > visible.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="12">Mostrando ${number(visible.length)} de ${number(
      records.length
    )}. Use os filtros ou exporte o CSV para ver tudo.</td>`;
    els.body.appendChild(tr);
  }
}

function topCounts(records, field, limit = 10) {
  const counts = new Map();
  records.forEach((record) => {
    const key = record[field] || "Sem informação";
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function renderBars(container, items) {
  const max = Math.max.apply(null, items.map((item) => item[1]).concat([1]));
  container.innerHTML = "";
  items.forEach(([label, value]) => {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
      <span class="bar-value">${number(value)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(value / max) * 100}%"></span></span>
    `;
    container.appendChild(row);
  });
}

function renderCharts(records) {
  if (els.chartView.classList.contains("hidden")) return;
  renderBars(els.occurrenceBars, topCounts(records, "descricaoEncerramento"));
  renderBars(els.cityBars, topCounts(records, "localidade"));
  renderPivot(records);
}

function snapshotDateFromRecords(records) {
  const maxMs = Math.max.apply(null, records.map((record) => record.visitadoEmMs || 0).concat([0]));
  return maxMs ? dateKeyFromMs(maxMs) : todayKey();
}

function slimRecords(records) {
  return records.map((record) => ({
      key: record.key,
      referenceMs: record.referenceMs,
      referenceDate: record.referenceDate,
      localidade: record.localidade,
      diretoria: record.diretoria,
      micro: record.micro,
      solicitacao: record.solicitacao,
      ligacao: record.ligacao,
      codigoServico: record.codigoServico,
      servico: record.servico,
      grupoServico: record.grupoServico || serviceGroupFor(record.codigoServico),
      procxCoi: record.procxCoi,
      responsavel: record.responsavel,
      responsabilidade: record.responsabilidade,
      visitadoEm: record.visitadoEm,
      visitadoEmMs: record.visitadoEmMs,
      descricaoEncerramento: record.descricaoEncerramento,
      tipoEncerramento: record.tipoEncerramento,
      situacao: record.situacao,
    }));
}

function addSnapshot(fileName, records, type = "atualizacao") {
  state.histVersion = (state.histVersion || 0) + 1;
  const dateKey = todayKey();
  state.lastUpdate = { at: new Date().toISOString(), file: fileName };
  const snapshot = {
    id: `${dateKey}-${type}`,
    fileName,
    type,
    dateKey,
    uploadedAt: new Date().toISOString(),
    keys: records.map((record) => record.key),
    // atualizações só precisam das chaves (o que ainda está na base); a base fixa guarda os registros
    records: type === "base_inicial" ? slimRecords(records) : [],
  };
  state.history = fixedDailyHistory(state.history);
  const existingSameDay = state.history.find((item) => item.dateKey === dateKey);
  if (existingSameDay) {
    // reenviar a base inicial no mesmo dia substitui a anterior (para todos)
    if (type === "base_inicial") state.history = state.history.map((item) => (item.dateKey === dateKey ? snapshot : item));
    state.history.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    syncSnapshotToSheets(snapshot);
    return;
  }
  if (type === "base_inicial") {
    state.history.push(snapshot);
    state.history.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }
  syncSnapshotToSheets(snapshot);
}

const MONTH_NAMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function shortDay(dateKey) {
  return dateKey && dateKey.length >= 10 ? `${dateKey.slice(8, 10)}/${dateKey.slice(5, 7)}` : (dateKey || "-");
}

function monthLabel(monthKey) {
  if (!monthKey || monthKey.length < 7) return monthKey || "-";
  return `${MONTH_NAMES[+monthKey.slice(5, 7) - 1] || monthKey.slice(5, 7)}/${monthKey.slice(0, 4)}`;
}

function hourLabel(iso) {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

// Regra da meta 24h (por dia):
// - volumetria do dia = base fixa da manha (1a base do dia), ja tratada pelas regras
// - entram as que ja estavam vencidas E as que ainda nao venceram
// - dentro da meta = nao aparece mais na base fixa do dia seguinte
// - fora da meta  = continua na base fixa do dia seguinte (nao tratada de um dia p/ o outro)
// - o ultimo dia fica "em andamento" ate chegar a proxima base fixa
let monthlyCache = { key: "", value: null };
function calculateMonthly() {
  const cacheKey = [state.histVersion || 0, state.history.length, JSON.stringify([state.filters.diretoria, state.filters.micro, state.filters.grupoServico]), state.latestSnap ? state.latestSnap.uploadedAt : "", state.selectedMonth].join("#");
  if (monthlyCache.key === cacheKey && monthlyCache.value) return monthlyCache.value;
  monthlyCache = { key: cacheKey, value: calculateMonthlyNow() };
  return monthlyCache.value;
}

function calculateMonthlyNow() {
  const hist = fixedDailyHistory(state.history);
  const fDir = normalizeFilterValues(state.filters.diretoria), fMic = normalizeFilterValues(state.filters.micro);
  const seenBefore = new Set();
  const latest = state.latestSnap;
  const days = [];
  const items = [];
  hist.forEach((snap, index) => {
    const next = hist[index + 1] || null;
    const nextKeys = next ? new Set(next.keys || (next.records || []).map((r) => r.key)) : null;
    const partialKeys = !next && latest && latest.dateKey === snap.dateKey && latest.type !== "base_inicial" ? new Set(latest.keys || []) : null;
    const baseAt = Date.parse(snap.baseAt || snap.uploadedAt || "") || 0;
    const day = {
      day: snap.dateKey, month: snap.dateKey.slice(0, 7), fileName: snap.fileName || "", uploadedAt: snap.uploadedAt || "",
      closedBy: next ? next.dateKey : "", partialAt: partialKeys ? latest.uploadedAt : "",
      total: 0, novas: 0, vindas: 0, vencidas: 0, treated: 0, late: 0, open: 0, partialTreated: 0,
    };
    (snap.records || []).forEach((record) => {
      const parts = String(record.key).split("|");
      const nova = !seenBefore.has(record.key);
      const vencidaNaExtracao = !!(record.referenceMs && baseAt && record.referenceMs + 864e5 < baseAt);
      const it = {
        key: record.key,
        day: snap.dateKey,
        month: day.month,
        solicitacao: record.solicitacao != null ? record.solicitacao : (parts[0] || ""),
        ligacao: record.ligacao != null ? record.ligacao : (parts[1] || ""),
        codigoServico: record.codigoServico || parts[2] || "",
        servico: record.servico || "",
        grupoServico: record.grupoServico || serviceGroupFor(parts[2] || record.codigoServico || record.servico),
        procxCoi: record.procxCoi || "",
        localidade: record.localidade || "",
        diretoria: record.diretoria || "",
        micro: record.micro || "",
        ocorrencia: record.descricaoEncerramento || "",
        visitadoEm: record.visitadoEm || record.referenceDate || "",
        entrada: nova ? "Nova no dia" : "Vinda de dia anterior",
        vencidaNaExtracao,
        conferidoEm: next ? next.dateKey : "",
        situacao: "",
      };
      if (!next) {
        it.situacao = partialKeys && !partialKeys.has(record.key) ? "Em andamento (já saiu)" : "Em andamento";
      } else {
        it.situacao = nextKeys.has(record.key) ? "Fora da meta" : "Tratada na meta";
      }
      if (!fDir.includes("todos") && !fDir.includes(it.diretoria)) return;
      if (!fMic.includes("todos") && !fMic.includes(it.micro)) return;
      if (!filterMatches("grupoServico", it.grupoServico || "Sem grupo")) return;
      day.total += 1;
      if (nova) day.novas += 1; else day.vindas += 1;
      if (vencidaNaExtracao) day.vencidas += 1;
      if (it.situacao === "Tratada na meta") day.treated += 1;
      else if (it.situacao === "Fora da meta") day.late += 1;
      else {
        day.open += 1;
        if (it.situacao === "Em andamento (já saiu)") day.partialTreated += 1;
      }
      items.push(it);
    });
    (snap.records || []).forEach((record) => seenBefore.add(record.key));
    days.push(day);
  });
  const months = new Map();
  days.forEach((d) => {
    if (!months.has(d.month)) months.set(d.month, { month: d.month, eligible: 0, treated: 0, late: 0, waiting: 0, rate: 0, days: 0 });
    const m = months.get(d.month);
    m.days += 1;
    m.eligible += d.total;
    m.treated += d.treated;
    m.late += d.late;
    m.waiting += d.open;
  });
  const rows = Array.from(months.values()).sort((a, b) => a.month.localeCompare(b.month));
  rows.forEach((r) => { r.rate = rateOf(r.treated, r.late); });
  const empty = { month: "", eligible: 0, treated: 0, late: 0, waiting: 0, rate: 0, days: 0 };
  const selected = rows.find((r) => r.month === state.selectedMonth) || rows[rows.length - 1] || empty;
  return { rows, days, items, current: rows[rows.length - 1] || empty, selected };
}

function rateOf(treated, late) {
  const closed = treated + late;
  return closed ? Math.round((treated / closed) * 1000) / 10 : 0;
}

function pctText(value) {
  return `${String(value).replace(".", ",")}%`;
}

// todos os dias do mes (ate hoje, se for o mes atual), com ou sem base
function monthDayRows(monthly, monthKey) {
  const byDay = new Map(monthly.days.filter((d) => d.month === monthKey).map((d) => [d.day, d]));
  if (!monthKey) return [];
  const year = +monthKey.slice(0, 4), month = +monthKey.slice(5, 7);
  const lastOfMonth = new Date(year, month, 0).getDate();
  const today = todayKey();
  const lastDay = today.slice(0, 7) === monthKey ? +today.slice(8, 10) : lastOfMonth;
  const list = [];
  for (let d = 1; d <= lastDay; d += 1) {
    const key = `${monthKey}-${String(d).padStart(2, "0")}`;
    list.push(byDay.get(key) || { day: key, noBase: true });
  }
  byDay.forEach((d, key) => { if (!list.some((x) => x.day === key)) list.push(d); });
  return list.sort((a, b) => a.day.localeCompare(b.day));
}

function daySituation(d) {
  if (d.noBase) return "Sem base fixa";
  if (d.closedBy) return `Fechado (conferido na base de ${shortDay(d.closedBy)})`;
  if (d.partialAt) return `Em andamento: ${number(d.partialTreated)} já saíram até ${hourLabel(d.partialAt)}`;
  return "Em andamento (aguardando atualização)";
}

function monthTotals(list) {
  return list.filter((d) => !d.noBase).reduce((a, d) => {
    ["total", "novas", "vindas", "vencidas", "treated", "late", "open"].forEach((k) => { a[k] += d[k]; });
    return a;
  }, { total: 0, novas: 0, vindas: 0, vencidas: 0, treated: 0, late: 0, open: 0 });
}

function fillMonthSelect(monthly) {
  const select = document.getElementById("monthSelect");
  if (!select) return;
  const months = monthly.rows.map((r) => r.month);
  if (!months.includes(state.selectedMonth)) state.selectedMonth = months[months.length - 1] || "";
  const html = months.slice().reverse().map((m) => `<option value="${esc(m)}">${esc(monthLabel(m))}</option>`).join("");
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = state.selectedMonth;
}

function renderMonthly() {
  const monthly = calculateMonthly();
  fillMonthSelect(monthly);
  const row = monthly.selected;
  els.monthEligible.textContent = number(row.eligible);
  els.monthTreated.textContent = number(row.treated);
  els.monthPending.textContent = number(row.late);
  document.getElementById("monthWaiting").textContent = number(row.waiting);
  els.monthRate.textContent = pctText(row.rate);
  const list = monthDayRows(monthly, row.month);
  const cell = (v) => `<td>${esc(v)}</td>`;
  const body = list.map((d) => {
    if (d.noBase) return `<tr class="no-base">${cell(shortDay(d.day))}${"<td>—</td>".repeat(7)}${cell(daySituation(d))}</tr>`;
    const closed = d.treated + d.late;
    return `<tr>${[shortDay(d.day), number(d.total), number(d.novas), number(d.vindas), number(d.vencidas), number(d.treated), number(d.late), closed ? pctText(rateOf(d.treated, d.late)) : "—", daySituation(d)].map(cell).join("")}</tr>`;
  }).join("");
  const t = monthTotals(list);
  const totalRow = list.some((d) => !d.noBase)
    ? `<tr class="total-row">${["Total do mês", number(t.total), number(t.novas), number(t.vindas), number(t.vencidas), number(t.treated), number(t.late), pctText(rateOf(t.treated, t.late)), t.open ? `${number(t.open)} em andamento` : "Mês fechado"].map(cell).join("")}</tr>`
    : `<tr><td colspan="9">Nenhuma base fixa neste mês ainda.</td></tr>`;
  els.monthlyBody.innerHTML = body + totalRow;
}
function pivotValue(record, field) {
  if (field === "dia") return dayLabel(record.visitadoEmMs || record.referenceMs);
  if (field === "status") return record.status === "tratado" ? "Tratado" : "Não tratado";
  return record[field] || "Sem informação";
}

function renderPivot(records) {
  const row1 = els.pivotRow1.value;
  const row2 = els.pivotRow2.value;
  const col = els.pivotColumn.value;
  const columnMeta =
    col === "dia"
      ? Array.from(records.reduce((map, record) => {
            const ms = record.visitadoEmMs || record.referenceMs;
            const key = dateKeyFromMs(ms);
            if (key && !map.has(key)) map.set(key, { key, label: pivotDayLabel(ms), sort: ms || 0 });
            return map;
          }, new Map())
          .values()).sort((a, b) => a.sort - b.sort)
      : Array.from(new Set(records.map((record) => pivotValue(record, col))))
          .sort((a, b) => a.localeCompare(b, "pt-BR"))
          .map((value) => ({ key: value, label: value, sort: value }));
  const columns = columnMeta.map((item) => item.key);
  const rows = new Map();
  records.forEach((record) => {
    const first = pivotValue(record, row1);
    const second = pivotValue(record, row2);
    const key = `${first}||${second}`;
    if (!rows.has(key)) rows.set(key, { first, second, counts: {}, total: 0 });
    const item = rows.get(key);
    const column = col === "dia" ? dateKeyFromMs(record.visitadoEmMs || record.referenceMs) : pivotValue(record, col);
    item.counts[column] = (item.counts[column] || 0) + 1;
    item.total += 1;
  });

  const totals = {};
  let grandTotal = 0;
  columns.forEach((column) => (totals[column] = 0));
  let html = `<thead>
    <tr class="pivot-top-row">
      <th class="pivot-corner" colspan="2"></th>
      ${columnMeta.map((column) => `<th>${esc(column.label)}</th>`).join("")}
      <th>Total Geral</th>
    </tr>
    <tr class="pivot-field-row">
      <th><span>${esc(labelFor(row1))}</span></th>
      <th><span>${esc(labelFor(row2))}</span></th>
      ${columns.map(() => "<th></th>").join("")}
      <th></th>
    </tr>
  </thead><tbody>`;
  let lastFirst = null;
  const allRows = Array.from(rows.values())
    .sort((a, b) => `${a.first} ${a.second}`.localeCompare(`${b.first} ${b.second}`, "pt-BR"));
  const PIVOT_LIMIT = 150;
  allRows.slice(PIVOT_LIMIT).forEach((row) => {
    columns.forEach((column) => { totals[column] += row.counts[column] || 0; });
    grandTotal += row.total;
  });
  allRows.slice(0, PIVOT_LIMIT)
    .forEach((row) => {
      const groupStart = row.first !== lastFirst;
      lastFirst = row.first;
      html += `<tr class="${groupStart ? "group-start" : ""}">
        <td>${esc(row.first)}</td>
        <td>${esc(row.second)}</td>`;
      columns.forEach((column) => {
        const value = row.counts[column] || "";
        totals[column] += row.counts[column] || 0;
        html += `<td>${value}</td>`;
      });
      grandTotal += row.total;
      html += `<td>${row.total}</td></tr>`;
    });
  html += `<tr class="total-row"><td>Total Geral</td><td></td>${columns
    .map((column) => `<td>${totals[column] || ""}</td>`)
    .join("")}<td>${grandTotal}</td></tr></tbody>`;
  if (allRows.length > PIVOT_LIMIT) {
    html = html.replace('<tr class="total-row">', `<tr><td colspan="${columns.length + 3}">Mostrando ${PIVOT_LIMIT} de ${number(allRows.length)} linhas. Use os filtros para refinar (o Total Geral considera tudo).</td></tr><tr class="total-row">`);
  }
  els.pivotTable.innerHTML = html;
}

function labelFor(field) {
  const labels = {
    diretoria: "Diretoria",
    micro: "Micro",
    localidade: "Localidade",
    descricaoEncerramento: "Ocorrência",
    servico: "Serviço",
    grupoServico: "Grupo de servico",
    dia: "Dia visitado",
    status: "Status",
  };
  return labels[field] || field;
}

function renderSla(records) {
  const order = { danger: 0, warn: 1, ok: 2, neutral: 3 };
  const priority = records.slice()
    .filter((record) => record.status !== "tratado")
    .sort((a, b) => order[a.deadline.className] - order[b.deadline.className] || (a.referenceMs || 0) - (b.referenceMs || 0))
    .slice(0, 300);
  els.slaBody.innerHTML = "";
  const fragment = document.createDocumentFragment();
  priority.forEach((record) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="pill ${esc(record.deadline.className)}">${esc(record.deadline.label)}</span></td>
      <td>${esc(record.solicitacao)}</td>
      <td>${esc(record.ligacao)}</td>
      <td>${esc(record.localidade)}</td>
      <td>${esc(record.descricaoEncerramento)}</td>
      <td>${esc(record.referenceDate)}</td>
    `;
    fragment.appendChild(tr);
  });
  els.slaBody.appendChild(fragment);
}

// ===== Tratativa por Diretoria (parcial sobre a base fixa do dia) =====
const DIR_ALERTA_PCT = 35; // abaixo disso a diretoria ganha o alerta vermelho
const DIR_MEDALHAS = ["🥇", "🥈", "🥉"];

function pctBr(value) {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

function renderDiretorias() {
  const grid = document.getElementById("dirGrid");
  if (!grid) return;
  const porDir = new Map();
  state.records.forEach((r) => {
    const nome = r.diretoria || "Não localizado";
    const d = porDir.get(nome) || { nome, total: 0, tratadas: 0, vencidas: 0 };
    d.total += 1;
    if (r.status === "tratado") d.tratadas += 1;
    else if (r.deadline && r.deadline.className === "danger") d.vencidas += 1;
    porDir.set(nome, d);
  });
  const lista = Array.from(porDir.values())
    .map((d) => Object.assign(d, { pct: d.total ? (d.tratadas / d.total) * 100 : 0 }))
    .sort((a, b) => b.pct - a.pct || b.total - a.total);


  if (!lista.length) {
    grid.innerHTML = `<div class="dir-card"><span class="dir-detalhe">Sem base do dia carregada ainda.</span></div>`;
    return;
  }

  grid.innerHTML = lista.map((d, i) => {
    const alerta = d.pct < DIR_ALERTA_PCT;
    const abertas = d.total - d.tratadas;
    return `
      <article class="dir-card${alerta ? " alerta" : ""}">
        <div class="dir-top">
          <span class="dir-nome">${esc(d.nome)} ${DIR_MEDALHAS[i] || ""}${alerta ? `<span class="dir-alerta">🚨 Abaixo de ${DIR_ALERTA_PCT}%</span>` : ""}</span>
          <span class="dir-pct">${pctBr(d.pct)}</span>
        </div>
        <div class="dir-detalhe">
          ${number(d.total)} EXOCs · ${number(d.tratadas)} tratadas ✅ · ${number(abertas)} não tratadas ⏳${d.vencidas ? ` · <span class="venc">${number(d.vencidas)} vencidas</span>` : ""}
        </div>
        <span class="dir-track"><span class="dir-fill" style="width:${d.pct.toFixed(1)}%"></span></span>
      </article>`;
  }).join("");
}

function render() {
  renderLastUpdate();
  decorateRecords();
  updateFilterOptions();
  const records = filteredRecords();
  renderSummary(records);
  renderDiretorias();
  renderTable(records);
  renderCharts(records);
  renderSla(records);
  renderMonthly();
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  downloadBlob(name, blob);
}

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function csvText(headers, rows) {
  const lines = [headers.join(";")];
  rows.forEach((row) => {
    lines.push(row.map((value) => `"${String(value != null ? value : "").replace(/"/g, '""')}"`).join(";"));
  });
  return "\uFEFF" + lines.join("\n");
}

async function exportWorkbook(fileName, sheets) {
  const ok = await ensureXLSX();
  if (!ok || !window.XLSX) {
    setNotice("Nao consegui carregar a biblioteca de Excel para gerar XLSX. Use CSV ou verifique a conexao.", "error");
    return;
  }
  const workbook = XLSX.utils.book_new();
  sheets.forEach(({ name, rows }) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(workbook, sheet, String(name).slice(0, 31));
  });
  const data = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  downloadBlob(fileName, new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
}

function exportTracking() {
  const payload = {
    type: "painel-exoc-acompanhamento-v2",
    exportedAt: new Date().toISOString(),
    baselineFileName: state.baselineFileName,
    latestFileName: state.latestFileName,
    duplicateCount: state.duplicateCount,
    history: state.history,
    latestKeys: state.latestKeys ? Array.from(state.latestKeys) : null,
    manualStatus: state.manualStatus,
    baseline: state.baseline,
  };
  download("acompanhamento-exoc.json", JSON.stringify(payload), "application/json");
}

function dailyExportRows() {
  const headers = [
    "RESPONSAVEL",
    "Diretoria",
    "Micro",
    "Status automatico",
    "Prazo 24h",
    "Numero Solicitacao",
    "Numero Ligacao",
    "Localidade",
    "Servico",
    "Grupo de servico",
    "Ocorrencia",
    "Visitado em",
    "Ultima base",
  ];
  const rows = filteredRecords().map((record) => [
    record.procxCoi,
    record.diretoria,
    record.micro,
    record.status === "tratado" ? "Tratado" : "Nao tratado",
    record.deadline.label,
    record.solicitacao,
    record.ligacao,
    record.localidade,
    record.servico,
    record.grupoServico || "Sem grupo",
    record.descricaoEncerramento,
    record.visitadoEm,
    record.appearsLatest ? "Permanece" : "Saiu",
  ]);
  return { headers, rows };
}

function monthlyExportData() {
  const monthly = calculateMonthly();
  const month = monthly.selected.month || "sem-mes";
  const list = monthDayRows(monthly, monthly.selected.month);
  const summaryHeaders = ["Dia", "Arquivo da base fixa", "Base fixa (volumetria)", "Novas no dia", "Vindas de dias anteriores", "Ja vencidas na extracao", "Tratadas na meta", "Nao tratadas -> dia seguinte (fora da meta)", "Em andamento", "% na meta", "Situacao do dia"];
  const summaryRows = list.map((d) => d.noBase
    ? [shortDay(d.day) + "/" + d.day.slice(0, 4), "", "", "", "", "", "", "", "", "", daySituation(d)]
    : [shortDay(d.day) + "/" + d.day.slice(0, 4), d.fileName, d.total, d.novas, d.vindas, d.vencidas, d.treated, d.late, d.open, (d.treated + d.late) ? pctText(rateOf(d.treated, d.late)) : "", daySituation(d)]);
  const t = monthTotals(list);
  summaryRows.push(["Total do mes", "", t.total, t.novas, t.vindas, t.vencidas, t.treated, t.late, t.open, pctText(rateOf(t.treated, t.late)), t.open ? "Mes com dia em andamento" : "Mes fechado"]);
  const detailHeaders = ["Dia da base fixa", "Numero Solicitacao", "Numero Ligacao", "Codigo do servico", "Servico", "Grupo de servico", "Ocorrencia", "Diretoria", "Micro", "Localidade", "RESPONSAVEL", "Visitado em", "Entrada", "Ja vencida na extracao", "Resultado 24h", "Conferido na base de"];
  const detailRows = monthly.items.filter((it) => it.month === monthly.selected.month)
    .sort((a, b) => a.day.localeCompare(b.day) || String(a.solicitacao).localeCompare(String(b.solicitacao), "pt-BR", { numeric: true }))
    .map((it) => [shortDay(it.day) + "/" + it.day.slice(0, 4), it.solicitacao, it.ligacao, it.codigoServico, it.servico, it.grupoServico || "Sem grupo", it.ocorrencia, it.diretoria, it.micro, it.localidade, it.procxCoi, it.visitadoEm, it.entrada, it.vencidaNaExtracao ? "Sim" : "Nao", it.situacao, it.conferidoEm ? shortDay(it.conferidoEm) : ""]);
  return { month, summaryHeaders, summaryRows, detailHeaders, detailRows };
}
function exportCsv() {
  exportDailyCsv();
}

function exportDailyCsv() {
  const data = dailyExportRows();
  download("base-diaria-exoc.csv", csvText(data.headers, data.rows), "text/csv;charset=utf-8");
}

async function exportDailyXlsx() {
  const data = dailyExportRows();
  await exportWorkbook("base-diaria-exoc.xlsx", [{ name: "Diario", rows: [data.headers].concat(data.rows) }]);
}

function exportFormat() {
  const sel = document.getElementById("exportFormat");
  return sel ? sel.value : "xlsx";
}

async function exportMonthTable(kind) {
  const data = monthlyExportData();
  const unified = kind === "unificado";
  const headers = unified ? data.summaryHeaders : data.detailHeaders;
  const rows = unified ? data.summaryRows : data.detailRows;
  const base = `exoc-24h-${unified ? "unificado" : "analitico"}-${data.month}`;
  if (exportFormat() === "csv") {
    download(`${base}.csv`, csvText(headers, rows), "text/csv;charset=utf-8");
    return;
  }
  const ok = await ensureXLSX();
  if (!ok || !window.XLSX) {
    setNotice("Não consegui gerar o Excel agora; baixei em CSV (abre no Excel normalmente).", "error");
    download(`${base}.csv`, csvText(headers, rows), "text/csv;charset=utf-8");
    return;
  }
  await exportWorkbook(`${base}.xlsx`, [{ name: unified ? "Resumo por dia" : "Analitico", rows: [headers].concat(rows) }]);
}
function monthlyResultText(monthly) {
  const m = monthly.selected;
  if (!m.month) return "Nenhuma base fixa salva ainda.";
  return `${monthLabel(m.month)}: ${number(m.days)} dia(s) com base, volumetria ${number(m.eligible)}, ${number(m.treated)} na meta, ${number(m.late)} fora da meta, resultado ${pctText(m.rate)}.`;
}

function renderLastUpdate() {
  let badge = document.getElementById("lastUpdateBadge");
  if (!badge) {
    const bar = document.querySelector(".top-actions");
    if (!bar) return;
    badge = document.createElement("div");
    badge.id = "lastUpdateBadge";
    badge.style.cssText = "margin-right:auto;align-self:center;padding:8px 12px;border-radius:8px;background:#eaf2ff;border:1px solid #c7dce8;color:#0027bd;font-size:13px;line-height:1.3";
    bar.insertBefore(badge, bar.firstChild);
  }
  const info = state.lastUpdate;
  if (!info || !info.at) {
    badge.innerHTML = "<strong>Última atualização:</strong> aguardando base";
    return;
  }
  const when = new Date(info.at);
  const text = Number.isNaN(when.getTime()) ? esc(info.at) : when.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  badge.innerHTML = `<strong>Última atualização:</strong> ${text}${info.file ? `<br><small style="color:#4b5d63">${esc(info.file)}</small>` : ""}`;
}

let refreshing = false;
async function refreshFromSheets() {
  if (refreshing || document.visibilityState !== "visible" || !sheetsConfig().url) return;
  refreshing = true;
  try {
    const before = state.lastUpdate && state.lastUpdate.at;
    const stamp = await callSheets({ action: "stamp" });
    if (stamp && stamp.ok && typeof stamp.stamp === "string" && stamp.stamp === state.remoteStamp) return;
    if (await loadSheetsHistory()) {
      if (state.lastUpdate && state.lastUpdate.at !== before) {
        render();
        setNotice("Painel atualizado com a última base enviada.", "ok");
      }
    }
  } finally {
    refreshing = false;
  }
}
setInterval(refreshFromSheets, 5 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshFromSheets(); });

async function loadBaseline() {
  loadInternalAuxiliaries();
  await loadSavedState();
  ensureXLSX();
  await applyPreloadedTrackingState();
  if (state.baseline.length) {
    await saveState();
    setNotice(`Base fixa do dia ${shortDay(state.baselineDay)} carregada${state.latestFileName ? ", com a última atualização aplicada" : ""}.`, "ok");
  }
  render();
}

async function fixBaseOfDay(file, parsed) {
  state.baseline = parsed.rows;
  state.duplicateCount = parsed.duplicates;
  state.funnel = parsed.funnel;
  state.baselineFileName = file.name;
  state.baselineDay = todayKey();
  state.latestSnap = null;
  state.latestKeys = null;
  state.latestFileName = "";
  state.manualStatus = {};
  addSnapshot(file.name, state.baseline, "base_inicial");
  await saveState();
}

els.baselineFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (state.baselineDay === todayKey() && !confirm(`Já existe a base fixa de hoje (${state.baselineFileName}). Substituir pela "${file.name}"? Use isso só para corrigir uma base errada.`)) return;
    setNotice("Lendo e tratando a base fixa do dia...");
    const parsed = await readFile(file);
    await fixBaseOfDay(file, parsed);
    setNotice(`Base fixa de ${shortDay(todayKey())} definida: ${number(parsed.rows.length)} EXOCs. Essa volumetria fica travada até a base de amanhã.`, "ok");
    render();
  } catch (error) {
    setNotice(error.message || "Não foi possível ler a base.", "error");
  } finally {
    event.target.value = "";
  }
});

els.latestFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    setNotice("Lendo e tratando a base enviada...");
    const parsed = await readFile(file);
    if (state.baselineDay !== todayKey()) {
      // ainda nao tem base fixa hoje: esta e a 1a do dia, entao vira a fixa
      await fixBaseOfDay(file, parsed);
      setNotice(`Primeira base de hoje: virou a base fixa de ${shortDay(todayKey())} (${number(parsed.rows.length)} EXOCs). As próximas que subir hoje vão marcar o que foi tratado.`, "ok");
      render();
      return;
    }
    state.latestKeys = new Set(parsed.rows.map((record) => record.key));
    state.latestFileName = file.name;
    state.latestSnap = { dateKey: todayKey(), type: "atualizacao", uploadedAt: new Date().toISOString(), fileName: file.name, keys: Array.from(state.latestKeys) };
    addSnapshot(file.name, parsed.rows, "atualizacao");
    await saveState();
    setNotice("Atualização aplicada sobre a base fixa de hoje. A volumetria não muda; só tratadas e não tratadas.", "ok");
    render();
  } catch (error) {
    setNotice(error.message || "Não foi possível ler a nova base.", "error");
  } finally {
    event.target.value = "";
  }
});

els.stateFile.addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    state.manualStatus = payload.manualStatus || {};
    state.latestFileName = payload.latestFileName || "";
    state.baselineFileName = payload.baselineFileName || "";
    state.duplicateCount = payload.duplicateCount || 0;
    state.history = payload.history || [];
    state.baselineDay = (state.history.length ? state.history[state.history.length - 1].dateKey : "") || "";
    state.latestKeys = payload.latestKeys ? new Set(payload.latestKeys) : null;
    state.baseline = payload.baseline || [];
    await saveState();
    render();
    const toSend = (state.history || []).filter((snap) => snap && snap.dateKey);
    if (sheetsConfig().url && toSend.length) {
      for (let i = 0; i < toSend.length; i += 1) {
        setNotice(`Acompanhamento importado. Salvando: dia ${i + 1} de ${toSend.length}...`, "ok");
        const snap = Object.assign({}, toSend[i], { type: "base_inicial" });
        delete snap._keySet;
        await syncSnapshotToSheets(snap);
        await new Promise((r) => setTimeout(r, 800));
      }
      setNotice(`Acompanhamento importado e salvo (${toSend.length} dia(s)).`, "ok");
    } else {
      setNotice("Acompanhamento importado.", "ok");
    }
  } catch {
    setNotice("O arquivo de acompanhamento não pôde ser importado.", "error");
  } finally {
    event.target.value = "";
  }
});

els.exportState.addEventListener("click", exportTracking);
els.exportCsv.addEventListener("click", exportCsv);
document.getElementById("dailyExportCsv").addEventListener("click", exportDailyCsv);
document.getElementById("dailyExportXlsx").addEventListener("click", exportDailyXlsx);
els.clearData.addEventListener("click", async () => {
  if (!confirm("Limpar a base fixa e o acompanhamento salvo neste navegador?")) return;
  localStorage.removeItem(STORAGE_KEY);
  await dbClear();
  state.baseline = [];
  state.records = [];
  state.latestKeys = null;
  state.latestFileName = "";
  state.baselineFileName = "";
    state.manualStatus = {};
    state.duplicateCount = 0;
    state.history = [];
    loadInternalAuxiliaries();
  setNotice("Dados locais limpos. Carregue uma nova base inicial para começar.", "ok");
  render();
});

let searchTimer = null;
els.search.addEventListener("input", (event) => {
  state.filters.search = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 300);
});

const filterControls = [
  [els.status, "status"],
  [els.diretoria, "diretoria"],
  [els.micro, "micro"],
  [els.ocorrencia, "ocorrencia"],
  [els.servico, "servico"],
  [els.grupoServico, "grupoServico"],
];

filterControls.forEach(function(item) {
  const element = item[0];
  const key = item[1];
  if (!element) return;
  element.addEventListener("change", function(event) {
    state.filters[key] = selectedValues(event.target);
    setSelectValues(event.target, state.filters[key]);
    if (key === "diretoria") {
      state.filters.micro = ["todos"];
      setSelectValues(els.micro, state.filters.micro);
    }
    render();
  });
});

function setView(view) {
  document.body.dataset.view = view;
  els.tableView.classList.toggle("hidden", view !== "table");
  els.chartView.classList.toggle("hidden", view !== "charts");
  els.monthlyView.classList.toggle("hidden", view !== "monthly");
  els.slaView.classList.toggle("hidden", true);
  els.viewTable.classList.toggle("active", view === "table");
  els.viewCharts.classList.toggle("active", view === "charts");
  els.viewMonthly.classList.toggle("active", view === "monthly");
  els.viewTitle.textContent =
    view === "monthly"
      ? "Acompanhamento mensal EXOC 24h"
      : view === "charts"
        ? "Dinâmica para envio aos programadores"
        : "Acompanhamento diário das EXOCs";
  if (view === "monthly") els.resultText.textContent = monthlyResultText(calculateMonthly());
}

function on(element, eventName, handler) {
  if (element) element.addEventListener(eventName, handler);
}

on(els.viewTable, "click", () => setView("table"));
on(els.viewCharts, "click", () => { setView("charts"); render(); });
on(els.viewMonthly, "click", () => setView("monthly"));
on(document.getElementById("monthExportSummary"), "click", () => exportMonthTable("unificado"));
on(document.getElementById("monthExportDetail"), "click", () => exportMonthTable("analitico"));
async function savePastBase(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  const dayInput = document.getElementById("pastDay");
  const day = dayInput && dayInput.value;
  const today = todayKey();
  if (!day) { setNotice("Escolha primeiro o dia da base fixa.", "error"); return; }
  if (day > today) { setNotice("Não dá para subir base de um dia futuro.", "error"); return; }
  try {
    setNotice(`Lendo e tratando a base fixa de ${shortDay(day)}...`);
    const raw = await sheetRows(await file.arrayBuffer(), file.name);
    const cleaned = cleanRows(raw);
    const rows = applyBusinessRules(cleaned.rows, day);
    const records = slimRecords(rows);
    state.funnel = Object.assign({ brutas: raw.length, semChave: cleaned.discarded, duplicadas: cleaned.duplicates }, rows.funnel, { final: rows.length });
    const snapshot = {
      id: `${day}-base_inicial`, fileName: file.name, type: "base_inicial", dateKey: day,
      uploadedAt: new Date().toISOString(),
      baseAt: day === today ? new Date().toISOString() : new Date(`${day}T08:00:00`).toISOString(),
      keys: records.map((r) => r.key), records,
    };
    state.history = fixedDailyHistory(state.history).filter((h) => h.dateKey !== day).concat([snapshot])
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    state.histVersion = (state.histVersion || 0) + 1;
    if (day === today) {
      state.baseline = rows; state.baselineDay = day; state.baselineFileName = file.name;
      state.latestKeys = null; state.latestFileName = ""; state.latestSnap = null;
    }
    render();
    await syncSnapshotToSheets(snapshot);
    setNotice(`Base fixa de ${shortDay(day)} salva com ${number(records.length)} EXOCs tratadas (de ${number(raw.length)} linhas). Veja logo abaixo para onde foi cada linha. A aba Mensal 24h já recalculou esse dia e o anterior.`, "ok");
  } catch (error) {
    setNotice(error.message || "Não foi possível ler a base.", "error");
  }
}
on(document.getElementById("pastBaseFile"), "change", savePastBase);

// ===== Importar um mes inteiro (base ja tratada no Excel) =====
// Cada dia da coluna "data" vira a base fixa daquele dia; o resultado 24h vem da coluna "Meta".
async function importMonthFile(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    setNotice(`Lendo ${file.name}...`);
    const raw = await sheetRows(await file.arrayBuffer(), file.name);
    if (!raw.length) throw new Error("O arquivo está vazio.");
    const headers = Object.keys(raw[0]);
    const exact = (...names) => headers.find((h) => names.some((n) => normKey(h) === normKey(n)));
    const colDia = exact("data");
    const colMeta = exact("Meta");
    if (!colDia || !colMeta) throw new Error('O arquivo precisa ter as colunas "data" e "Meta".');
    const colVis = exact("Visitado em", "Visitado");
    const colDias = exact("indice duplicidade");
    const id = (v) => normalize(v).replace(/\.0+$/, "");
    const byDay = new Map();
    let ignoradas = 0;
    const lidas = [];
    raw.forEach((row) => {
      const dia = parseExcelDate(row[colDia]);
      const solicitacao = id(pick(row, ["Nº Solicitação", "No Solicitação", "Numero Solicitação"]));
      const ligacao = id(pick(row, ["Nº Ligação", "No Ligação", "Numero Ligação"]));
      const codigoServico = id(pick(row, ["Código do Serviço", "Codigo do Serviço"]));
      if (!dia.ms || !(solicitacao || ligacao)) { ignoradas += 1; return; }
      const vis = colVis ? parseExcelDate(row[colVis]) : { display: "", ms: null };
      const visDate = vis.ms ? new Date(vis.ms) : null;
      const visMs = visDate ? new Date(visDate.getFullYear(), visDate.getMonth(), visDate.getDate()).getTime() : null;
      const visTxt = visDate ? dayLabel(visMs) + "/" + visDate.getFullYear() : "";
      const tipo = normalize(pick(row, ["Tipo Encerramento", "Tipo Encerramento "]));
      const record = {
        key: [solicitacao, ligacao, codigoServico].join("|"),
        referenceMs: visMs, referenceDate: visTxt,
        localidade: normalize(pick(row, ["Localidade"])),
        diretoria: normalize(pick(row, ["Diretoria"])),
        micro: normalize(pick(row, ["Micro"])),
        solicitacao, ligacao, codigoServico,
        servico: normalize(pick(row, ["Tipo de Solicitação"])),
        grupoServico: serviceGroupFor(codigoServico),
        procxCoi: "COI", responsavel: "COI", responsabilidade: "COI",
        visitadoEm: visTxt, visitadoEmMs: visMs,
        descricaoEncerramento: normalize(pick(row, ["Descrição Tipo Encerramento", "Descricao Tipo Encerramento"])) || tipo,
        tipoEncerramento: tipo,
        situacao: normalize(pick(row, ["Situação", "Situacao"])),
        meta: normKey(row[colMeta]).startsWith("FORA") ? "FORA" : "DENTRO",
      };
      // fora do prazo continua na fixa dos dias seguintes (vinda): fica "indice duplicidade" dias, no minimo 2
      const dias = record.meta === "FORA" ? Math.max(2, parseInt(colDias ? row[colDias] : 2, 10) || 2) : 1;
      lidas.push({ day: dateKeyFromMs(dia.ms), dias, record });
    });
    const days = Array.from(new Set(lidas.map((x) => x.day))).sort();
    const pos = new Map(days.map((d, i) => [d, i]));
    days.forEach((d) => byDay.set(d, []));
    lidas.forEach((x) => {
      const i = pos.get(x.day);
      for (let j = i; j < Math.min(i + x.dias, days.length); j += 1) byDay.get(days[j]).push(x.record);
    });
    if (!days.length) throw new Error('Nenhuma linha com data válida na coluna "data".');
    if (days[days.length - 1] >= todayKey()) throw new Error("O arquivo tem dia de hoje ou futuro. Use só para meses/dias já fechados.");
    const total = lidas.length;
    if (!confirm(`Importar ${days.length} dias (${shortDay(days[0])} a ${shortDay(days[days.length - 1])}), ${number(total)} EXOCs? Os dias que já existirem serão substituídos.`)) return;
    const agora = new Date().toISOString();
    const snaps = days.map((day) => {
      const records = byDay.get(day);
      return {
        id: `${day}-base_inicial`, fileName: `${file.name} (${shortDay(day)})`, type: "base_inicial", dateKey: day,
        uploadedAt: agora,
        baseAt: new Date(`${day}T00:00:00`).toISOString(), // sem hora na base: vencida = visitada 2+ dias antes
        keys: records.map((r) => r.key), records,
      };
    });
    state.history = fixedDailyHistory(state.history).filter((h) => !byDay.has(h.dateKey)).concat(snaps)
      .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
    state.histVersion = (state.histVersion || 0) + 1;
    state.selectedMonth = days[0].slice(0, 7);
    render();
    for (let i = 0; i < snaps.length; i += 1) {
      setNotice(`Salvando ${shortDay(snaps[i].dateKey)} (${i + 1} de ${snaps.length})... não feche a página.`);
      const result = await callSheets({ action: "save", snapshot: snaps[i] });
      if (!result.skipped && !result.ok) throw new Error(`Parou no dia ${shortDay(snaps[i].dateKey)}: ${result.error || "erro desconhecido"}. Rode de novo o mesmo arquivo.`);
    }
    setNotice(`Mês importado ✓ ${days.length} dias, ${number(total)} EXOCs${ignoradas ? ` (${ignoradas} linhas sem data/número ignoradas)` : ""}. Quem abrir o link já vê.`, "ok");
  } catch (error) {
    setNotice(error.message || "Não foi possível importar o mês.", "error");
  }
}
on(document.getElementById("monthImportFile"), "change", importMonthFile);

on(document.getElementById("monthSelect"), "change", (event) => { state.selectedMonth = event.target.value; render(); });
on(els.pivotRow1, "change", render);
on(els.pivotRow2, "change", render);
on(els.pivotColumn, "change", render);

try {
  const startup = loadBaseline();
  if (startup && typeof startup.then === "function") {
    startup.then(function() {}, function(error) {
      console.error(error);
      setNotice("Erro ao carregar o painel: " + (error && error.message ? error.message : error), "error");
    });
  }
} catch (error) {
  console.error(error);
  setNotice("Erro ao carregar o painel: " + (error && error.message ? error.message : error), "error");
}
