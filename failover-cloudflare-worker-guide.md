# Failover Cloudflare Worker: Codenest & Hirevidence

> Catatan pribadi, dibuat 19 Sep 2026. Environment: CachyOS, fish shell, wrangler 4.120.1.
> Tujuan: satu Worker per domain, config sendiri-sendiri, dengan halaman maintenance
> otomatis kalau origin server mati.

---

## 0. Konsep & batasan

```
Pengunjung -> Worker -> Origin utama (server sendiri)
                          | (timeout / 502 / 503 / 504 / 520-530)
                          v
              Halaman maintenance (HTML dari ASSETS, atau JSON untuk API) + status 503
```

**Batasan Free plan (dicek 19 Sep 2026, cek ulang di docs Cloudflare kalau ragu):**

| Hal | Batas | Catatan |
|---|---|---|
| Jumlah Worker per akun | 100 | 1 Worker per domain sangat aman |
| Request Worker | 100.000 / hari **per akun** | Dijumlah dari SEMUA Worker dan hostname |
| CPU per request | 10 ms | Waktu menunggu origin tidak dihitung |
| Subrequest | 50 / request | Cukup untuk failover |
| Static assets | 20.000 file, 25 MiB / file | Request asset gratis kalau tidak lewat kode Worker |

Karena `run_worker_first: true`, **semua** request lewat Worker dan ikut terhitung
ke kuota 100k/hari. Kalau terlewati, Cloudflare mengembalikan **Error 1027**.
Pantau di dashboard: Workers & Pages -> Metrics.

**Prasyarat:**
- Domain sudah aktif di Cloudflare (nameserver sudah pindah), akun yang sama.
- Setiap hostname punya record DNS dengan status **Proxied** (awan oranye).
  Tanpa itu route Worker tidak akan jalan.

---

## 1. Struktur folder

```
~/Projects/Failover/
├── Codenest/
│   ├── wrangler.jsonc
│   ├── package.json
│   ├── src/worker.js
│   └── public/maintenance/index.html
└── Hirevidence/
    ├── wrangler.jsonc
    ├── package.json
    ├── src/worker.js
    └── public/maintenance/index.html
```

Tiap folder = 1 Worker = 1 config. Tidak ada yang dishare, jadi tidak membingungkan.

---

## 2. Setup project (ulangi per folder)

```fish
cd ~/Projects/Failover/Codenest
node -v                      # wrangler 4 butuh Node 20+
npx wrangler login           # sekali saja, berlaku untuk semua folder
npx wrangler whoami          # cek akun & permission

npm init -y                  # lewati kalau package.json sudah ada
npm install -D wrangler      # pin versi wrangler per project
mkdir -p src public/maintenance
```

> Fish **tidak mendukung heredoc** (`cat << EOF`). Buat file lewat `nvim`, `nano`, atau `code .`.

---

## 3. `wrangler.jsonc` (Codenest)

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "codenest-failover",           // nama = identitas Worker. Ganti nama = Worker baru!
  "main": "src/worker.js",
  "compatibility_date": "2026-09-01",    // kunci versi runtime agar perilaku stabil

  "assets": {
    "directory": "./public",
    "binding": "ASSETS",                 // dipakai sebagai env.ASSETS di worker.js
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "run_worker_first": true             // Worker jalan dulu, baru boleh ke assets
  },

  // Pakai "routes" (bukan custom_domain) karena DNS masih menunjuk ke origin server.
  // SETIAP hostname harus didaftarkan sendiri. "codenest.id/*" TIDAK mencakup subdomain.
  "routes": [
    { "pattern": "codenest.id/*",        "zone_name": "codenest.id" },
    { "pattern": "www.codenest.id/*",    "zone_name": "codenest.id" },
    { "pattern": "api.codenest.id/*",    "zone_name": "codenest.id" },
    { "pattern": "quran.codenest.id/*",  "zone_name": "codenest.id" }
  ],

  "vars": {
    "ORIGIN_TIMEOUT_MS": "8000",         // batas tunggu origin (semua var bertipe string)
    "DEBUG": "true"                      // "false" kalau sudah stabil
  },

  "observability": { "enabled": true }   // log tersimpan di dashboard
}
```

---

## 4. `src/worker.js` (v2: multi-hostname + health)

Semua konfigurasi per hostname ada di objek `SITES` paling atas.
Menambah hostname baru = tambah 1 baris di sana (plus route di wrangler.jsonc).

```js
/**
 * Failover Worker v2
 * - Multi hostname (konfigurasi di SITES)
 * - Origin utama -> halaman maintenance (HTML dari ASSETS, atau JSON untuk API)
 * - Endpoint /__health (Worker only) dan /__health?deep=1 (cek origin juga)
 */

// ============ KONFIGURASI PER HOSTNAME (EDIT DI SINI) ============
// name       : nama tampilan (dipakai di pesan & log)
// type       : "html" = halaman maintenance dari ASSETS, "json" = balasan JSON (untuk API)
// page       : path halaman di public/ (khusus type "html"). Harus diakhiri "/"
// healthPath : path di origin yang dicek oleh /__health?deep=1
const SITES = {
  "codenest.id":       { name: "Codenest",       type: "html", page: "/maintenance/",       healthPath: "/" },
  "www.codenest.id":   { name: "Codenest",       type: "html", page: "/maintenance/",       healthPath: "/" },
  "quran.codenest.id": { name: "Codenest Quran", type: "html", page: "/maintenance/quran/", healthPath: "/" },
  "api.codenest.id":   { name: "Codenest API",   type: "json",                              healthPath: "/" },
};

// Dipakai kalau hostname belum terdaftar di SITES (mis. lupa menambah)
const DEFAULT_SITE = { name: "Website", type: "html", page: "/maintenance/", healthPath: "/" };

// ---------- Logger ----------
// Log JSON supaya mudah difilter di `wrangler tail` / dashboard
function log(env, level, msg, data = {}) {
  if (level === "debug" && env.DEBUG !== "true") return; // debug hanya tampil kalau DEBUG=true
  console.log(JSON.stringify({ level, msg, ...data }));
}

// ---------- Ambil konfigurasi hostname ----------
function getSite(env, hostname) {
  const site = SITES[hostname];
  log(env, "debug", "getSite", { hostname, found: Boolean(site) });
  if (!site) log(env, "warn", "getSite:hostname_belum_terdaftar", { hostname });
  return site || DEFAULT_SITE;
}

// ---------- Deteksi origin bermasalah ----------
// Sengaja TIDAK semua 5xx. 500 biasanya bug aplikasi, bukan origin mati.
// Kalau 500 ikut di-failover, error aplikasi kamu jadi tersembunyi.
function isFailure(env, response) {
  const s = response.status;
  const failed = s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530);
  log(env, "debug", "isFailure", { status: s, failed });
  return failed;
}

// ---------- fetch dengan timeout ----------
// fetch() tidak punya timeout bawaan, jadi pakai AbortController
async function fetchWithTimeout(env, request, timeoutMs) {
  log(env, "debug", "fetchWithTimeout:start", { url: request.url, timeoutMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer); // selalu dibersihkan, sukses maupun error
  }
}

// ---------- Helper response JSON ----------
function jsonResponse(env, data, status = 200, extraHeaders = {}) {
  log(env, "debug", "jsonResponse", { status });
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store", // jangan sampai ter-cache
      ...extraHeaders,
    },
  });
}

// ---------- Halaman / JSON maintenance ----------
async function serveMaintenance(env, request, site) {
  const host = new URL(request.url).hostname;
  log(env, "warn", "serveMaintenance:start", { host, type: site.type });

  // Untuk API: balas JSON supaya client (app/frontend) bisa membacanya
  if (site.type === "json") {
    return jsonResponse(
      env,
      {
        error: "service_unavailable",
        message: `${site.name} sedang tidak tersedia.`,
        retry_after_seconds: 120,
      },
      503,
      { "retry-after": "120", "x-failover": "maintenance-json" }
    );
  }

  // Untuk website: ambil halaman HTML dari public/ lewat binding ASSETS
  try {
    const asset = await env.ASSETS.fetch(new URL(site.page || "/maintenance/", request.url));
    log(env, "debug", "serveMaintenance:asset", { status: asset.status, page: site.page });

    if (asset.ok) {
      const headers = new Headers(asset.headers);
      headers.set("retry-after", "120");
      headers.set("cache-control", "no-store");
      headers.set("x-failover", "maintenance");
      // Status 503 = "sementara tidak tersedia" (aman untuk SEO)
      return new Response(asset.body, { status: 503, headers });
    }
  } catch (err) {
    log(env, "error", "serveMaintenance:error", { error: String(err) });
  }

  // Jaring pengaman terakhir kalau assets pun gagal
  return new Response(`${site.name} sedang maintenance.`, {
    status: 503,
    headers: { "retry-after": "120", "x-failover": "maintenance-plain" },
  });
}

// ---------- Endpoint /__health ----------
// /__health         -> cek Worker saja (cepat, selalu 200 kalau Worker hidup)
// /__health?deep=1  -> cek Worker + origin (503 kalau origin bermasalah)
async function handleHealth(env, request, site) {
  const url = new URL(request.url);
  const deep = url.searchParams.get("deep") === "1";
  log(env, "info", "handleHealth:start", { host: url.hostname, deep });

  const result = {
    status: "ok",
    site: site.name,
    host: url.hostname,
    worker: "ok",
    time: new Date().toISOString(),
  };

  if (deep) {
    const started = Date.now();
    try {
      // Fetch ke URL zone sendiri dari dalam Worker = langsung ke origin (tidak loop)
      const originUrl = new URL(site.healthPath || "/", url.origin);
      const res = await fetchWithTimeout(
        env,
        new Request(originUrl, { headers: { "user-agent": "failover-healthcheck" } }),
        3000 // health check harus cepat, lebih pendek dari timeout normal
      );
      const ok = !isFailure(env, res);
      result.origin = { ok, status: res.status, latency_ms: Date.now() - started };
      if (!ok) result.status = "degraded";
      res.body?.cancel(); // body tidak dibutuhkan, tutup supaya hemat resource
    } catch (err) {
      log(env, "error", "handleHealth:origin_error", { error: String(err) });
      result.origin = { ok: false, error: String(err), latency_ms: Date.now() - started };
      result.status = "degraded";
    }
  }

  const httpStatus = result.status === "ok" ? 200 : 503;
  log(env, "info", "handleHealth:done", { status: result.status, httpStatus });
  return jsonResponse(env, result, httpStatus, { "x-robots-tag": "noindex" });
}

// ---------- Entry point ----------
export default {
  async fetch(request, env) {
    const reqId = crypto.randomUUID().slice(0, 8); // ID untuk melacak satu request di log
    const url = new URL(request.url);
    const site = getSite(env, url.hostname);
    log(env, "info", "request:in", { reqId, method: request.method, host: url.hostname, path: url.pathname });

    // Health check dijawab di sini, TIDAK ikut logika failover
    if (url.pathname === "/__health") {
      return handleHealth(env, request, site);
    }

    // Header untuk simulasi origin mati saat testing
    const forceFail = request.headers.get("x-force-failover") === "1";

    try {
      if (forceFail) throw new Error("forced failover (test)");

      const res = await fetchWithTimeout(env, request, Number(env.ORIGIN_TIMEOUT_MS) || 8000);
      if (!isFailure(env, res)) {
        log(env, "info", "request:primary_ok", { reqId, status: res.status });
        return res; // jalur normal, response tidak diubah sama sekali
      }
      log(env, "warn", "request:primary_failed", { reqId, status: res.status });
    } catch (err) {
      log(env, "error", "request:primary_error", { reqId, error: String(err) });
    }

    return serveMaintenance(env, request, site);
  },
};
```

**Poin belajar:**
- Jalur normal tidak menyentuh response, jadi overhead minimal.
- Timeout penting: origin yang *hang* lebih buruk daripada yang *mati*.
- Kenapa tidak semua 5xx? Supaya bug aplikasi (500) tidak tertutup halaman maintenance.
- `/__health` dicek **sebelum** logika failover, supaya monitoring melihat kondisi asli, bukan halaman maintenance.

---

## 5. Halaman maintenance

`public/maintenance/index.html`:

```html
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Codenest - Maintenance</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center;
           min-height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0; text-align: center; }
  </style>
</head>
<body>
  <main>
    <h1>Codenest</h1>
    <p>Kami sedang melakukan perbaikan. Silakan coba lagi beberapa menit lagi.</p>
  </main>
</body>
</html>
```

Halaman khusus untuk subdomain (mis. Quran):

```fish
mkdir -p public/maintenance/quran
cp public/maintenance/index.html public/maintenance/quran/index.html
nvim public/maintenance/quran/index.html      # ubah teks/desain
```

Lalu arahkan lewat `page: "/maintenance/quran/"` di `SITES`.

---

## 6. Test lokal & deploy (Codenest)

```fish
npx wrangler dev
```

Terminal lain:

```fish
curl -i -H "x-force-failover: 1" http://localhost:8787
curl -s http://localhost:8787/__health
```

Yang diharapkan: `HTTP/1.1 503` + `x-failover: maintenance`, dan `/__health` mengembalikan JSON `status: ok`.

> Jalur normal belum bisa dites lokal (Worker memanggil dirinya sendiri). Tes setelah deploy.

**Kalau sebelumnya sudah ada Worker `dark-resonance-bcb4`**, hapus dulu supaya route tidak bentrok
(ada downtime beberapa detik):

```fish
npx wrangler delete --name dark-resonance-bcb4
npx wrangler deploy
```

Alternatif tanpa risiko: ubah `"name"` di config menjadi `"dark-resonance-bcb4"`, lalu langsung `npx wrangler deploy`.

Verifikasi production:

```fish
curl -sI https://codenest.id | head -n 5                                         # normal
curl -sI -H "x-force-failover: 1" https://codenest.id | grep -i -E "^HTTP|x-failover"
curl -s https://codenest.id/__health
npx wrangler tail                                                               # log live
```

---

## 7. Hirevidence (config sendiri)

```fish
cd ~/Projects/Failover/Hirevidence
npm init -y
npm install -D wrangler
mkdir -p src public/maintenance
cp ../Codenest/src/worker.js src/worker.js
cp ../Codenest/public/maintenance/index.html public/maintenance/index.html
nvim wrangler.jsonc
```

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "hirevidence-failover",                          // BEDA
  "main": "src/worker.js",
  "compatibility_date": "2026-09-01",
  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "none",
    "run_worker_first": true
  },
  "routes": [                                              // BEDA
    { "pattern": "hirevidence.com/*",     "zone_name": "hirevidence.com" },
    { "pattern": "www.hirevidence.com/*", "zone_name": "hirevidence.com" },
    { "pattern": "api.hirevidence.com/*", "zone_name": "hirevidence.com" }
  ],
  "vars": { "ORIGIN_TIMEOUT_MS": "8000", "DEBUG": "true" },
  "observability": { "enabled": true }
}
```

Di `src/worker.js`, **hanya blok `SITES` yang diganti**:

```js
const SITES = {
  "hirevidence.com":     { name: "Hirevidence",     type: "html", page: "/maintenance/", healthPath: "/" },
  "www.hirevidence.com": { name: "Hirevidence",     type: "html", page: "/maintenance/", healthPath: "/" },
  "api.hirevidence.com": { name: "Hirevidence API", type: "json",                        healthPath: "/" },
};
```

Ubah juga teks di `public/maintenance/index.html` (title dan `<h1>` jadi "Hirevidence"), lalu:

```fish
npx wrangler deploy
curl -sI -H "x-force-failover: 1" https://hirevidence.com | grep -i -E "^HTTP|x-failover"
curl -s https://hirevidence.com/__health
```

---

## 8. Menambah hostname baru (api., quran., dll.)

Checklist. Ada **4 tempat** yang perlu disentuh, dan hanya di folder Worker yang bersangkutan:

| # | Di mana | Yang dilakukan |
|---|---|---|
| 1 | Cloudflare Dashboard -> DNS | Pastikan record hostname ada dan **Proxied** (awan oranye) |
| 2 | `wrangler.jsonc` -> `routes` | Tambah `{ "pattern": "HOSTNAME/*", "zone_name": "ZONE" }` |
| 3 | `src/worker.js` -> `SITES` | Tambah 1 baris konfigurasi hostname |
| 4 | `public/maintenance/...` | Hanya kalau mau halaman maintenance khusus (type `html`) |

Lalu `npx wrangler deploy` dan test.

### Contoh: tambah `blog.codenest.id`

`wrangler.jsonc`:

```jsonc
"routes": [
  // ...route yang sudah ada...
  { "pattern": "blog.codenest.id/*", "zone_name": "codenest.id" }
]
```

`src/worker.js`:

```js
const SITES = {
  // ...yang sudah ada...
  "blog.codenest.id": { name: "Codenest Blog", type: "html", page: "/maintenance/", healthPath: "/" },
};
```

Test:

```fish
curl -sI -H "x-force-failover: 1" https://blog.codenest.id | grep -i -E "^HTTP|x-failover"
```

### Template hostname API (balasan JSON)

```js
"api.contoh.com": { name: "Contoh API", type: "json", healthPath: "/" },
```

Test (harus 503 + body JSON):

```fish
curl -i -H "x-force-failover: 1" https://api.codenest.id
```

### Catatan penting

- `codenest.id/*` **tidak** mencakup `api.codenest.id`. Tiap hostname butuh route sendiri.
- Alternatif wildcard `*.codenest.id/*` mencakup semua subdomain yang Proxied, termasuk yang tidak kamu rencanakan, jadi route eksplisit lebih aman dan mudah diaudit.
- Kalau sebuah subdomain sudah dihosting di layanan Cloudflare lain (Pages / Worker lain dengan Custom Domain), **jangan** tambahkan route untuknya (bentrok).
- Hostname yang ada di `routes` tapi lupa di `SITES` tetap jalan (pakai `DEFAULT_SITE`), tapi akan muncul log `warn` bernama `getSite:hostname_belum_terdaftar`. API jadi menerima HTML kalau lupa, jadi jangan dilewatkan.
- Setiap hostname baru menambah traffic ke kuota 100k/hari yang dipakai bersama.

---

## 9. Endpoint `/__health`

Sudah ada di `worker.js` v2 (fungsi `handleHealth`) dan otomatis aktif untuk **semua hostname** di Worker itu,
termasuk `hirevidence.com/__health` dan `api.hirevidence.com/__health`.

| URL | Yang dicek | Respons |
|---|---|---|
| `/__health` | Worker saja | `200` `{"status":"ok", ...}` |
| `/__health?deep=1` | Worker + origin | `200` kalau origin sehat, `503` `{"status":"degraded", ...}` kalau origin bermasalah |

Contoh respons deep:

```json
{
  "status": "ok",
  "site": "Hirevidence",
  "host": "hirevidence.com",
  "worker": "ok",
  "time": "2026-09-19T05:30:00.000Z",
  "origin": { "ok": true, "status": 200, "latency_ms": 142 }
}
```

Test (fish):

```fish
curl -s https://hirevidence.com/__health
curl -s "https://hirevidence.com/__health?deep=1"
sudo pacman -S jq                                  # opsional, biar JSON rapi
curl -s "https://hirevidence.com/__health?deep=1" | jq
```

Mengubah path yang dicek di origin (mis. API punya endpoint `/status`): ubah `healthPath` di `SITES`:

```js
"api.hirevidence.com": { name: "Hirevidence API", type: "json", healthPath: "/status" },
```

**Cara pakai:** arahkan uptime monitor (UptimeRobot, Better Stack, dll.) ke `/__health?deep=1`.
Interval 5 menit = 288 request/hari per hostname, masih kecil terhadap kuota 100k.

---

## 10. Troubleshooting

| Gejala | Kemungkinan penyebab | Solusi |
|---|---|---|
| Tidak ada header `x-failover` di test | Route tidak cocok / DNS tidak Proxied | Cek awan oranye + pattern di `routes` |
| Deploy error: route sudah dipakai Worker lain | Worker lama masih memegang route | `npx wrangler delete --name <nama-lama>` lalu deploy ulang |
| Error 1027 | Kuota 100k/hari (satu akun) habis | Cek Metrics di dashboard, kurangi traffic / upgrade plan |
| Halaman maintenance 404 | Path `page` salah / file tidak ada | Cek `public/maintenance/index.html`, `page` harus diakhiri `/` |
| API menerima HTML maintenance | Hostname belum ada di `SITES` | Tambah dengan `type: "json"` |
| `wrangler tail` kosong | Belum ada request / `observability` mati | Buka situsnya, cek config |
| 522 / 523 dari Cloudflare | Origin tidak terjangkau / DNS salah | Cek IP origin & firewall server |

---

## 11. Best practice & latihan

**Best practice**
1. `git init` per folder, `.gitignore` berisi `node_modules/`, `.wrangler/`, `.dev.vars`.
2. Set `"DEBUG": "false"` kalau sudah stabil, supaya log tidak bising.
3. Kalau domain sudah 3 atau lebih, pertimbangkan npm workspaces dengan satu `worker.js` bersama dan `SITES` diambil dari config terpisah.
4. Failover ini hidup di Cloudflare. Kalau Cloudflare-nya down, Worker ikut down.
5. Jangan taruh secret di `vars`. Pakai `npx wrangler secret put NAMA`.

**Latihan mandiri (learn by doing)**
1. Matikan origin sungguhan sebentar, lalu bandingkan hasilnya dengan simulasi header `x-force-failover`.
2. Tambahkan field `retryAfter` per hostname di `SITES` (bukan hardcode 120 detik).
3. Buat `/__health` mengembalikan `version` dari `env.VERSION` (tambah di `vars`).
4. Tambah kolom `backupOrigin` per hostname: coba origin cadangan sebelum menampilkan halaman maintenance.
