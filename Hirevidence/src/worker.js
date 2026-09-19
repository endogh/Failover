/**
 * Failover Worker (versi assets)
 * Alur: origin utama -> halaman maintenance dari ASSETS (503)
 */

// ---------- Logger ----------
// Log JSON supaya mudah difilter di `wrangler tail`
function log(env, level, msg, data = {}) {
  if (level === "debug" && env.DEBUG !== "true") return; // debug hanya kalau DEBUG=true
  console.log(JSON.stringify({ level, msg, ...data }));
}

// ---------- Deteksi origin bermasalah ----------
// Sengaja TIDAK semua 5xx: 500 biasanya bug aplikasi, bukan origin mati.
// Kalau 500 ikut di-failover, error aplikasi kamu tersembunyi.
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

// ---------- Halaman maintenance dari ASSETS ----------
async function serveMaintenance(env, request) {
  log(env, "warn", "serveMaintenance:start");
  try {
    // Ambil public/maintenance/index.html. Path-nya "/maintenance/"
    // karena html_handling = auto-trailing-slash
    const asset = await env.ASSETS.fetch(new URL("/maintenance/", request.url));
    log(env, "debug", "serveMaintenance:asset", { status: asset.status });

    if (asset.ok) {
      const headers = new Headers(asset.headers);
      headers.set("retry-after", "120");
      headers.set("cache-control", "no-store"); // jangan sampai ter-cache
      headers.set("x-failover", "maintenance");
      // Status 503 = "sementara tidak tersedia" (aman untuk SEO)
      return new Response(asset.body, { status: 503, headers });
    }
  } catch (err) {
    log(env, "error", "serveMaintenance:error", { error: String(err) });
  }

  // Jaring pengaman terakhir kalau assets pun gagal
  return new Response(`${env.SITE_NAME} sedang maintenance.`, {
    status: 503,
    headers: { "retry-after": "120", "x-failover": "maintenance-plain" },
  });
}

// ---------- Entry point ----------
export default {
  async fetch(request, env) {
    const reqId = crypto.randomUUID().slice(0, 8); // ID pelacak satu request
    log(env, "info", "request:in", { reqId, method: request.method, url: request.url });

    // Header untuk simulasi origin mati saat testing
    const forceFail = request.headers.get("x-force-failover") === "1";

    try {
      if (forceFail) throw new Error("forced failover (test)");

      const res = await fetchWithTimeout(env, request, Number(env.ORIGIN_TIMEOUT_MS) || 8000);
      if (!isFailure(env, res)) {
        log(env, "info", "request:primary_ok", { reqId, status: res.status });
        return res; // jalur normal, response tidak diubah
      }
      log(env, "warn", "request:primary_failed", { reqId, status: res.status });
    } catch (err) {
      log(env, "error", "request:primary_error", { reqId, error: String(err) });
    }

    return serveMaintenance(env, request);
  },
};