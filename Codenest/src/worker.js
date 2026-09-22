/**
 * Failover Worker (versi assets)
 * Alur: origin utama -> halaman maintenance dari ASSETS (503)
 */

const SITES = {
  "codenest.id":       { name: "Codenest",       type: "html", page: "/maintenance/",       healthPath: "/" },
  "www.codenest.id":   { name: "Codenest",       type: "html", page: "/maintenance/",       healthPath: "/" },
  "quran.codenest.id": { name: "Codenest Quran", type: "html", page: "/maintenance/quran/", healthPath: "/" },
  "api.codenest.id":   { name: "Codenest API",   type: "json",                              healthPath: "/" },
  "log.codenest.id":   { name: "Codenest Log",   type: "html", page: "/maintenance/log/",   healthPath: "/" },
};

// Dipakai kalau hostname belum terdaftar di SITES (mis. lupa menambah)
const DEFAULT_SITE = { name: "Codenest", type: "html", page: "/maintenance/", healthPath: "/" };


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

// ---------- Tentukan timeout per path ----------
function getTimeout(env, site, pathname) {
  const base = Number(env.ORIGIN_TIMEOUT_MS) || 8000;
  for (const [prefix, ms] of Object.entries(site.slowPaths || {})) {
    if (pathname.startsWith(prefix)) {
      log(env, "debug", "getTimeout:slow_path", { prefix, ms });
      return ms;
    }
  }
  log(env, "debug", "getTimeout:default", { ms: base });
  return base;
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
    const site = getSite(env, url.hostname); // WAJIB: dipakai oleh getTimeout & serveMaintenance
    log(env, "info", "request:in", { reqId, method: request.method, host: url.hostname, path: url.pathname });

    // Health check dijawab di sini, TIDAK ikut logika failover
    if (url.pathname === "/__health") {
      return handleHealth(env, request, site);
    }

    // Header untuk simulasi origin mati saat testing
    const forceFail = request.headers.get("x-force-failover") === "1";
    const started = Date.now(); // catat waktu mulai untuk hitung durasi

    try {
      if (forceFail) throw new Error("forced failover (test)");

      const res = await fetchWithTimeout(env, request, getTimeout(env, site, url.pathname));
      if (!isFailure(env, res)) {
        log(env, "info", "request:primary_ok", { reqId, status: res.status, elapsed_ms: Date.now() - started });
        return res; // jalur normal, response tidak diubah sama sekali
      }
      // Origin membalas, tapi dengan status error
      log(env, "warn", "request:primary_failed", {
        reqId, path: url.pathname, status: res.status, elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      // AbortError = kena timeout (lambat); selain itu = error jaringan/bug kode
      const reason = err.name === "AbortError" ? "timeout" : "network_error";
      log(env, "error", "request:primary_error", {
        reqId, path: url.pathname, reason, error: String(err), elapsed_ms: Date.now() - started,
      });
    }

    return serveMaintenance(env, request, site);
  },
};