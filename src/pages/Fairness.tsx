import { AppFooter, LinkButton, Panel } from '../components/ui';

const SOURCES = [
  ['Layar sentuh', 'Tiap HP butuh waktu berbeda mengenali sentuhan.'],
  ['Jaringan internet', 'Tidak dipakai menilai. Bila kiriman tertunda, tekanan disimpan di HP dan dikirim ulang otomatis.'],
  ['Jam perangkat', 'Tidak dipakai menilai. Jam HP boleh beda jauh; waktu disamakan aplikasi ke jam panitia.'],
];

const STEPS = [
  ['01', 'Aplikasi menyamakan waktu', 'Perangkat mencocokkan waktunya ke server panitia lewat aplikasi. Jam HP tidak perlu disetel manual.'],
  ['02', 'Tombol dibuka', 'Tombol semua peserta menyala bersamaan.'],
  ['03', 'Waktu tekan dicatat', 'Diambil saat jari menyentuh tombol, bukan saat kiriman tiba.'],
  ['04', 'Operator memutuskan', 'Hasil diurutkan, lalu penekan tercepat ditetapkan.'],
];

export function Fairness() {
  return (
    <main className="mx-auto w-full max-w-[980px] px-5 py-8">
      <header className="border-b border-line pb-5">
        <div className="label">Cerdas Cermat 2026 · aturan rebutan</div>
        <h1 className="mt-3 text-[clamp(30px,5vw,44px)] leading-[1.02] tracking-[-0.03em]">Cara menentukan penekan tercepat</h1>
        <p className="mt-3 max-w-[640px] text-[15px] leading-relaxed text-ink/70">
          Nama tim yang muncul sebagai tercepat bisa diperiksa. Bila dua tekan terlalu berdekatan, sistem tidak memilih sendiri.
        </p>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Urutan kejadian" bodyClassName="divide-y divide-line-soft">
          {STEPS.map(([step, title, body]) => (
            <div key={step} className="flex gap-4 px-4 py-3">
              <span className="num text-[12px] text-signal">{step}</span>
              <div>
                <div className="font-display text-[16px] leading-snug">{title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink/60">{body}</p>
              </div>
            </div>
          ))}
        </Panel>

        <Panel title="Kenapa dihitung dari HP" bodyClassName="space-y-3 p-4 text-[13px] leading-relaxed text-ink/70">
          <p>Kalau dihitung saat kiriman tiba, peserta dengan jaringan lambat selalu kalah walaupun jarinya lebih cepat.</p>
          <p>Karena itu waktunya diambil di perangkat peserta, memakai penghitung waktu internal HP — bukan jam yang tampil di layar.</p>
          <p className="border-l-2 border-signal pl-3 text-ink/80">
            Jam HP yang meleset (misal 2 jam lebih cepat) tidak mengubah hasil, karena aplikasi menyinkronkan waktu ke server panitia.
          </p>
          <p className="text-ink/60">Tekan sebelum tombol menyala ditolak. Satu tekan per tim. Menahan tombol tidak dihitung berulang.</p>
        </Panel>
      </section>

      <section className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel title="Yang ikut memengaruhi selisih" bodyClassName="divide-y divide-line-soft">
          {SOURCES.map(([source, note]) => (
            <div key={source} className="px-4 py-3">
              <div className="label">{source}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink/60">{note}</p>
            </div>
          ))}
        </Panel>

        <Panel title="Seri & ulang tombol" bodyClassName="space-y-3 p-4 text-[13px] leading-relaxed text-ink/70">
          <div>
            <div className="label">seri</div>
            <p className="mt-1">
              Bila dua tekan terlalu berdekatan, hasilnya ditandai <span className="text-gold">seri</span>. Operator memutuskan: ulangi
              ronde atau pilih satu tim.
            </p>
          </div>
          <div>
            <div className="label">kiriman tertunda</div>
            <p className="mt-1">
              Bila sambungan putus tepat saat menekan, HP menyimpan tekanannya lalu mengirim ulang otomatis hingga 90 detik. Kiriman
              yang baru tiba setelah tombol ditutup ditandai agar diperiksa operator — tidak otomatis menang, tidak otomatis gugur.
            </p>
          </div>
          <div>
            <div className="label">ulang tombol</div>
            <p className="mt-1">Tombol boleh diulang pada ronde yang sama; riwayat percobaan tetap tersimpan.</p>
          </div>
          <div>
            <div className="label">lempar giliran</div>
            <p className="mt-1">Bila yang tercepat tidak bisa menjawab, giliran pindah ke penekan berikutnya.</p>
          </div>
        </Panel>
      </section>

      <section className="mt-4 border border-line bg-panel px-4 py-4">
        <div className="label">Batas perangkat</div>
        <p className="mt-2 max-w-[760px] text-[13px] leading-relaxed text-ink/65">
          HP lambat, browser yang membekukan tab, atau layar yang terkunci bisa membuat satu tim kalah beberapa milidetik. Itu batas
          perangkat, bukan penilaian.
        </p>
      </section>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <LinkButton href="/">Kembali ke pendaftaran</LinkButton>
      </div>

      <div className="mt-8">
        <AppFooter note="Aturan ini dipakai di semua ronde." />
      </div>
    </main>
  );
}
