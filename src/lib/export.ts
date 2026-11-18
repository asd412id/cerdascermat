/**
 * Ekspor laporan lomba ke Excel (.xlsx) memakai exceljs.
 *
 * Dijalankan di peramban operator: modul ini diimpor secara dinamis saat tombol
 * Ekspor ditekan, sehingga exceljs tidak ikut bundel awal.
 *
 * Semua nilai ditulis sebagai teks/angka biasa — tidak pernah sebagai formula —
 * jadi nama tim seperti "=HYPERLINK(...)" tetap tampil apa adanya.
 */
import type { Worksheet } from 'exceljs';
import type { AuditEntry, Snapshot } from '@shared/protocol';

const INK = 'FF1A1714';
const GOLD = 'FFC9A227';
const CREAM = 'FFF6F1E6';
const LINE = 'FFE2DACA';
const MUTED = 'FF7A7166';
const DANGER = 'FFB03A2E';

const EVENT_STATUS: Record<string, string> = {
  draft: 'draf',
  open: 'pendaftaran dibuka',
  live: 'berlangsung',
  closed: 'ditutup',
};

const ROUND_STATUS: Record<string, string> = {
  idle: 'menunggu',
  open: 'berjalan',
  settled: 'selesai',
  void: 'dibatalkan',
};

const FLAG_LABEL: Record<string, string> = {
  impossible_fast: 'klaim terlalu cepat',
  impossible_slow: 'klaim terlalu lambat',
  clamped: 'dikoreksi server',
};

const ACTION_LABEL: Record<string, string> = {
  open_round: 'Ronde dibuka',
  reset_buzzer: 'Tombol diulang',
  settle: 'Poin diberikan',
  next_candidate: 'Giliran dilempar',
  set_winner: 'Pemenang diubah',
  void_round: 'Ronde dibatalkan',
  score_edit: 'Skor disunting',
  set_display_mode: 'Mode papan skor diubah',
  set_status: 'Pendaftaran diubah',
  start_event: 'Lomba dimulai',
  kick_team: 'Tim dikeluarkan',
};

const stamp = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium',
  timeStyle: 'medium',
  timeZone: 'Asia/Jakarta',
});

const timeOnly = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'short',
  timeStyle: 'short',
  timeZone: 'Asia/Jakarta',
});

function stampOf(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? stamp.format(new Date(ms)) : '—';
}

function clockOf(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? timeOnly.format(new Date(ms)) : '—';
}

function ms(value: number): number | string {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : '—';
}

/** Pembatas sel: garis tipis dan tepi bawah yang lebih tegas untuk header. */
function border(edge: 'thin' | 'hair', color = LINE) {
  return { style: edge, color: { argb: color } };
}

function boxed(ws: Worksheet, fromRow: number, toRow: number, fromCol: number, toCol: number): void {
  for (let r = fromRow; r <= toRow; r += 1) {
    for (let c = fromCol; c <= toCol; c += 1) {
      ws.getCell(r, c).border = {
        top: border('hair'),
        left: border('hair'),
        bottom: border('hair'),
        right: border('hair'),
      };
    }
  }
}

/** Judul besar berlatar gelap; dipakai setiap lembar supaya seragam. */
function banner(ws: Worksheet, text: string, subtitle: string, span: number): void {
  ws.mergeCells(1, 1, 1, span);
  const title = ws.getCell(1, 1);
  title.value = text;
  title.font = { name: 'Calibri', size: 15, bold: true, color: { argb: CREAM } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 32;

  ws.mergeCells(2, 1, 2, span);
  const sub = ws.getCell(2, 1);
  sub.value = subtitle;
  sub.font = { name: 'Calibri', size: 9, italic: true, color: { argb: MUTED } };
  sub.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;
}

/** Header tabel: teks kapital kecil di atas garis emas. */
function headerRow(ws: Worksheet, row: number, headers: string[], span: number): void {
  for (let c = 1; c <= span; c += 1) {
    const cell = ws.getCell(row, c);
    cell.value = headers[c - 1] ?? '';
    cell.font = { name: 'Calibri', size: 9, bold: true, color: { argb: INK } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : 'left', indent: 1 };
    cell.border = { bottom: { style: 'medium', color: { argb: GOLD } }, top: border('hair') };
  }
  ws.getRow(row).height = 22;
}

/** Pengaturan cetak yang sama untuk semua lembar: lanskap, muat satu halaman lebar. */
function printSetup(ws: Worksheet, titleRow: number, fitToHeight = 0): void {
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight,
    printTitlesRow: `${titleRow}:${titleRow}`,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };
}

interface Group {
  title: string;
  rows: Array<[string, string | number]>;
}

/** Blok label–nilai dua kolom, dipakai lembar Ringkasan. */
function group(ws: Worksheet, startRow: number, data: Group, span: number): number {
  ws.mergeCells(startRow, 1, startRow, span);
  const head = ws.getCell(startRow, 1);
  head.value = data.title.toUpperCase();
  head.font = { name: 'Calibri', size: 9, bold: true, color: { argb: GOLD } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
  head.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(startRow).height = 20;

  let row = startRow + 1;
  for (const [label, value] of data.rows) {
    const key = ws.getCell(row, 1);
    key.value = label;
    key.font = { name: 'Calibri', size: 10, color: { argb: MUTED } };
    key.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    ws.mergeCells(row, 2, row, span);
    const val = ws.getCell(row, 2);
    val.value = value;
    val.font = { name: 'Calibri', size: 10, bold: true, color: { argb: INK } };
    val.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(row).height = 18;
    row += 1;
  }
  boxed(ws, startRow + 1, row - 1, 1, span);
  return row + 1;
}

function summarySheet(workbook: import('exceljs').Workbook, snap: Snapshot): void {
  const ws = workbook.addWorksheet('Ringkasan', { properties: { tabColor: { argb: GOLD } } });
  ws.columns = [{ width: 26 }, { width: 30 }, { width: 24 }, { width: 22 }];
  banner(ws, 'LAPORAN LOMBA CERDAS CERMAT', `${snap.event.name} · dibuat ${stampOf(snap.serverTime)} · versi ${snap.appVersion}`, 4);

  const online = snap.teams.filter((t) => t.online).length;
  const leader = [...snap.teams].sort((a, b) => b.score - a.score)[0];
  const winner = snap.round?.awardedTeamId ? snap.teams.find((t) => t.id === snap.round?.awardedTeamId) : undefined;

  let row = 4;
  row = group(ws, row, {
    title: 'Identitas lomba',
    rows: [
      ['Nama lomba', snap.event.name],
      ['Kode bergabung', snap.event.code],
      ['Status', EVENT_STATUS[snap.event.status] ?? snap.event.status],
      ['Mode papan skor', snap.event.displayMode === 'all' ? 'semua urutan' : 'hanya tercepat'],
    ],
  }, 4);

  row = group(ws, row, {
    title: 'Ronde berjalan',
    rows: [
      ['Ronde', snap.round ? `ronde ${snap.round.seq}` : 'belum ada'],
      ['Status ronde', snap.round ? (ROUND_STATUS[snap.round.status] ?? snap.round.status) : '—'],
      ['Pemenang ronde', winner?.name ?? (snap.round?.result === 'void' ? 'dibatalkan' : 'belum diputuskan')],
      ['Poin ronde', snap.round ? snap.round.points : 0],
    ],
  }, 4);

  row = group(ws, row, {
    title: 'Peserta',
    rows: [
      ['Tim terdaftar', snap.teams.length],
      ['Sedang terhubung', `${online} dari ${snap.teams.length}`],
      ['Siap menekan', `${snap.readyTeamIds.length} tim`],
      ['Pimpinan klasemen', leader ? `${leader.name} · ${leader.score} poin` : '—'],
    ],
  }, 4);

  row = group(ws, row, {
    title: 'Parameter wasit waktu',
    rows: [
      ['Jeda sebelum tombol', `${snap.event.leadMs} ms`],
      ['Jendela keputusan', `${snap.event.decisionMs} ms`],
      ['Ambang seri', `${snap.event.tieMs} ms`],
      ['Batas ketidakpastian', `${snap.event.readyMaxUMs} ms`],
      ['Poin per ronde', snap.event.pointsPerRound],
    ],
  }, 4);

  const verdict = snap.tie
    ? 'SERI TEKNIS — pemenang ditentukan operator.'
    : snap.ranking.length
      ? `${snap.ranking[0]?.name ?? '—'} tercepat (${ms(snap.ranking[0]?.dNorm ?? 0)} ms).`
      : 'Belum ada tekan pada ronde ini.';
  ws.mergeCells(row, 1, row, 4);
  const note = ws.getCell(row, 1);
  note.value = verdict;
  note.font = { name: 'Calibri', size: 10, bold: true, color: { argb: snap.tie ? DANGER : GOLD } };
  note.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
  note.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  ws.getRow(row).height = 24;

  ws.mergeCells(row + 2, 1, row + 2, 4);
  const foot = ws.getCell(row + 2, 1);
  foot.value =
    'Waktu dicatat server. Selisih (d) diukur perangkat peserta lalu diperiksa terhadap jendela fisika jaringan.';
  foot.font = { name: 'Calibri', size: 9, italic: true, color: { argb: MUTED } };
  foot.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  ws.getRow(row + 2).height = 26;
  // Ringkasan selalu satu halaman: kalau lebih, hanya catatan kaki yang tersisa.
  printSetup(ws, 1, 1);
}

function standingsSheet(workbook: import('exceljs').Workbook, snap: Snapshot): void {
  const ws = workbook.addWorksheet('Klasemen', { properties: { tabColor: { argb: INK } } });
  ws.columns = [{ width: 6 }, { width: 34 }, { width: 11 }, { width: 14 }, { width: 14 }];
  banner(ws, 'KLASEMEN AKHIR', `${snap.event.name} · ${snap.teams.length} tim · ${stampOf(snap.serverTime)}`, 5);
  headerRow(ws, 4, ['#', 'Tim', 'Skor', 'Kehadiran', 'RTT min (ms)'], 5);

  const rows = [...snap.teams].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'id'));
  rows.forEach((team, index) => {
    const row = ws.getRow(5 + index);
    row.getCell(1).value = index + 1;
    row.getCell(2).value = team.name;
    row.getCell(3).value = team.score;
    row.getCell(4).value = team.online ? 'terhubung' : 'terputus';
    row.getCell(5).value = team.rttMinMs === null ? '—' : ms(team.rttMinMs);

    const top3 = index < 3;
    for (let c = 1; c <= 5; c += 1) {
      const cell = row.getCell(c);
      cell.font = {
        name: 'Calibri',
        size: 10,
        bold: top3,
        color: { argb: c === 1 && top3 ? GOLD : INK },
      };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF7EF' } };
      cell.alignment = { vertical: 'middle', horizontal: c === 2 ? 'left' : c === 1 ? 'center' : 'right', indent: c === 2 ? 1 : 0 };
    }
    row.getCell(3).numFmt = '0';
    row.getCell(5).numFmt = '0.0';
    row.height = 19;
  });

  if (rows.length === 0) {
    ws.mergeCells(5, 1, 5, 5);
    ws.getCell(5, 1).value = 'Belum ada tim yang bergabung.';
    ws.getCell(5, 1).font = { name: 'Calibri', size: 10, italic: true, color: { argb: MUTED } };
  } else {
    boxed(ws, 5, 4 + rows.length, 1, 5);
  }
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  if (rows.length > 0) ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + rows.length, column: 5 } };
  printSetup(ws, 4);
}

function roundSheet(workbook: import('exceljs').Workbook, snap: Snapshot): void {
  const ws = workbook.addWorksheet('Peringkat Ronde', { properties: { tabColor: { argb: DANGER } } });
  ws.columns = [{ width: 6 }, { width: 30 }, { width: 14 }, { width: 13 }, { width: 10 }, { width: 13 }, { width: 30 }];
  const subtitle = snap.round ? `Ronde ${snap.round.seq} · ${ROUND_STATUS[snap.round.status] ?? snap.round.status}` : 'Belum ada ronde';
  banner(ws, 'PERINGKAT TEKAN', `${snap.event.name} · ${subtitle}`, 7);
  headerRow(ws, 4, ['#', 'Tim', 'd normal (ms)', 'd klaim (ms)', 'u (ms)', 'Selisih (ms)', 'Catatan'], 7);

  const tied = new Set(snap.tiedTeamIds);
  snap.ranking.forEach((entry, index) => {
    const row = ws.getRow(5 + index);
    const flags = entry.flags.map((f) => FLAG_LABEL[f] ?? f);
    if (tied.has(entry.teamId)) flags.unshift('seri teknis');

    row.getCell(1).value = entry.rank;
    row.getCell(2).value = entry.name;
    row.getCell(3).value = ms(entry.dNorm);
    row.getCell(4).value = ms(entry.dRaw);
    row.getCell(5).value = ms(entry.u);
    row.getCell(6).value = ms(entry.gapMs);
    row.getCell(7).value = flags.length ? flags.join(' · ') : '—';

    const isWinner = index === 0 && !snap.tie;
    for (let c = 1; c <= 7; c += 1) {
      const cell = row.getCell(c);
      cell.font = {
        name: 'Calibri',
        size: 10,
        bold: isWinner,
        color: { argb: c === 1 && isWinner ? GOLD : c === 7 && flags.length ? DANGER : INK },
      };
      if (isWinner) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CREAM } };
      else if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF7EF' } };
      cell.alignment = { vertical: 'middle', horizontal: c === 2 || c === 7 ? 'left' : 'right', indent: c === 2 || c === 7 ? 1 : 0 };
    }
    for (const c of [3, 4, 5, 6]) row.getCell(c).numFmt = '0.0';
    row.height = 19;
  });

  if (snap.ranking.length === 0) {
    ws.mergeCells(5, 1, 5, 7);
    ws.getCell(5, 1).value = 'Tidak ada tim yang menekan pada ronde ini.';
    ws.getCell(5, 1).font = { name: 'Calibri', size: 10, italic: true, color: { argb: MUTED } };
    ws.getCell(5, 1).alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  } else {
    boxed(ws, 5, 4 + snap.ranking.length, 1, 7);
  }

  ws.views = [{ state: 'frozen', ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + Math.max(1, snap.ranking.length), column: 7 } };
  printSetup(ws, 4);
}

/** Rincian audit dalam bahasa manusia, bukan JSON mentah. */
function describeAudit(entry: AuditEntry, teams: Map<string, string>): string {
  const payload = (entry.payload && typeof entry.payload === 'object' ? entry.payload : {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof payload.roundSeq === 'number') parts.push(`ronde ${payload.roundSeq}`);
  if (typeof payload.teamId === 'string') parts.push(`tim ${teams.get(payload.teamId) ?? payload.teamId}`);
  if (typeof payload.name === 'string') parts.push(payload.name);
  if (typeof payload.points === 'number') parts.push(`+${payload.points} poin`);
  else if (typeof payload.delta === 'number') parts.push(`${payload.delta > 0 ? '+' : ''}${payload.delta} poin`);
  if (typeof payload.candidateIdx === 'number') parts.push(`giliran ke-${payload.candidateIdx + 1}`);
  if (payload.mode === 'all' || payload.mode === 'top1') parts.push(payload.mode === 'all' ? 'semua urutan' : 'hanya tercepat');
  if (typeof payload.status === 'string') parts.push(`status ${payload.status}`);
  if (typeof payload.reason === 'string') parts.push(payload.reason);
  if (typeof payload.teams === 'number') parts.push(`${payload.teams} tim`);
  return parts.length ? parts.join(' · ') : JSON.stringify(payload);
}

function auditSheet(workbook: import('exceljs').Workbook, snap: Snapshot): void {
  const ws = workbook.addWorksheet('Log Aktivitas', { properties: { tabColor: { argb: MUTED } } });
  ws.columns = [{ width: 20 }, { width: 22 }, { width: 26 }, { width: 70 }];
  banner(ws, 'LOG AKTIVITAS OPERATOR', `${snap.event.name} · ${snap.audit.length} catatan`, 4);
  headerRow(ws, 4, ['Waktu', 'Admin (id)', 'Aksi', 'Rincian'], 4);

  const teamName = new Map(snap.teams.map((team) => [team.id, team.name]));
  const entries: AuditEntry[] = snap.audit;
  entries.forEach((entry, index) => {
    const row = ws.getRow(5 + index);
    row.getCell(1).value = clockOf(entry.createdAt);
    row.getCell(2).value = entry.adminId ?? 'sistem';
    row.getCell(3).value = ACTION_LABEL[entry.action] ?? entry.action;
    row.getCell(4).value = describeAudit(entry, teamName);

    for (let c = 1; c <= 4; c += 1) {
      const cell = row.getCell(c);
      cell.font = { name: 'Calibri', size: 9, color: { argb: c === 4 ? MUTED : INK } };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAF7EF' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: c === 4 };
    }
    row.height = 18;
  });

  if (entries.length === 0) {
    ws.mergeCells(5, 1, 5, 4);
    ws.getCell(5, 1).value = 'Belum ada aktivitas.';
    ws.getCell(5, 1).font = { name: 'Calibri', size: 10, italic: true, color: { argb: MUTED } };
  } else {
    boxed(ws, 5, 4 + entries.length, 1, 4);
  }
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  printSetup(ws, 4);
}

/** Susun berkas .xlsx dari snapshot lomba (tanpa menyentuh DOM). */
export async function buildWorkbook(snap: Snapshot): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Cerdas Cermat';
  workbook.lastModifiedBy = 'Cerdas Cermat';
  workbook.created = new Date(snap.serverTime);
  workbook.modified = new Date(snap.serverTime);

  summarySheet(workbook, snap);
  standingsSheet(workbook, snap);
  roundSheet(workbook, snap);
  auditSheet(workbook, snap);

  return (await workbook.xlsx.writeBuffer()) as unknown as ArrayBuffer;
}

/** Bangun dan unduh berkas .xlsx dari snapshot lomba. */
export async function downloadWorkbook(snap: Snapshot): Promise<void> {
  const buffer = await buildWorkbook(snap);
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cerdas-cermat-${snap.event.code}.xlsx`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
