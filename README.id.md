<div align="center">

# 🛡️ ProxyDeck

**Pengalih proxy Chrome modern dengan rute per-tab, sesi lengket, dan info IP langsung.**

[English](README.md) · [简体中文](README.zh-CN.md) · [Bahasa Indonesia](README.id.md)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f8cff?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-16c47f?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tes-175%20unit%20%2B%2085%20e2e-7b5cff?style=flat-square)](#-pengujian)
[![No dependencies](https://img.shields.io/badge/dependensi-nol-ffb020?style=flat-square)](#-struktur-proyek)

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

**Dari sumber** (disarankan selama masih berupa unpacked):

1. Unduh atau klon repositori ini
2. Buka `chrome://extensions`
3. Aktifkan **Developer mode** (kanan atas)
4. Klik **Load unpacked** lalu pilih folder proyek

**Dari ZIP:**

```bash
node tools/build-zip.js        # membuat dist/proxydeck-<version>.zip
```

Lalu seret ZIP itu ke `chrome://extensions`.

---

## 🚀 Mulai cepat

1. Klik ikon ProxyDeck → tab **Add**
2. Tempel baris proxy ke **Quick paste**, tekan **Parse** — atau isi manual
3. *(opsional)* Pilih penyedia di **Sticky session**, atur negara dan durasi tahan
4. *(opsional)* Set **Proxy scope** ke *Selected tabs only*
5. Tekan **Save & Connect**

Tab Connect langsung menampilkan IP keluar barumu beserta lokasinya. Tekan tombol power kapan saja untuk kembali browsing langsung.

---

## 🧪 Pengujian

Semua di sini diverifikasi dengan browser asli dan proxy asli — tanpa mock.

```bash
# 175 asersi engine, Node biasa, tanpa browser
node tests/run-tests.mjs

# jalankan Chrome for Testing dengan ekstensi termuat
bash tools/restart-chrome.sh

# 52 pemeriksaan: koneksi, auth, geo, penghitung, diskoneksi
CDP_PORT=9335 python tools/e2e.py

# 33 pemeriksaan: sesi lengket menahan satu IP, rotasi, isolasi tab
CDP_PORT=9335 python tools/e2e_tabs.py
```

Rangkaian uji end-to-end mencatat IP aslimu, terhubung lewat proxy hulu sungguhan, lalu memastikan halaman keluar dari tempat lain — kemudian memutus koneksi dan memastikan IP-nya kembali. Isolasi tab dibuktikan dengan memuat dua tab pada saat bersamaan dan memeriksa bahwa keduanya melaporkan IP yang **berbeda**.

Uji juga artefak yang dikirim, bukan hanya direktori kerja:

```bash
node tools/build-zip.js
unzip -o dist/proxydeck-*.zip -d /tmp/proxydeck-ship
EXT_DIR=/tmp/proxydeck-ship bash tools/restart-chrome.sh
CDP_PORT=9335 python tools/e2e.py
```

---

## 📁 Struktur proyek

```
manifest.json                      Manifest V3
src/engine/proxy.js                logika murni — parsing, PAC, sesi, hitungan data
src/background/service-worker.js   chrome.proxy, auth, geo, penghitung byte, cakupan tab
src/popup/                         popup.html · popup.css · popup.js
icons/                             set ikon PNG yang dibangkitkan
tests/run-tests.mjs                175 asersi, nol dependensi
tools/build-zip.js                 pembuat ZIP
tools/make-icons.mjs               pembangkit ikon PNG
tools/restart-chrome.sh            peluncur Chrome for Testing
tools/e2e.py                       rangkaian koneksi / geo / penggunaan data
tools/e2e_tabs.py                  rangkaian cakupan tab / sesi lengket
tools/cdp.py                       klien DevTools Protocol minimal
```

Tanpa langkah build, tanpa bundler, tanpa `node_modules`. Lapisan `engine/` adalah fungsi murni tanpa panggilan `chrome.*`, itulah sebabnya seluruh rangkaian uji selesai dalam milidetik di Node biasa.

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

## 🤝 Kontribusi

Proyek ini open source di bawah MIT — silakan fork, modifikasi, rilis, bahkan jual. Pull request sangat diterima.

Sebelum membuka PR:

```bash
node tests/run-tests.mjs     # harus tetap hijau
```

Jika kamu menyentuh perutean, penanganan sesi, atau penghitung, tolong tambahkan asersi di `tests/run-tests.mjs`, dan bila butuh browser sungguhan, di `tools/e2e_tabs.py`.

---

## 📄 Lisensi

[MIT](LICENSE) — pakai sesukamu, cukup pertahankan pemberitahuan hak cipta.

---

## 👤 Penulis

**Ariful Islam** — [@knownrdx](https://github.com/knownrdx)

Kalau ProxyDeck berguna untukmu, sebuah ⭐ di repositori ini sangat berarti.
