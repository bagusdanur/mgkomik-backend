const ARCHIVE_PREFIX = "https://web.archive.org/web/2id_/";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const requestUrl = new URL(request.url);
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget) return new Response("Missing url", { status: 400 });

    let target;
    try {
      target = new URL(rawTarget);
    } catch {
      return new Response("Invalid url", { status: 400 });
    }

    const hostname = target.hostname.toLowerCase();
    if (
      target.protocol !== "https:" ||
      (hostname !== "sirenscans.com" && hostname !== "www.sirenscans.com")
    ) {
      return new Response("Target not allowed", { status: 403 });
    }

    target.hostname = "sirenscans.com";
    const archiveUrl = `${ARCHIVE_PREFIX}${target.href}`;
    try {
      const upstream = await fetch(archiveUrl, {
        redirect: "follow",
        cf: { cacheEverything: true, cacheTtl: 3600 },
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "Ryukomik-Siren-Archive/1.0",
        },
      });
      const headers = new Headers(corsHeaders());
      headers.set(
        "Content-Type",
        upstream.headers.get("Content-Type") || "text/html; charset=utf-8"
      );
      headers.set("Cache-Control", "public, max-age=3600");
      headers.set("X-Siren-Archive-Status", String(upstream.status));
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      return Response.json(
        { success: false, message: `Archive fetch failed: ${error.message}` },
        { status: 502, headers: corsHeaders() }
      );
    }
  },
};
