import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../shared/protocol';
import { buildWorkbook } from '../src/lib/export';

function snapshot(): Snapshot {
  return {
    appVersion: '1.0.0',
    serverTime: Date.UTC(2026, 0, 17, 3, 30),
    event: {
      id: 'evt_1',
      name: 'Cerdas Cermat Kecamatan',
      code: 'ABC123',
      status: 'live',
      displayMode: 'top1',
      leadMs: 900,
      decisionMs: 220,
      tieMs: 15,
      readyMaxUMs: 150,
      pointsPerRound: 100,
    },
    teams: [
      { id: 't1', name: 'Alfa', score: 200, online: true, lastSeenAt: 1, rttMinMs: 24.5 },
      { id: 't2', name: '=2+2', score: 100, online: false, lastSeenAt: 1, rttMinMs: null },
    ],
    round: { id: 'r1', seq: 3, status: 'open', awardedTeamId: null, result: null, points: 100 },
    attempt: null,
    ranking: [
      { teamId: 't1', name: 'Alfa', rank: 1, dNorm: 180.4, dRaw: 180.4, u: 10, flags: [], gapMs: 0 },
      { teamId: 't2', name: '=2+2', rank: 2, dNorm: 205, dRaw: -40, u: 10, flags: ['impossible_fast'], gapMs: 24.6 },
    ],
    tie: false,
    tiedTeamIds: [],
    candidateTeamId: 't1',
    audit: [{ id: 'a1', adminId: 'adm_1', action: 'settle', payload: { roundSeq: 3, points: 100 }, createdAt: 1 }],
    readyTeamIds: ['t1'],
  };
}

async function readBack(snap: Snapshot) {
  const buffer = await buildWorkbook(snap);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer));
  return workbook;
}

describe('buildWorkbook', () => {
  it('membuat empat lembar laporan berurutan', async () => {
    const workbook = await readBack(snapshot());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Ringkasan',
      'Klasemen',
      'Peringkat Ronde',
      'Log Aktivitas',
    ]);
  });

  it('judul laporan dan nama lomba ikut tertulis', async () => {
    const workbook = await readBack(snapshot());
    const summary = workbook.getWorksheet('Ringkasan')!;
    expect(summary.getCell(1, 1).value).toBe('LAPORAN LOMBA CERDAS CERMAT');
    const values = new Set<string>();
    summary.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string') values.add(cell.value);
      });
    });
    expect(values.has('Cerdas Cermat Kecamatan')).toBe(true);
    expect(values.has('ABC123')).toBe(true);
  });

  it('klasemen mengurutkan skor dan menulis angka sebagai angka', async () => {
    const workbook = await readBack(snapshot());
    const sheet = workbook.getWorksheet('Klasemen')!;
    expect(sheet.getCell(4, 2).value).toBe('Tim');
    expect(sheet.getCell(5, 2).value).toBe('Alfa');
    expect(sheet.getCell(5, 3).value).toBe(200);
    expect(sheet.getCell(6, 3).value).toBe(100);
  });

  it('nama tim berawalan "=" tetap teks, bukan formula', async () => {
    const workbook = await readBack(snapshot());
    const sheet = workbook.getWorksheet('Klasemen')!;
    const cell = sheet.getCell(6, 2);
    expect(cell.value).toBe('=2+2');
    expect(cell.formula).toBeUndefined();
  });

  it('tidak ada satu sel pun yang berisi formula', async () => {
    const workbook = await readBack(snapshot());
    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          expect(cell.formula).toBeUndefined();
        });
      });
    }
  });

  it('peringkat ronde menampilkan selisih dan catatan flag', async () => {
    const workbook = await readBack(snapshot());
    const sheet = workbook.getWorksheet('Peringkat Ronde')!;
    expect(sheet.getCell(5, 1).value).toBe(1);
    expect(sheet.getCell(5, 2).value).toBe('Alfa');
    expect(sheet.getCell(5, 3).value).toBe(180.4);
    expect(sheet.getCell(6, 7).value).toBe('klaim terlalu cepat');
  });

  it('snapshot kosong tetap menghasilkan berkas yang bisa dibaca', async () => {
    const empty: Snapshot = {
      ...snapshot(),
      teams: [],
      ranking: [],
      tie: false,
      audit: [],
      round: null,
      readyTeamIds: [],
    };
    const workbook = await readBack(empty);
    expect(workbook.worksheets).toHaveLength(4);
    expect(workbook.getWorksheet('Klasemen')!.getCell(5, 1).value).toBe('Belum ada tim yang bergabung.');
    expect(workbook.getWorksheet('Peringkat Ronde')!.getCell(5, 1).value).toBe(
      'Tidak ada tim yang menekan pada ronde ini.',
    );
  });
});
