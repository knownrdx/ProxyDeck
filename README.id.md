<div align="center">

# 🛡️ ProxyDeck

**Pengalih proxy Chrome modern dengan rute per-tab, sesi lengket, dan info IP langsung.**

[English](README.md) · [简体中文](README.zh-CN.md) · [Bahasa Indonesia](README.id.md)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f8cff?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-16c47f?style=flat-square)](LICENSE)
[![Zero build step](https://img.shields.io/badge/build-tanpa%20build-7b5cff?style=flat-square)](#-build-dari-sumber)
[![No dependencies](https://img.shields.io/badge/dependensi-nol-ffb020?style=flat-square)](#-struktur-proyek)

<img src="screenshots/connected.png" alt="ProxyDeck" width="340">
<img src="screenshots/settings.png" alt="ProxyDeck" width="340">

</div>

---

## Apa ini

Atur proxy sekali, lalu nyalakan dari toolbar. ProxyDeck menunjukkan dengan jelas **dari mana kamu keluar** — IP, kota, wilayah, negara, ISP, ASN, zona waktu — dan **berapa banyak data** yang sudah terpakai di sesi ini.

Dua hal yang membedakannya dari pengalih proxy biasa:

| | |
|---|---|
| 🗂 **Rute per-tab** | Lewatkan *satu tab* saja melalui proxy, sementara tab lain tetap memakai IP aslimu. Riset di satu jendela, tetap login normal di jendela lain. |
| 📌 **Sesi lengket** | Gateway rotasi memberi IP baru di setiap permintaan. ProxyDeck mengunci satu IP keluar dan menahannya — selama yang kamu mau, atau dengan timer yang kamu tentukan. |

---

## ✨ Fitur

### Koneksi
- **Protokol** — HTTP, HTTPS, SOCKS4, SOCKS5
- **Autentikasi** — proxy dengan username/password dijawab otomatis
- **Tempel cepat** — hampir semua format langsung dikenali dan mengisi formulir:
  ```
  host:port                       user:pass@host:port
  host:port:user:pass             socks5://user:pass@host:port
  ```
- **Banyak server** — simpan, ubah, ganti, hapus, ekspor sebagai JSON
- **Daftar bypass** — host yang selalu melewati proxy

### 🗂 Cakupan tab
Pilih **Semua tab** atau **Hanya tab terpilih**. Dalam mode tab, sebuah sakelar muncul untuk tab yang sedang aktif; nyalakan dan hanya tab itu yang diproksikan. Sisanya — email, dasbor kerjamu — tetap di koneksi asli.

> Chrome tidak menyediakan API proxy per-tab, jadi ProxyDeck menyusun host yang dimuat di tab terproksi menjadi skrip PAC. Artinya rute bekerja **per host**: jika dua tab membuka situs yang sama, keduanya mengikuti jalur yang sama.

### 📌 Sesi lengket
Gateway residensial rotasi menyisipkan id sesi di dalam username. ProxyDeck sudah tahu sintaks penyedia besar dan menyusun username aslinya untukmu:

| Penyedia | Dikirim sebagai |
|---|---|
| DataImpulse | `user__cr.us__sid.a1b2c3d4` |
| Bright Data | `user-country-us-session-a1b2c3d4` |
| Oxylabs | `user-cc-us-sessid-a1b2c3d4e5` |
| Smartproxy / Decodo | `user-country-us-session-a1b2c3d4e5` |
| IPRoyal | `user_country-us_session-a1b2c3d4` |
| Kustom | template `{cc}` / `{sid}` milikmu sendiri |

- Pilih **negara**, gateway akan memberi jalur keluar di sana
- Atur **tahan N menit**, ProxyDeck akan merotasi otomatis saat habis — isi `0` untuk menahan selamanya
- Tekan **Rotate** kapan saja untuk IP baru
- Username persis yang dikirim ke gateway selalu ditampilkan, jadi tidak perlu menebak

### 📊 Info langsung
- IP keluar dengan bendera negara, kota, wilayah, kode pos
- ISP / organisasi, ASN, zona waktu, koordinat, latensi pencarian
- Byte diunduh / diunggah, jam sesi, jumlah permintaan, rata-rata kecepatan
- Salin laporan lokasi lengkap dengan satu klik

---

## 📦 Pemasangan

Ambil `proxydeck.zip` dari [rilis terbaru](https://github.com/knownrdx/ProxyDeck/releases/latest), atau klon repositori ini.

**Chrome, Edge, Brave, Opera, Vivaldi**

1. Ekstrak ke folder permanen (browser memuatnya dari folder itu terus)
2. Buka `chrome://extensions` — di Edge alamatnya `edge://extensions`
3. Nyalakan **Developer mode**
4. Klik **Load unpacked** lalu pilih folder hasil ekstrak

**Firefox — belum didukung**

Firefox memakai `browser.proxy` dengan model `proxy.onRequest` miliknya
sendiri, bukan `chrome.proxy` + PAC seperti Chromium, jadi build ini tidak
akan berjalan di sana. Port untuk Firefox sangat diterima sebagai pull request.

---

## 🚀 Mulai cepat

1. Klik ikon ProxyDeck → tab **Add**
2. Tempel baris proxy ke **Quick paste**, tekan **Parse** — atau isi manual
3. *(opsional)* Pilih penyedia di **Sticky session**, atur negara dan durasi tahan
4. *(opsional)* Set **Proxy scope** ke *Selected tabs only*
5. Tekan **Save & Connect**

Tab Connect langsung menampilkan IP keluar barumu beserta lokasinya. Tekan tombol power kapan saja untuk kembali browsing langsung.

---

## 🔨 Build dari sumber

Tidak ada langkah build — repositori bisa langsung dimuat. Untuk membuat ZIP
yang siap dibagikan:

```bash
node tools/build-zip.js        # -> dist/proxydeck-<version>.zip
node tools/make-icons.mjs      # bangkitkan ulang set ikon (opsional)
```

Semuanya ES module murni, tanpa bundler dan tanpa `node_modules`. Lapisan
`src/engine/` berisi fungsi murni tanpa panggilan `chrome.*`, sehingga logika
perutean, sesi, dan parsing bisa diuji di luar browser.

---

## 📁 Struktur proyek

```
manifest.json                      Manifest V3
src/engine/proxy.js                logika murni — parsing, PAC, sesi, hitungan data
src/background/service-worker.js   chrome.proxy, auth, geo, penghitung byte, cakupan tab
src/popup/                         popup.html · popup.css · popup.js
icons/                             set ikon PNG yang dibangkitkan
tools/build-zip.js                 pembuat ZIP
tools/make-icons.mjs               pembangkit ikon PNG
```

Tanpa langkah build, tanpa bundler, tanpa `node_modules`.

---

## 🔐 Izin

| Izin | Kenapa dibutuhkan |
|---|---|
| `proxy` | mengatur dan menghapus proxy browser |
| `storage` | menyimpan server dan penghitungmu |
| `webRequest`, `webRequestAuthProvider` | menjawab autentikasi proxy, menghitung byte |
| `tabs`, `webNavigation` | mengetahui permintaan milik tab mana, untuk cakupan tab |
| `alarms` | menyegarkan penghitung, menjalankan timer sesi |
| `browsingData` | membersihkan kredensial proxy yang tersimpan saat rotasi |
| `<all_urls>` | memproksikan dan mengukur permintaan di situs mana pun |

**Datamu tetap milikmu.** Tidak ada yang diunggah ke mana pun. Satu-satunya panggilan keluar yang dibuat ProxyDeck sendiri adalah pencarian lokasi IP (ipwho.is, cadangan ke ipapi.co, geojs.io, ip-api.com) — dan panggilan itu justru lewat *proxy-mu*, yang memang itu tujuannya.

---

## ⚠️ Batasan yang diketahui

- **Hitungan byte adalah perkiraan.** Angkanya berasal dari `chrome.webRequest`, satu-satunya sinyal level jaringan yang bisa diakses ekstensi MV3. `Content-Length` asli dipakai bila server mengirimkannya; respons chunked dan terkompresi diperkirakan.
- **Cakupan tab berbasis host.** Chrome tidak punya API proxy per-tab. Situs sama yang dibuka di dua tab akan mengikuti jalur yang sama.
- **Proxy SOCKS tidak bisa memakai autentikasi.** Chrome tidak mendukungnya; antarmuka akan memperingatkanmu.
- **Rotasi bergantung pada gateway.** Penyedia yang mengunci sesi ke port perlu rentang port dikonfigurasi; penyedia yang mengunci ke username langsung jalan.

---

## ⚖️ Penafian

ProxyDeck adalah **alat jaringan**. Ia meneruskan lalu lintas browsermu melalui server proxy yang **kamu** sediakan sendiri — ia tidak menyediakan proxy, akun, maupun jaminan anonimitas apa pun.

**Kamu sepenuhnya bertanggung jawab atas cara penggunaannya.** Termasuk mematuhi hukum di negaramu, ketentuan layanan situs yang kamu kunjungi, dan ketentuan penyedia proxy-mu. Jangan gunakan perangkat lunak ini untuk penipuan, akses tanpa izin, mengelabui pemblokiran atau kontrol keamanan, scraping yang melanggar ketentuan situs, atau tujuan melanggar hukum lainnya.

Penulis menyediakan perangkat lunak ini "sebagaimana adanya", tanpa jaminan dalam bentuk apa pun, dan **tidak menanggung tanggung jawab apa pun** atas kerusakan, kerugian, tindakan terhadap akun, atau konsekuensi hukum yang timbul dari penggunaan maupun penyalahgunaannya. Jika kamu ragu apakah penggunaanmu sah, jangan gunakan.

---

## 🤝 Kontribusi

Proyek ini open source di bawah MIT — silakan fork, modifikasi, rilis, bahkan jual. Pull request sangat diterima.

Sebelum membuka PR, muat ekstensi secara unpacked dan verifikasi perubahanmu dengan proxy sungguhan — hubungkan, pastikan IP keluar benar-benar berubah, dan pastikan tab lain tidak terpengaruh saat memakai cakupan tab.

---

## 📄 Lisensi

[MIT](LICENSE) — pakai sesukamu, cukup pertahankan pemberitahuan hak cipta.

---

## 👤 Penulis

**Ariful Islam** — [@knownrdx](https://github.com/knownrdx)

Kalau ProxyDeck berguna untukmu, sebuah ⭐ di repositori ini sangat berarti.
