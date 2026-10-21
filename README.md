# UPSIHub 2.0

Platform dalam talian untuk pelajar UPSI: pasar kampus, pesanan, dompet digital dan chat dalam satu sistem.
Ia tidak bergantung pada perkhidmatan pihak ketiga. Tiada WhatsApp, tiada gerbang pembayaran (payment gateway) dan tiada CDN.
Semuanya berjalan pada pelayan anda sendiri.

## Ciri-ciri

| Bahagian | Fungsi |
|---|---|
| **Pasar Kampus** | Carian langsung, tapis ikut kampus dan kategori, susun ikut popular, penilaian, harga atau terbaharu. Ada penilaian bintang, status buka/tutup dan caj penghantaran. |
| **Troli & Checkout** | Troli untuk satu kedai, pilihan hantar atau ambil sendiri, nota kepada peniaga, semakan pesanan minimum. Bayar dengan **Dompet UPSIHub** atau **tunai semasa terima**. |
| **Jejak Pesanan** | Status mengikut garis masa (Dipesan → Disediakan → Sedia/Dihantar → Selesai) dan dikemas kini secara masa nyata. Pembeli boleh batal, sahkan terima dan beri ulasan. |
| **Dompet UPSIHub** | Lejar dalaman: tambah nilai, pindah kepada rakan (e-mel atau no. matrik), keluarkan ke bank dan semak sejarah transaksi. Bayaran pesanan **dipegang (escrow)** sehingga pesanan selesai, dan dipulangkan secara automatik jika pesanan dibatal atau ditolak. |
| **Chat** | Chat masa nyata antara pelajar dan peniaga (atau sokongan admin), dengan gambar, tanda "dibaca" dan status dalam talian. |
| **Notifikasi** | Notifikasi dalam aplikasi untuk pesanan, dompet, kelulusan kedai dan mesej. |
| **Pusat Peniaga** | Permohonan 3 langkah dengan yuran lesen yang dibayar dari dompet. Ada ringkasan jualan (graf 7 hari), urus pesanan masuk, menu (gambar, harga, tersedia/habis), profil kedai, pembaharuan lesen dan suis buka/tutup. |
| **Laporan Masalah** | Pembeli boleh melaporkan masalah semasa wang masih dipegang. Wang dibekukan sehingga admin memutuskan sama ada pulangan penuh, lepaskan kepada peniaga, atau bahagikan. Lihat bahagian di bawah. |
| **Panel Admin** | Lulus, tolak atau gantung kedai (yuran dipulangkan jika ditolak). Sahkan tambah nilai berserta resit, proses pengeluaran, urus pengguna (gantung, kredit tunai kaunter), serta tetapan pakej, komisen, akaun bank, kod QR dan pengumuman. |
| **UI** | Reka bentuk baharu dengan mod gelap, mudah digunakan di telefon (navigasi bawah, drawer), boleh dipasang sebagai aplikasi (PWA) dan sesuai untuk pembaca skrin. |

## Perlindungan pembeli: laporan masalah (pertikaian)

Bayaran dompet tidak terus diberikan kepada peniaga:

1. **Pembeli buat pesanan.** Wang ditolak dari dompet pembeli dan **dipegang** oleh UPSIHub.
2. **Pesanan selesai:**
   - Jika **pembeli** tekan *Sahkan telah terima*, wang dilepaskan kepada peniaga serta-merta.
   - Jika **peniaga** yang tandakan selesai, wang terus dipegang selama **48 jam**. Jika pembeli tidak membuat laporan dalam tempoh itu, wang dilepaskan secara automatik.
3. **Laporkan masalah.** Semasa wang masih dipegang (Disediakan, Sedia, atau dalam tempoh 48 jam), pembeli boleh melapor dengan sebab, butiran dan gambar bukti. Wang **dibekukan**, dan tiada pihak boleh menukar status pesanan.
4. **Peniaga memberi penjelasan** (boleh sertakan gambar bukti).
5. **Admin membuat keputusan** di *Panel Admin › Pertikaian*:
   - **Pulangan penuh** kepada pembeli; pesanan dibatalkan.
   - **Lepaskan** kepada peniaga.
   - **Bahagikan**, iaitu sebahagian kepada setiap pihak. Komisen hanya dikira atas bahagian peniaga.

   Kedua-dua pihak menerima notifikasi berserta sebab keputusan.

Pesanan **tunai** tidak dilindungi kerana wang tidak melalui sistem. Masalah pesanan tunai diselesaikan melalui chat sokongan.

## Bagaimana wang masuk tanpa gerbang pembayaran?

Wang sebenar tetap perlu masuk ke sistem sekali. UPSIHub menggunakan dua cara, kedua-duanya tanpa pihak ketiga:

1. **Pindahan bank / DuitNow QR milik anda sendiri.** Pengguna memindahkan wang ke akaun platform, kemudian memuat naik resit. Admin menyemak lalu menekan **Sahkan**, dan dompet pengguna dikreditkan.
2. **Tunai di kaunter.** Admin menekan **Pengguna › Kredit**.

Selepas itu, semua pergerakan wang (bayar pesanan, escrow, hasil jualan, pindahan, yuran lesen) berlaku **di dalam lejar UPSIHub**.
Pengeluaran ke bank diproses oleh admin.
Panel Admin memaparkan **Baki dompet pengguna**. Nilai ini mesti sentiasa sama dengan wang dalam akaun bank platform.

> ⚠️ Menyimpan nilai tersimpan (stored value) untuk orang awam pada skala besar mungkin memerlukan kelulusan e-wang daripada Bank Negara Malaysia.
> Untuk kegunaan komuniti kampus yang kecil, bincang dengan pihak universiti, tetapkan had baki (lalai RM5,000) dan dapatkan nasihat sebelum dilancarkan secara meluas.

## Jalankan

Keperluan: **Node.js 22.13 atau lebih baharu**. Tiada `npm install` diperlukan kerana sistem ini tiada dependency luar.

```bash
npm start            # http://localhost:3000
npm test             # ujian integrasi API (escrow, refund, kawalan akses)
```

Kali pertama dijalankan, akaun admin akan dicipta dan kata laluannya dipaparkan di konsol.

| Pemboleh ubah | Lalai | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port pelayan |
| `DATA_DIR` | `./data` | Pangkalan data SQLite + gambar yang dimuat naik |
| `ADMIN_EMAIL` | `admin@upsihub.local` | E-mel akaun admin pertama |
| `ADMIN_PASSWORD` | rawak | Kata laluan admin pertama |
| `DEMO` | `1` | `0` = jangan cipta kedai & akaun demo |
| `COOKIE_SECURE` | – | Set `1` apabila dijalankan di belakang HTTPS |

Akaun demo (apabila `DEMO=1`): `pelajar@demo.upsi`, `nasilemak@demo.upsi`, `prebet@demo.upsi` dan `print@demo.upsi`. Kata laluan semuanya `demo1234`.

### Pelancaran (production)

1. Sediakan VPS atau pelayan universiti dengan Node 22.
2. Jalankan `DEMO=0 ADMIN_EMAIL=... ADMIN_PASSWORD=... COOKIE_SECURE=1 npm start` menggunakan pengurus proses seperti `systemd` atau `pm2`.
3. Letakkan di belakang Caddy atau Nginx untuk HTTPS. Chat masa nyata menggunakan Server-Sent Events, jadi matikan buffering untuk `/api/stream`.
4. **Sandaran:** salin folder `DATA_DIR` setiap hari. Folder ini mengandungi semua data dan gambar.

## Struktur

```
server.js            pelayan HTTP, fail statik, sesi
src/api.js           semua endpoint API & logik perniagaan (pesanan, dompet, chat, admin)
src/db.js            skema SQLite, tetapan lalai, data demo
src/realtime.js      hab Server-Sent Events (chat/notifikasi masa nyata)
src/security.js      hash kata laluan (scrypt), token, had kadar
public/              aplikasi web (HTML/CSS/JS tanpa framework, ikon SVG sendiri)
test/api.test.js     ujian integrasi
legacy/              versi asal satu-fail (rujukan)
```

Keselamatan: kata laluan di-hash dengan scrypt, sesi menggunakan kuki HttpOnly + SameSite=Strict, CSP ketat (tiada skrip luar atau inline), semua input disahkan di pelayan, output di-escape untuk mengelakkan XSS, dan login, pendaftaran, mesej serta pindahan dihadkan kadarnya. Pindahan dan pengeluaran wang memerlukan kata laluan.
