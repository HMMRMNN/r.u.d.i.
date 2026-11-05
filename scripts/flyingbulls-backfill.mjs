#!/usr/bin/env node
/**
 * Holt vergangene Flying-Bulls-Flüge über OpenSky Network nach und
 * schickt sie an den Worker-Import-Endpoint.
 *
 * Existiert, weil der direkte Abruf AUS DEM CLOUDFLARE WORKER heraus
 * (siehe worker/src/index.js, backfillFlyingBulls()) an einem
 * Cloudflare-522 ("Connection timed out") beim OpenSky-OAuth2-Token-
 * Endpoint scheitert -- offenbar blockt OpenSky Cloudflares Netzwerk
 * auf TCP-Ebene, ein normaler Browser/eine normale Server-IP (wie ein
 * GitHub-Actions-Runner) kommt aber durch. Dieses Skript macht also
 * denselben Abruf, nur von einer normalen IP aus, und schickt die
 * Ergebnisse per POST an /flyingbulls/archive/import, das sie dann
 * ins Archiv einträgt (gleiche Dedupe-Logik wie der direkte Abruf).
 *
 * Aufruf: node scripts/flyingbulls-backfill.mjs
 * Benötigt als Umgebungsvariablen:
 *   OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET  -- OpenSky "Api Client"
 *   FLYINGBULLS_IMPORT_TOKEN                  -- muss mit dem gleich-
 *                                                 namigen Cloudflare-
 *                                                 Secret übereinstimmen
 *   DAYS (optional, Standard 30)
 *   RUDI_WORKER (optional, Standard https://rudi.marvinradar.workers.dev)
 */

// WICHTIG: muss mit FLYING_BULLS_REGISTRATIONS in worker/src/index.js
// synchron gehalten werden -- es gibt keinen automatischen Abgleich,
// weil der Worker-Code nicht ohne Weiteres aus einem Plain-Node-Skript
// importierbar ist (Cloudflare-Workers-Modul, kein Standard-ESM-Paket).
const FLYING_BULLS_REGISTRATIONS = [
  "OE-CKW", "OE-ADM", "OE-AMM", "F-AYSB", "N991DM", "OE-EDM", "OE-EAS",
  "OE-LDM", "N996DM", "OE-ARN", "OE-ARO", "N50429", "N68RW", "N25Y",
  "N6123C", "OE-EFB", "F-AZSB", "OE-EMM", "OE-ERB", "OE-FSE", "OE-EMD",
  "OE-FAS", "OE-FRB", "OE-FDM", "D-ICDM", "OE-XTV", "N11FX", "OE-XDM",
  "OE-XSY", "D-HSDM", "D-HTDM", "D-HUDM", "OE-XFB", "N69KL",
];

const ADSBDB_API = "https://api.adsbdb.com/v0";
const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const OPENSKY_API = "https://opensky-network.org/api";
const USER_AGENT = "RUDI-Weatherstation/1.0 (+https://hmmrmnn.github.io/r.u.d.i./)";

const DAYS = Number(process.env.DAYS) > 0 ? Math.min(Number(process.env.DAYS), 365) : 30;
const RUDI_WORKER = process.env.RUDI_WORKER || "https://rudi.marvinradar.workers.dev";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Fehlt: Umgebungsvariable ${name}`);
    process.exit(1);
  }
  return value;
}

async function resolveIcao24(reg) {
  const response = await fetch(`${ADSBDB_API}/aircraft/${encodeURIComponent(reg)}`, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!response.ok) throw new Error(`adsbdb HTTP ${response.status}`);
  const data = await response.json();
  const hex = data?.response?.aircraft?.mode_s || data?.response?.mode_s || null;
  if (!hex) throw new Error("adsbdb lieferte keinen mode_s/Hexcode");
  return String(hex).trim().toLowerCase();
}

async function getOpenSkyToken(clientId, clientSecret) {
  const response = await fetch(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`OpenSky-Token-Anfrage fehlgeschlagen: HTTP ${response.status} -- ${bodyText.slice(0, 200)}`);
  const data = JSON.parse(bodyText);
  if (!data.access_token) throw new Error("OpenSky-Antwort enthält keinen access_token");
  return data.access_token;
}

async function fetchOpenSkyFlights(token, icao24, beginSec, endSec) {
  const url = `${OPENSKY_API}/flights/aircraft?icao24=${encodeURIComponent(icao24)}&begin=${beginSec}&end=${endSec}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`OpenSky HTTP ${response.status} -- ${(await response.text()).slice(0, 200)}`);
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

// Einfache Nebenläufigkeits-Begrenzung -- guter API-Bürger statt alle
// 34 Registrierungen gleichzeitig loszuschicken.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  const clientId = requireEnv("OPENSKY_CLIENT_ID");
  const clientSecret = requireEnv("OPENSKY_CLIENT_SECRET");
  const importToken = requireEnv("FLYINGBULLS_IMPORT_TOKEN");

  console.log(`Flying-Bulls-Backfill: ${FLYING_BULLS_REGISTRATIONS.length} Registrierungen, ${DAYS} Tage zurück.`);

  const token = await getOpenSkyToken(clientId, clientSecret);
  console.log("OpenSky-Token geholt.");

  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = 30 * 24 * 3600; // OpenSky-Obergrenze pro Anfrage
  const beginSec = nowSec - DAYS * 24 * 3600;

  const errors = [];
  const perRegResults = await mapWithConcurrency(FLYING_BULLS_REGISTRATIONS, 4, async (reg) => {
    const found = [];
    let icao24;
    try {
      icao24 = await resolveIcao24(reg);
    } catch (error) {
      errors.push({ reg, step: "hex-lookup", error: error.message });
      console.log(`  ${reg}: Hex-Lookup fehlgeschlagen -- ${error.message}`);
      return found;
    }

    for (let winStart = beginSec; winStart < nowSec; winStart += windowSec) {
      const winEnd = Math.min(winStart + windowSec, nowSec);
      try {
        const flights = await fetchOpenSkyFlights(token, icao24, winStart, winEnd);
        for (const f of flights) {
          const takeoffAt = Number(f.firstSeen) * 1000;
          const landedAt = Number(f.lastSeen) * 1000;
          if (!Number.isFinite(takeoffAt) || !Number.isFinite(landedAt)) continue;
          found.push({
            reg,
            callsign: f.callsign,
            origin: f.estDepartureAirport || null,
            destination: f.estArrivalAirport || null,
            takeoffAt, landedAt,
          });
        }
      } catch (error) {
        errors.push({ reg, step: "opensky-fetch", window: [winStart, winEnd], error: error.message });
        console.log(`  ${reg}: OpenSky-Abruf fehlgeschlagen -- ${error.message}`);
      }
    }
    if (found.length) console.log(`  ${reg}: ${found.length} Flug(e) gefunden.`);
    return found;
  });

  const candidates = perRegResults.flat();
  console.log(`\n${candidates.length} Flüge insgesamt gefunden (${errors.length} Fehler), sende an ${RUDI_WORKER}/flyingbulls/archive/import ...`);

  const importResponse = await fetch(`${RUDI_WORKER}/flyingbulls/archive/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Import-Token": importToken },
    body: JSON.stringify({ flights: candidates }),
  });
  const importBody = await importResponse.text();
  console.log(`Import-Antwort: HTTP ${importResponse.status} -- ${importBody}`);

  if (!importResponse.ok) {
    console.error("Import fehlgeschlagen.");
    process.exit(1);
  }

  if (errors.length) {
    console.log(`\nFehler pro Registrierung (zur Diagnose):`);
    console.log(JSON.stringify(errors, null, 2));
  }
}

main().catch((error) => {
  console.error("Backfill-Skript abgebrochen:", error);
  process.exit(1);
});
