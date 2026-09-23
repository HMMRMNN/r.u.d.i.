/**
 * R.U.D.I. Worker Platform
 *
 * Zentraler Cloudflare Worker fuer das R.U.D.I. E-Ink-Dashboard-System:
 * Wetter, Gleitschirm, Schnee, Flugradar, Training, Pizza-Bilanz,
 * Steuerung/Zeitplan fuer mehrere Displays.
 *
 * Endpoints: siehe die "Not found"-Antwort (default-Zweig unten) fuer
 * die vollstaendige, immer aktuelle Liste.
 *
 * Benötigt: KV-Namespace-Binding "RUDI_KV" (Workers KV, im Dashboard
 * unter Settings -> Variables -> KV Namespace Bindings anlegen und
 * unter dem Namen RUDI_KV an diesen Worker binden).
 *
 * Cron: im Dashboard unter Settings -> Triggers -> Cron Triggers,
 * z.B. "0 18 * * *" (taeglich, fuer Health-Check + Pizza-Fahrterkennung).
 */

/**
 * Versionskennung. Erscheint in /health.
 *
 * Zweck: eindeutig erkennbar machen, WELCHER Code gerade laeuft.
 * Am 23.08.2026 kostete es mehrere Runden, weil eine Fehlermeldung
 * aus einer laengst ersetzten Codezeile stammte -- ohne Kennung war
 * von aussen nicht unterscheidbar, ob ein Fix nicht wirkte oder
 * schlicht nicht deployt war. Bei jeder Aenderung hochzaehlen.
 *
 * v14 (25.08.2026): Radrennen-Seite (racing.html) und der komplette
 * dazugehoerige Scraper/Zweitquellen-Code (PCS + cyclinguptodate.com
 * KI-Extraktion) komplett entfernt -- auf Nutzerwunsch. Zeitplan-
 * System umgebaut: keine automatische Bedingungspruefung (Rennen
 * laeuft/Winter) mehr, stattdessen vollstaendig manuelle monatliche
 * Rotation (siehe monthlyRotation in DEFAULT_SCHEDULE).
 *
 * v15 (25.08.2026): Pizza-Bilanz (pizza.html) ergaenzt -- zeigt nach
 * einer neu erkannten Radfahrt (via intervals.icu) automatisch fuer
 * 24h eine Infografik mit "verdienten" Pizzastuecken. WICHTIG: nutzt
 * bewusst NICHT das alte conditionalWindows-System (das gibt's seit
 * v14 nicht mehr) -- stattdessen ein eigener, separater Mechanismus
 * (siehe pizza:state in KV, maybeInsertPizzaWindow), der additiv zur
 * rein manuellen Monats-Rotation eine Fahrt-Feier einschiebt, ohne
 * das monatliche Raster selbst wieder automatisch zu machen.
 *
 * v16 (25.08.2026): Tour-de-France-Femmes-Sonderfunktion (/tdf-femmes,
 * /tdf-femmes/refresh -- der allererste Baustein dieses Projekts,
 * inzwischen laengst durch das generische Renn-/Zeitplansystem
 * ueberholt) komplett entfernt, auf Nutzerwunsch. training.html als
 * eigene Seite ergaenzt (Backend war schon kompatibel, siehe /training).
 */
const WORKER_VERSION = "2026-08-25-cleanup-v16";

const CONFIG = Object.freeze({
  allowedOrigins: new Set([
    "https://hmmrmnn.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ]),
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    try {
      switch (pathname) {
        case "/health":
          return await healthResponse(request, env);

        // Additiv: schickt sofort eine Telegram-Probe-Nachricht, zum
        // Testen ob die Einrichtung (TELEGRAM_BOT_TOKEN/_CHAT_ID) läuft,
        // ohne auf den nächsten Gesundheitscheck/Flying-Bulls-Fund warten
        // zu müssen. Alter Pfadname /ntfy/test bleibt als Alias
        // funktionsfähig (falls irgendwo noch verlinkt), macht aber
        // dasselbe wie /telegram/test.
        case "/telegram/test":
        case "/ntfy/test":
          return await handleNtfyTest(request, env);

        // Additiv: proxied paraglidable.com serverseitig, um CORS-Probleme
        // im Browser zu umgehen. Key bleibt serverseitig.
        case "/paraglidable":
          return await handleParaglidable(request, env);

        // Additiv: Live-Windmessungen von Holfuy-Stationen an den
        // relevanten Startplätzen (Hochfelln, Kössen). Key bleibt
        // serverseitig als Secret, genau wie bei Paraglidable.
        case "/holfuy":
          return await handleHolfuy(request, env);

        // Additiv: Gleitschirm-Live-Tracking via Open Glider Network.
        case "/paragliders":
          return await handleParagliders(request, env);

        // Additiv (auf Nutzerwunsch): Chiemsee-Wassertemperatur von der
        // offiziellen bayerischen Messstation (Gewässerkundlicher
        // Dienst, Station "Stock"). Nur als HTML-Tabelle verfügbar,
        // kein JSON -- wird hier serverseitig ausgelesen und kurz
        // gecacht (KV), um die Behördenseite nicht bei jedem
        // Seitenaufruf neu zu belasten.
        case "/chiemsee/watertemp":
          return await handleChiemseeWaterTemp(request, env);

        // Additiv (auf Nutzerwunsch): Langzeit-Verlauf (Tageswerte,
        // seit 1. Januar) statt nur der letzten Stunden -- andere
        // Unterseite bei GKD Bayern mit anderer Tabellenstruktur
        // (Tagesmittel/-max/-min statt 15-Min-Werte).
        case "/chiemsee/watertemp/history":
          return await handleChiemseeWaterTempHistory(request, env);

        // Additiv (auf Nutzerwunsch): DWD-Unwetterwarnungen für den
        // Landkreis Traunstein (Grassau liegt darin) -- über den
        // offiziellen ArcGIS-FeatureServer des DWD, gefiltert nach
        // Landkreis statt per Geometrie-Berechnung (einfacher, robuster).
        case "/warnings/traunstein":
          return await handleWeatherWarnings(request, env);

        // Additiv (auf Nutzerwunsch): DHV-Wettertext für die Nordalpen
        // (Gleitschirm/Drachen-Flugwetter, 2x täglich aktualisiert) --
        // reiner Textbericht, kein JSON, daher Auslesen der HTML-Seite.
        case "/dhv/nordalpen":
          return await handleDhvNordalpen(request, env);

        // Additiv (auf Nutzerwunsch): DWD-Segelflugwetterbericht für den
        // süddeutschen Alpenraum (3-Tages-Prognose der Luftfahrt-
        // beratungszentrale München) -- ebenfalls reiner Textbericht.
        case "/dwd/segelflugwetter":
          return await handleDwdSegelflugwetter(request, env);

        // Additiv: Flugradar-Proxy (A.L.V.I.N.html) -- leitet an die alte
        // aviradar-api serverseitig weiter, kein CORS-Risiko mehr.
        case "/flights/aircraft":
          return await handleFlightProxy(request, env, "/aircraft");

        case "/flights/route":
          return await handleFlightProxy(request, env, "/route");

        case "/flights/airline-logo":
          return await handleFlightProxy(request, env, "/airline-logo");

        // Additiv: Bestmögliche Identifikation (Land/Betreiber/Kategorie)
        // aus Rufzeichen-Mustern, Registrierungsformat und ICAO-Hexcode --
        // nötig für military-radar.html, wenn Typ/Registrierung fehlen
        // (bei Militärflugzeugen häufig, aus OPSEC-Gründen).
        case "/flights/identify":
          return await handleFlightProxy(request, env, "/identify");

        // Additiv: Server-seitiger Proxy für adsbexchange-Typ-Silhouetten
        // (military-radar.html) -- reine externe Domain, kein Service
        // Binding nötig wie bei /flights/*. Grund: adsbexchange.com sendet
        // vermutlich keine CORS-Header, wodurch der Browser weder das Bild
        // direkt per crossOrigin laden noch dessen Pixel auslesen kann
        // (siehe echter Testfall: blauer statt transparenter Hintergrund,
        // Farbton unbekannt). Der Worker holt das Bild stattdessen selbst
        // (kein CORS zwischen Servern) und reicht es mit eigenen,
        // freizügigen CORS-Headern weiter -- dann kann der Browser die
        // echten Pixel auslesen und den tatsächlichen Hintergrund erkennen,
        // egal welche Farbe es ist.
        case "/flights/silhouette":
          return await handleSilhouetteProxy(request);

        // Additiv: Lawinenlagebericht Bayern (Region Chiemgauer Alpen),
        // offizielle CAAML-XML-Quelle des Lawinenwarndienst Bayern,
        // geparst zu simplem JSON. Nur in der Wintersaison (ca. Dez-Apr)
        // mit echten Daten befüllt -- im Sommer liefert die Quelle 404,
        // was hier sauber abgefangen wird.
        case "/avalanche":
          return await handleAvalanche(request, env);

        // Additiv: Steuerungs-/Zeitplan-System, damit der Screenshot-
        // Workflow nicht mehr fest verdrahtet ist. /route entscheidet
        // bei jedem Lauf, welche Seite gerade dran ist.
        case "/route":
          return await handleGetRoute(request, env);

        case "/route/override":
          return await handleSetOverride(request, env);

        case "/route/schedule":
          return request.method === "POST"
            ? await handleSetSchedule(request, env)
            : await handleGetSchedule(request, env);

        // Additiv: Mehr-Display-Verwaltung.
        case "/displays":
          return request.method === "POST"
            ? await handleAddDisplay(request, env)
            : await handleGetDisplays(request, env);

        case "/displays/remove":
          return await handleRemoveDisplay(request, env);

        // Additiv: Standort für Flugradar-Seiten, serverseitig gespeichert.
        case "/location":
          return request.method === "POST" || url.searchParams.get("lat")
            ? await handleSetLocation(request, env)
            : await handleGetLocation(request, env);

        // Additiv: zentrale Seiten-Registry. Neue Seiten werden hier
        // einmal registriert (per control.html-Formular oder direkt per
        // Aufruf) -- control.html und index.html lesen diese Liste dann
        // automatisch, ohne dass Code angefasst werden muss.
        case "/channels":
          return request.method === "POST"
            ? await handleAddChannel(request, env)
            : await handleGetChannels(request, env);

        case "/channels/remove":
          return await handleRemoveChannel(request, env);

        case "/channels/reset":
          return await handleResetChannels(request, env);

        // Additiv: Trainings-Auswertung via intervals.icu
        // (nur Radfahren, eigene Daten).
        case "/training":
          return await handleTraining(request, env);

        case "/training/goal":
          return await handleTrainingGoal(request, env);

        // Pizza-Infografik nach einer neu erkannten Fahrt.
        case "/pizza":
          return await handlePizza(request, env);

        // Interessante-Flugzeuge-Alarm: /check von außen anstoßen
        // (z.B. alle 5 Min via cron-job.org), /flightalert liest nur
        // den zuletzt erkannten Zustand.
        case "/flightalert/check":
          return await handleFlightAlertCheck(request, env);

        case "/flightalert":
          return await handleFlightAlert(request, env);

        // Diagnose: zeigt die echten Feldnamen von intervals.icu.
        case "/training/debug":
          return await handleTrainingDebug(request, env);

        // Additiv: löst den GitHub-Actions-Workflow manuell aus (statt
        // auf den nächsten Cron-Lauf zu warten), für den "Jetzt
        // aktualisieren"-Button in control.html.
        case "/refresh":
          return await handleRefresh(request, env);

        default:
          return jsonResponse(
            {
              error: "Not found",
              endpoints: ["/paraglidable", "/holfuy", "/paragliders", "/flights/aircraft", "/flights/route", "/flights/airline-logo", "/flights/identify", "/flights/silhouette", "/avalanche", "/route", "/route/override", "/route/schedule", "/displays", "/displays/remove", "/location", "/channels", "/channels/remove", "/channels/reset", "/training", "/training/goal", "/pizza", "/flightalert", "/flightalert/check", "/training/debug", "/refresh", "/health"],
            },
            404,
            request
          );
      }
    } catch (error) {
      return jsonResponse(
        { error: "Internal worker error", detail: errorMessage(error) },
        500,
        request
      );
    }
  },

  /**
   * Cron trigger: einmal täglich.
   * Im Dashboard konfiguriert (Settings -> Triggers -> Cron Triggers),
   * z.B. "0 18 * * *".
   */
  async scheduled(controller, env, ctx) {
    // Läuft täglich mit: prüft alle angebundenen Dienste und schickt
    // bei Problemen eine ntfy.sh-Benachrichtigung.
    ctx.waitUntil(
      runHealthCheck(env)
        .then((result) => sendAlertIfUnhealthy(env, result))
        .catch((error) => {
          logEvent("healthcheck_run_failed", { error: errorMessage(error) });
        })
    );

    // Neue Radfahrten auch dann erkennen, wenn gerade niemand die
    // Trainingsseite aufruft -- sonst würde das Pizza-Fenster erst
    // beim nächsten manuellen Aufruf starten, nicht direkt nach der
    // Fahrt.
    ctx.waitUntil(
      fetchTrainingActivities(env)
        .then((acts) => checkForNewRide(env, acts))
        .catch((error) => logEvent("pizza_check_failed", { error: errorMessage(error) }))
    );
  },
};

/* =========================================================
   PARAGLIDABLE PROXY FOR R.U.D.I. -- WEATHER PAGE

   Additiv. Proxied api.paraglidable.com serverseitig, damit der
   Browser-Fetch nicht an CORS scheitert (paraglidable.com ist nicht
   zwingend für Cross-Origin-Requests von Drittseiten freigegeben).
   Der API-Key bleibt als Cloudflare-Secret serverseitig, taucht nie
   im öffentlichen HTML/JS auf.

   Benötigt: Secret PARAGLIDABLE_KEY (wrangler secret put PARAGLIDABLE_KEY)

   Example:
     GET /paraglidable
   ========================================================= */

/* =========================================================
   HOLFUY LIVE-WIND PROXY FOR R.U.D.I. -- WEATHER PAGE

   Additiv. Fragt die Holfuy-Live-API für die relevanten Startplätze ab
   und reicht sie CORS-sauber weiter. Key bleibt als Cloudflare-Secret
   serverseitig.

   Benötigt: Secret HOLFUY_KEY (im Cloudflare-Dashboard eintragen,
   sobald der Key von Holfuy per Mail da ist)

   Stationen (fest einprogrammiert, da sich das selten ändert):
     604  -- Hochfelln Süd (Startplatz)
     1868 -- Kössen Gipfel / Weststartplatz
     1869 -- Kössen Mittelstation

   Landeplatz (500) bewusst ausgelassen, laut Nutzerwunsch nicht
   benötigt.
   ========================================================= */

const HOLFUY_STATIONS = [
  { id: 604, label: "Hochfelln Süd" },
  { id: 1868, label: "Kössen Gipfel" },
  { id: 1266, label: "Wildkogel Bramberg" },
];

/* =========================================================
   FLUGRADAR-PROXY FÜR R.U.D.I. (A.L.V.I.N.html)

   Additiv. Leitet Anfragen serverseitig an aviradar-api.marvinradar.
   workers.dev weiter, statt dass der Browser die alte API direkt
   cross-origin anspricht -- damit spielt es keine Rolle, welche
   Origin die alte API erlaubt (die Anfrage kommt ja von unserem
   Worker, nicht mehr vom Browser des Nutzers).
   ========================================================= */

const AVIRADAR_API = "https://aviradar-api.marvinradar.workers.dev";

const SILHOUETTE_TYPE_PATTERN = /^[A-Z0-9]{1,8}$/;

async function handleSilhouetteProxy(request) {
  const url = new URL(request.url);
  const type = (url.searchParams.get("type") || "").toUpperCase().trim();

  // Nur bekannt harmlose Zeichen zulassen (Typ-Codes sind immer
  // Buchstaben/Ziffern) -- verhindert, dass dieser Proxy für beliebige
  // fremde URLs missbraucht werden könnte.
  if (!SILHOUETTE_TYPE_PATTERN.test(type)) {
    return new Response("Invalid type", { status: 400 });
  }

  try {
    const upstream = await fetch(`https://globe.adsbexchange.com/aircraft_sil/${type}.png`, {
      headers: { Accept: "image/png,image/*" },
    });

    if (!upstream.ok) {
      return new Response("Not found", { status: 404 });
    }

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "image/png",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    return new Response("Upstream error", { status: 502 });
  }
}

async function handleFlightProxy(request, env, subpath) {
  const url = new URL(request.url);
  const target = `${AVIRADAR_API}${subpath}${url.search}`;

  // WICHTIG: normales fetch() auf eine andere .workers.dev-URL im
  // selben Account löst Cloudflare-Fehler 1042 aus (Worker-zu-Worker-
  // Aufrufe über die öffentliche URL sind aus Sicherheitsgründen
  // blockiert). Das Service Binding (env.AVIRADAR_API_BINDING) umgeht
  // das -- muss einmalig im Cloudflare-Dashboard eingerichtet werden
  // (Settings -> Bindings -> Add -> Service binding).
  if (!env.AVIRADAR_API_BINDING) {
    return jsonResponse(
      {
        error: "AVIRADAR_API_BINDING ist nicht konfiguriert",
        hint: "Im Cloudflare-Dashboard: rudi-Worker -> Settings -> Bindings -> Add -> Service binding -> Ziel-Worker: aviradar-api",
      },
      503,
      request
    );
  }

  try {
    const response = await env.AVIRADAR_API_BINDING.fetch(
      new Request(target, {
        headers: { Accept: "application/json, image/*" },
      })
    );

    // arrayBuffer statt text() -- text() beschädigt Binärdaten (z.B.
    // PNG/JPEG bei /airline-logo). arrayBuffer gibt die Bytes 1:1
    // weiter, egal ob JSON oder Bild.
    let body = await response.arrayBuffer();
    const headers = new Headers();
    headers.set("Content-Type", response.headers.get("Content-Type") || "application/json; charset=utf-8");
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("Cache-Control", "no-store");

    // WICHTIG (Fix 04.09.2026, auf Nutzerwunsch, nach doppelter
    // Listenpflege-Warnung): Statt die Widebody-/Airline-/Flying-Bulls-
    // Listen ZUSÄTZLICH in jeder Frontend-Seite zu duplizieren (Risiko:
    // laufen mit der Zeit auseinander), reichert der Proxy hier JEDES
    // Flugzeug einmalig mit isSpecial/specialReason an -- dieselbe
    // Funktion (classifyInterestingAircraft), die auch der Flugzeug-
    // Alarm nutzt. Frontend-Seiten fragen nur noch das fertige Ergebnis
    // ab, kennen die Kriterien selbst nicht mehr. Nur für /aircraft
    // relevant, bei allen anderen Pfaden (/route, /identify, /airline-
    // logo, Bilder) unverändert durchgereicht.
    if (subpath === "/aircraft" && response.ok) {
      try {
        const data = JSON.parse(new TextDecoder().decode(body));
        if (Array.isArray(data.ac)) {
          data.ac = data.ac.map((ac) => {
            const reason = classifyInterestingAircraft(ac);
            return reason ? { ...ac, isSpecial: true, specialReason: reason } : ac;
          });
        }
        body = new TextEncoder().encode(JSON.stringify(data));
      } catch (error) {
        // Parsen fehlgeschlagen (unerwartetes Format o.ä.) -- lieber die
        // ursprünglichen, unangereicherten Bytes ausliefern als gar
        // nichts. isSpecial fehlt dann einfach, kein harter Fehler.
        logEvent("aircraft_enrichment_failed", { error: errorMessage(error) });
      }
    }

    // WICHTIG (Fix 04.09.2026): den echten Datenzeitstempel vom
    // aviradar-api-Worker durchreichen, statt ihn stillschweigend zu
    // verwerfen -- ohne das zeigten die Seiten immer "wann hat der
    // Browser gerade abgefragt" statt "wann sind die Daten wirklich von"
    // (seit dem D1-lenient-Fix vom selben Tag können Daten bis zu einer
    // Stunde alt sein, das muss sichtbar sein).
    const fetchedAt = response.headers.get("X-MARVIN-Fetched-At");
    if (fetchedAt) headers.set("X-MARVIN-Fetched-At", fetchedAt);
    const dataAge = response.headers.get("X-MARVIN-Data-Age-Seconds");
    if (dataAge) headers.set("X-MARVIN-Data-Age-Seconds", dataAge);

    return new Response(body, { status: response.status, headers });
  } catch (error) {
    return jsonResponse(
      { error: "Flugradar-API nicht erreichbar", detail: errorMessage(error) },
      502,
      request
    );
  }
}

/* =========================================================
   GLEITSCHIRM-LIVE-TRACKING FÜR R.U.D.I. (paragliders-live.html)

   Additiv. Fragt das Open Glider Network (OGN) ab -- ein kostenloses,
   offenes Tracking-Netzwerk, das u.a. FANET-Signale empfängt (das
   Protokoll, das die meisten modernen Gleitschirm-Varios wie
   Skytraxx, XCTrack, Flymaster nutzen).

   Quelle: live.glidernet.org/lxml.php (offizielle OGN-API, XML)

   VERIFIZIERT (25.08.2026) an echten Live-Daten genau aus dieser
   Region -- ein Pilot exakt am Wildkogel-Startplatz (einer unserer
   Holfuy-Stationen) mit Typ-Code 7 (Gleitschirm), plausibler Höhe
   (2075m) und plausibler Steigrate (+1.4 m/s):
     47.406620,12.241720,...,2075,...,7,Wildkogel,...

   Feld-Reihenfolge im "a"-Attribut (Komma-getrennt), soweit
   verifiziert:
     0: Breitengrad
     1: Längengrad
     2: Kürzel/Wettbewerbsnummer
     3: Geräte-ID/Registrierung
     4: Höhe in Metern         -- VERIFIZIERT
     5: Uhrzeit (HH:MM:SS)
     6: unklar (evtl. Kurs*10 o.ä.)
     7: unklar (evtl. Geschwindigkeit)
     8: unklar (evtl. Richtung)
     9: Steigrate in m/s        -- VERIFIZIERT
     10: Flugzeugtyp-Code       -- VERIFIZIERT (7 = Gleitschirm)
     11: Empfangsstation (Name)

   EHRLICHER VORBEHALT: Bei einigen Trackern (u.a. mehrere an
   bekannten Gleitschirm-Startplätzen wie Kitzbühel) wurden Typ-Codes
   wie 23 statt 7 beobachtet -- vermutlich ein zusätzliches Flag
   (z.B. "stealth mode", laut OGN-Protokoll-Doku ein Bit im selben
   Byte). Der Filter unten prüft deshalb (typCode % 16 === 7), um
   auch solche Fälle zu erfassen -- nie an genug Fällen verifiziert,
   um das mit Sicherheit auszuschließen.

   Startplatz-Koordinaten unten: Wildkogel exakt aus echten Live-Daten
   übernommen. Hochfelln und Kössen sind Schätzungen nach bestem
   geografischen Wissen, NICHT einzeln verifiziert -- falls sie auf
   der Karte spürbar falsch liegen, bitte melden.
   ========================================================= */

// Exakt vom Nutzer vorgegeben: 47°46'32.3"N 12°27'18.7"E
const GRASSAU_CENTER = { lat: 47.7756389, lon: 12.4551944, label: "Grassau" };
const PARAGLIDER_RADIUS_KM = 15;

// Nur die nächsten 10 Piloten anzeigen (Liste bliebe sonst bei viel
// Flugbetrieb unübersichtlich).
const MAX_PILOTS_SHOWN = 10;

// WICHTIG (Fix 27.08.2026, nach Nutzer-Meldung "Piloten auf OGN
// sichtbar, aber nicht bei uns"): Die vorherige Höhen-Heuristik
// (MIN_AIRBORNE_ALTITUDE_M) hat echte, aber niedrig fliegende Piloten
// fälschlich rausgefiltert -- z.B. kurz nach dem Start. Ersetzt durch
// eine Geschwindigkeits-Schwelle, die deutlich zuverlässiger zwischen
// "fliegt" und "steht/liegt im Auto" unterscheidet.
//
// EHRLICHER HINWEIS zur Feldbedeutung: Der offizielle OGN-Server-Code
// ist laut deren eigenem GitHub "not yet public" -- keine offizielle
// Doku für die genaue Feldreihenfolge gefunden. Die Zuordnung "Feld 7
// = Geschwindigkeit in km/h" stützt sich auf den Abgleich beider
// echten Beispieldatensätze, die wir haben: ein geparktes Flugzeug in
// Löchgau zeigt dort exakt 0, ein fliegendes bei Moosburg zeigt 103
// (plausibel für ein Fluggerät in der Luft). Nicht offiziell
// bestätigt -- falls sich nach dem Live-Test zeigt, dass das nicht
// stimmt, muss hier nachjustiert werden.
const MIN_AIRBORNE_SPEED_KMH = 8;

// Nur Datensätze, deren eigene Zeitangabe wirklich frisch ist --
// siehe ausführlichen Hinweis in parseOgnMarkers().
const MAX_AGE_SECONDS = 10 * 60;

// Koordinaten VERIFIZIERT (25.08.2026, geofinder.ch bzw. Wikipedia für
// Unterberghorn/Kössen) -- keine Schätzungen mehr.
const KNOWN_LAUNCH_SITES = [
  { name: "Hochfelln", lat: 47.762418, lon: 12.559310 },
  { name: "Kössen", lat: 47.620560, lon: 12.436110 },
  { name: "Wildkogel", lat: 47.406620, lon: 12.241720 },
  { name: "Hochplatte", lat: 47.750874, lon: 12.404959 },
  { name: "Kampenwand", lat: 47.755811, lon: 12.367497 },
  { name: "Hochgern", lat: 47.750351, lon: 12.515429 },
  { name: "Geigelstein", lat: 47.707740, lon: 12.334315 },
];

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function parseOgnMarkers(xml) {
  const rows = [];
  const matches = xml.match(/<m a="[^"]*"\/>/g) || [];

  // WICHTIG (Fix 27.08.2026, verifiziert per Debug-Vergleich: Server-
  // Zeit 10:16 UTC vs. OGN-Zeitstempel 12:16 -- exakt 2h Differenz):
  // OGN gibt die Uhrzeit in mitteleuropäischer Zeit (CEST/CET) an,
  // NICHT in UTC wie ursprünglich angenommen. Vorher wurde "jetzt" in
  // UTC berechnet, wodurch alle Datensätze fälschlich als "aus der
  // Zukunft" erschienen und über die Sicherheitsprüfung unten (< -60s)
  // rausgeworfen wurden -- das war der eigentliche Grund für "keine
  // Piloten trotz sichtbarer Aktivität". Jetzt korrekt in Berlin-Zeit
  // berechnet, wie an anderen Stellen im Projekt auch schon (siehe
  // Screenshot-Zeitstempel-Fix von früher).
  const berlinNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const nowUtcSeconds =
    berlinNow.getHours() * 3600 + berlinNow.getMinutes() * 60 + berlinNow.getSeconds();

  for (const raw of matches) {
    const attr = raw.match(/a="([^"]*)"/);
    if (!attr) continue;

    const parts = attr[1].split(",");
    if (parts.length < 11) continue;

    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    const altitude = Number(parts[4]);
    const speedKmh = Number(parts[7]);
    const climbRate = Number(parts[9]);
    const typeCode = parseInt(parts[10], 10);
    const timeStr = parts[5] || "";

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Siehe Kommentar oben -- erfasst Typ 7 direkt und mit Flag-Bit (23).
    if (Number.isNaN(typeCode) || typeCode % 16 !== 7) continue;

    // WICHTIG (Fix 26.08.2026, nach Nutzer-Meldung: Piloten wurden
    // angezeigt, obwohl abends um 20 Uhr nachweislich niemand mehr in
    // der Luft war): OGN's eigenes "online/offline"-Flag (Parameter
    // "a") ist offenbar großzügiger als gedacht -- vermutlich eine
    // mehrstündige statt eine minütliche Karenzzeit. Verlässlicher:
    // die Zeitangabe in JEDEM Datensatz selbst prüfen (Feld 5, bereits
    // verifiziert) und alles verwerfen, was nicht wirklich frisch ist.
    const timeMatch = timeStr.match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (!timeMatch) continue;

    const recordSeconds = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
    let ageSeconds = nowUtcSeconds - recordSeconds;
    if (ageSeconds < -3600) ageSeconds += 86400; // Mitternacht-Wrap (Zeit ist UTC, ohne Datum)

    if (ageSeconds > MAX_AGE_SECONDS || ageSeconds < -60) continue;

    rows.push({
      lat,
      lon,
      callsign: parts[2] || parts[3] || "?",
      altitude: Number.isFinite(altitude) ? Math.round(altitude) : null,
      speedKmh: Number.isFinite(speedKmh) ? Math.round(speedKmh) : null,
      climbRate: Number.isFinite(climbRate) ? climbRate : null,
      receiver: parts[11] || null,
      ageSeconds,
    });
  }

  return rows;
}

/**
 * Liest die aktuelle Wassertemperatur der offiziellen bayerischen
 * Messstation "Stock / Chiemsee" (Gewässerkundlicher Dienst Bayern)
 * aus -- die Seite bietet keine JSON-API, nur eine HTML-Tabelle, daher
 * wird hier der jüngste Messwert per Regex herausgelesen. 30 Minuten
 * Edge-Cache, damit die Behördenseite nicht bei jedem Seitenaufruf neu
 * belastet wird (Messwerte ändern sich ohnehin nur alle 15 Min).
 * WICHTIG: fragiler als eine echte API -- bricht, falls die Behörde
 * die Seitenstruktur ändert. Bei Fehlschlag liefert die Funktion einen
 * klaren Fehler statt eines falschen Werts.
 */
/**
 * Liest aktuelle DWD-Unwetterwarnungen für den Landkreis Traunstein
 * (Grassau liegt darin) über den offiziellen ArcGIS-FeatureServer des
 * DWD aus. Filtert per Attribut (NAME_kreis) statt per Geometrie --
 * einfacher als Punkt-in-Polygon-Berechnung, auf Landkreis-Ebene
 * genau genug für unseren Zweck. 15 Minuten Edge-Cache (der Dienst
 * selbst aktualisiert laut eigener Doku alle 30 Minuten).
 * WICHTIG: noch nicht live gegen die echte API getestet (nur
 * Dokumentation/Schema geprüft) -- erster echter Test steht nach
 * Deploy noch aus.
 */
/**
 * Wandelt HTML in lesbaren Klartext um -- für Textberichte (DHV, DWD),
 * bei denen wir den eigentlichen Fließtext brauchen, nicht einzelne
 * Werte. Grob, aber für Fließtext-Extraktion ausreichend.
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö").replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö").replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Liest den DHV-Wettertext für die Nordalpen aus (Gleitschirm/Drachen-
 * Flugwetter, 2x täglich aktualisiert: morgens 7-8h, abends 18-19h).
 * Reiner Fließtext, kein JSON -- Extraktion zwischen der "Nordalpen"-
 * und der nächsten ("Südalpen"-)Überschrift. 3 Stunden Edge-Cache,
 * passend zur Aktualisierungsrate der Quelle.
 */
async function handleDhvNordalpen(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(`${new URL(request.url).origin}/__rudi_cache/dhv-nordalpen`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://www.dhv.de/wetter/dhv-wetter/", {
      headers: { "User-Agent": "R.U.D.I.-Dashboard/1.0", Accept: "text/html" }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DHV returned HTTP ${response.status}`);
    const text = htmlToText(await response.text());

    const startIdx = text.indexOf("Nordalpen");
    const endIdx = text.indexOf("Südalpen", startIdx);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) throw new Error("Could not locate Nordalpen section");
    const nordalpenText = text.slice(startIdx + "Nordalpen".length, endIdx).trim();

    const standMatch = text.match(/Stand:\s*([^\n]+)/);
    const nextMatch = text.match(/Nächste Aktualisierung:\s*([^\n]+)/);

    // WICHTIG (auf Nutzerwunsch): strukturierte Tag-für-Tag-Auswertung
    // statt nur rohen Text -- jeder Tagesblock folgt bei DHV einem
    // festen Muster (Wochentag. Datum: Kurztitel, dann Beschreibung,
    // dann "Thermik:"-Zeile, dann "Wind:"-Zeile). Nicht jeder Tag
    // folgt dem Muster exakt (z.B. bei Sonderlagen ohne Thermik-Zeile)
    // -- dann fehlt der Tag einfach in "days", der Rohtext bleibt aber
    // immer als Fallback erhalten.
    const dayPattern = /(Mo|Di|Mi|Do|Fr|Sa|So)\.\s+(\d{2}\.\d{2}\.\d{4}):\s*([^\n]+)\n\n([\s\S]*?)(?:Thermik:\s*([^\n]+)\n)?Wind:\s*([^\n]+)/g;
    const days = [];
    let dayMatch;
    while ((dayMatch = dayPattern.exec(nordalpenText)) !== null) {
      const [, weekday, date, headline, descriptionRaw, thermik, wind] = dayMatch;
      days.push({
        weekday, date, headline: headline.trim(),
        description: descriptionRaw.trim().split("\n")[0].trim(),
        thermik: thermik ? thermik.trim() : null,
        wind: wind.trim(),
      });
    }

    const payload = {
      region: "Nordalpen",
      text: nordalpenText,
      days,
      stand: standMatch ? standMatch[1].trim() : null,
      naechsteAktualisierung: nextMatch ? nextMatch[1].trim() : null,
      source: "DHV (Deutscher Gleitschirm- und Drachenflugverband)",
      sourceUrl: "https://www.dhv.de/wetter/dhv-wetter/",
    };

    const result = jsonResponse(payload, 200, request, { "Cache-Control": "public, max-age=10800" });
    await cache.put(cacheKey, result.clone());
    return result;
  } catch (error) {
    logEvent("dhv_nordalpen_failed", { error: errorMessage(error) });
    return jsonResponse({ error: "DHV Nordalpen text unavailable", detail: errorMessage(error) }, 502, request);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Liest den DWD-Segelflugwetterbericht für Süddeutschland/Alpen aus
 * (3-Tages-Prognose der Luftfahrtberatungszentrale München, GAFOR-
 * Gebiete 71-84). Reiner Fließtext. 6 Stunden Edge-Cache (Quelle wird
 * laut DWD einmal täglich aktualisiert).
 */
async function handleDwdSegelflugwetter(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(`${new URL(request.url).origin}/__rudi_cache/dwd-segelflugwetter`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbdl60_edzm_node.html", {
      headers: { "User-Agent": "R.U.D.I.-Dashboard/1.0", Accept: "text/html" }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DWD returned HTTP ${response.status}`);
    const text = htmlToText(await response.text());

    // Anker: Berichtstext beginnt bei "3-Tage-Prognose für Sichtflug",
    // endet meist bei der Unterschriftszeile ("Flugwetterzentrale"/
    // "Luftfahrtberatungszentrale ... /Hr" bzw. "/Fr"). Grosszügiger
    // Fallback auf feste Länge, falls die Endmarke nicht gefunden wird.
    const startIdx = text.indexOf("3-Tage-Prognose für Sichtflug");
    if (startIdx === -1) throw new Error("Could not locate Segelflugwetter report start");
    const afterStart = text.slice(startIdx);
    const endMatch = afterStart.match(/(Luftfahrtberatungszentrale|Flugwetterzentrale)[^\n]*\/(Hr|Fr)\.?/);
    const reportText = endMatch
      ? afterStart.slice(0, endMatch.index + endMatch[0].length).trim()
      : afterStart.slice(0, 4000).trim();

    const payload = {
      region: "Süddeutschland / Alpen (LBZ München)",
      text: reportText,
      source: "DWD (Deutscher Wetterdienst)",
      sourceUrl: "https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbdl60_edzm_node.html",
    };

    const result = jsonResponse(payload, 200, request, { "Cache-Control": "public, max-age=21600" });
    await cache.put(cacheKey, result.clone());
    return result;
  } catch (error) {
    logEvent("dwd_segelflugwetter_failed", { error: errorMessage(error) });
    return jsonResponse({ error: "DWD Segelflugwetter text unavailable", detail: errorMessage(error) }, 502, request);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleWeatherWarnings(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/warnings-traunstein`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const queryUrl = new URL("https://services2.arcgis.com/jUpNdisbWqRpMo35/ArcGIS/rest/services/aea519/FeatureServer/1/query");
    queryUrl.searchParams.set("where", "NAME_kreis='Traunstein'");
    queryUrl.searchParams.set("outFields", "EVENT,HEADLINE,DESCRIPTION,INSTRUCTION,SEVERITY,ONSET,EXPIRES,NAME_kreis");
    queryUrl.searchParams.set("returnGeometry", "false");
    queryUrl.searchParams.set("f", "json");

    const response = await fetch(queryUrl.toString(), {
      headers: { Accept: "application/json" }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DWD ArcGIS returned HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error(`DWD ArcGIS error: ${data.error.message || "unknown"}`);

    const features = Array.isArray(data.features) ? data.features : [];
    const warnings = features
      .map((f) => f.attributes)
      .filter((a) => a && a.EVENT) // Leere Kreisumriss-Einträge ohne aktive Warnung überspringen
      .map((a) => ({
        event: a.EVENT,
        headline: a.HEADLINE,
        description: a.DESCRIPTION,
        instruction: a.INSTRUCTION,
        severity: a.SEVERITY,
        onset: a.ONSET,
        expires: a.EXPIRES,
      }));

    const payload = { kreis: "Traunstein", warnings, count: warnings.length };
    const result = jsonResponse(payload, 200, request, { "Cache-Control": "public, max-age=900" });
    await cache.put(cacheKey, result.clone());
    return result;
  } catch (error) {
    logEvent("weather_warnings_failed", { error: errorMessage(error) });
    return jsonResponse({ error: "Weather warnings unavailable", detail: errorMessage(error) }, 502, request);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleChiemseeWaterTemp(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/chiemsee-watertemp`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      "https://www.gkd.bayern.de/de/seen/wassertemperatur/inn/stock-18400503/messwerte",
      { headers: { "User-Agent": "R.U.D.I.-Dashboard/1.0", Accept: "text/html" }, signal: controller.signal }
    );
    if (!response.ok) throw new Error(`GKD Bayern returned HTTP ${response.status}`);
    const html = await response.text();

    // Sucht ALLE Datum+Uhrzeit+Wert-Kombinationen (nicht nur die erste)
    // für einen Verlauf, nicht nur den aktuellsten Messwert. "g"-Flag
    // + matchAll statt einzelnem match().
    const rowPattern = /(\d{2}\.\d{2}\.\d{4})\s*(\d{2}:\d{2})\s*Uhr[\s\S]{1,200}?(\d{1,2},\d)/g;
    const matches = [...html.matchAll(rowPattern)];
    if (!matches.length) throw new Error("Could not find water temperature value in page");

    const readings = matches.map((m) => {
      const [, dateStr, timeStr, tempStr] = m;
      return { measuredAt: `${dateStr} ${timeStr}`, temperatureC: Number(tempStr.replace(",", ".")) };
    }).filter((r) => Number.isFinite(r.temperatureC));

    if (!readings.length) throw new Error("Parsed temperature values are not valid numbers");

    // Seite listet neueste zuerst -- für einen Verlaufsgraph
    // chronologisch (älteste zuerst) sinnvoller. Auf die letzten 24
    // Werte begrenzt (bei 15-Min-Takt der Station ~6 Stunden).
    const history = readings.slice(0, 24).reverse();
    const latest = readings[0];

    const payload = {
      station: "Stock / Chiemsee",
      temperatureC: latest.temperatureC,
      measuredAt: latest.measuredAt,
      history,
      source: "Gewässerkundlicher Dienst Bayern",
      sourceUrl: "https://www.gkd.bayern.de/de/seen/wassertemperatur/inn/stock-18400503/messwerte",
    };

    const result = jsonResponse(payload, 200, request, { "Cache-Control": "public, max-age=1800" });
    await cache.put(cacheKey, result.clone());
    return result;
  } catch (error) {
    logEvent("chiemsee_watertemp_failed", { error: errorMessage(error) });
    return jsonResponse({ error: "Water temperature unavailable", detail: errorMessage(error) }, 502, request);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Liest Tageswerte der Chiemsee-Wassertemperatur seit 1. Januar aus
 * der "Jahresgrafik"-Unterseite (andere Tabellenstruktur als die
 * 15-Minuten-Werte: Datum + Tagesmittel + Tagesmaximum + Tagesminimum).
 * Für einen Monate-/Saison-Trend statt nur der letzten paar Stunden.
 * 6 Stunden Edge-Cache -- Tageswerte ändern sich ohnehin nur einmal
 * täglich.
 */
async function handleChiemseeWaterTempHistory(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/chiemsee-watertemp-history`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(
      "https://www.gkd.bayern.de/de/seen/wassertemperatur/inn/stock-18400503/jahreswerte",
      { headers: { "User-Agent": "R.U.D.I.-Dashboard/1.0", Accept: "text/html" }, signal: controller.signal }
    );
    if (!response.ok) throw new Error(`GKD Bayern returned HTTP ${response.status}`);
    const html = await response.text();

    // Zeilenformat: Datum, Mittelwert, Maximum, Minimum -- alle als
    // deutsche Kommazahlen, mit beliebigen HTML-Tags dazwischen.
    const rowPattern = /(\d{2}\.\d{2}\.\d{4})[\s\S]{1,100}?(\d{1,2},\d)[\s\S]{1,60}?(\d{1,2},\d)[\s\S]{1,60}?(\d{1,2},\d)/g;
    const matches = [...html.matchAll(rowPattern)];
    if (!matches.length) throw new Error("Could not find water temperature history in page");

    const readings = matches.map((m) => ({
      date: m[1],
      meanC: Number(m[2].replace(",", ".")),
      maxC: Number(m[3].replace(",", ".")),
      minC: Number(m[4].replace(",", ".")),
    })).filter((r) => Number.isFinite(r.meanC));

    if (!readings.length) throw new Error("Parsed temperature history values are not valid numbers");

    // Seite listet neueste zuerst -- für einen Verlaufsgraph
    // chronologisch sinnvoller (älteste zuerst).
    const history = readings.reverse();

    const payload = {
      station: "Stock / Chiemsee",
      history,
      source: "Gewässerkundlicher Dienst Bayern",
      sourceUrl: "https://www.gkd.bayern.de/de/seen/wassertemperatur/inn/stock-18400503/jahreswerte",
    };

    const result = jsonResponse(payload, 200, request, { "Cache-Control": "public, max-age=21600" });
    await cache.put(cacheKey, result.clone());
    return result;
  } catch (error) {
    logEvent("chiemsee_watertemp_history_failed", { error: errorMessage(error) });
    return jsonResponse({ error: "Water temperature history unavailable", detail: errorMessage(error) }, 502, request);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleParagliders(request, env) {
  const debug = new URL(request.url).searchParams.get("debug") === "1";

  const latDelta = PARAGLIDER_RADIUS_KM / 111;
  const lonDelta = PARAGLIDER_RADIUS_KM / (111 * Math.cos((GRASSAU_CENTER.lat * Math.PI) / 180));

  const latMax = GRASSAU_CENTER.lat + latDelta;
  const latMin = GRASSAU_CENTER.lat - latDelta;
  const lonMax = GRASSAU_CENTER.lon + lonDelta;
  const lonMin = GRASSAU_CENTER.lon - lonDelta;

  // WICHTIG (Fix 25.08.2026, nach Nutzer-Meldung "sehe die Piloten
  // nicht auf live.glidernet.org"): a=0 statt a=1 -- der Parameter "a"
  // steuert laut OGN-API-Doku, ob auch OFFLINE-Tracker mitgeliefert
  // werden. Mit a=1 zeigten wir vermutlich veraltete/nicht mehr aktive
  // Tracker, die die echte Live-Karte korrekt ausblendet.
  const url = `http://live.glidernet.org/lxml.php?a=0&b=${latMax}&c=${latMin}&d=${lonMax}&e=${lonMin}&z=2`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`OGN HTTP ${response.status}`);
    }

    const xml = await response.text();

    // Diagnose-Zahlen VOR jeder eigenen Filterung -- damit sichtbar
    // wird, ob OGN selbst schon nichts liefert (dann ist's a=0 oder
    // die Bounding Box) oder ob unsere eigenen Filter (Typ/Frische/
    // Geschwindigkeit) zu viel aussieben.
    const rawMarkerCount = (xml.match(/<m a="[^"]*"\/>/g) || []).length;
    const paragliderCandidates = (xml.match(/<m a="[^"]*"\/>/g) || [])
      .map((raw) => {
        const attr = raw.match(/a="([^"]*)"/);
        if (!attr) return null;
        const parts = attr[1].split(",");
        const typeCode = parseInt(parts[10], 10);
        if (Number.isNaN(typeCode) || typeCode % 16 !== 7) return null;
        return {
          timeStr: parts[5] || null,
          speedRaw: parts[7] || null,
          altitude: parts[4] || null,
        };
      })
      .filter(Boolean);

    const parsed = parseOgnMarkers(xml);

    const pilots = parsed
      // Nochmal hart auf den Radius filtern -- die Bounding Box ist ein
      // Rechteck, das an den Ecken über den eigentlichen Kreis hinausragt.
      .map((p) => ({
        ...p,
        distanceKm: Math.round(haversineKm(GRASSAU_CENTER.lat, GRASSAU_CENTER.lon, p.lat, p.lon) * 10) / 10,
        bearingDeg: Math.round(bearingDeg(GRASSAU_CENTER.lat, GRASSAU_CENTER.lon, p.lat, p.lon)),
      }))
      .filter((p) => p.distanceKm <= PARAGLIDER_RADIUS_KM)
      // "Am Boden" rausfiltern: über Geschwindigkeit statt Höhe (siehe
      // ausführlicher Hinweis bei MIN_AIRBORNE_SPEED_KMH oben) -- ein
      // geparkter/liegender Tracker zeigt ~0 km/h, ein tatsächlich
      // fliegender Gleitschirm so gut wie nie, selbst kurz nach dem
      // Start. speedKmh == null (Feld fehlt/unklar) wird NICHT
      // ausgeschlossen, um bei fehlendem Wert nicht versehentlich
      // echte Piloten rauszuwerfen.
      .filter((p) => p.speedKmh == null || p.speedKmh >= MIN_AIRBORNE_SPEED_KMH)
      // Nächste zuerst (nicht mehr nach Höhe sortiert), dann auf die
      // angefragten Top 10 begrenzen.
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, MAX_PILOTS_SHOWN);

    return jsonResponse(
      {
        center: GRASSAU_CENTER,
        radiusKm: PARAGLIDER_RADIUS_KM,
        launchSites: KNOWN_LAUNCH_SITES,
        pilots,
        fetchedAt: new Date().toISOString(),
        ...(debug && {
          debug: {
            rawMarkerCountFromOgn: rawMarkerCount,
            afterTypeCodeFilter: paragliderCandidates.length,
            paragliderCandidateRawValues: paragliderCandidates,
            currentServerTimeUtc: new Date().toISOString(),
            afterAllOwnFilters_beforeRadius: parsed.length,
            afterRadiusFilter: pilots.length,
            queryUrl: url,
          },
        }),
      },
      200,
      request
    );
  } catch (error) {
    return jsonResponse(
      { error: "OGN nicht erreichbar", detail: errorMessage(error) },
      502,
      request
    );
  }
}

async function handleHolfuy(request, env) {
  if (!env.HOLFUY_KEY) {
    return jsonResponse(
      { error: "HOLFUY_KEY is not configured" },
      503,
      request
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/holfuy`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const results = await Promise.all(
    HOLFUY_STATIONS.map(async (station) => {
      try {
        const url = `https://api.holfuy.com/live/?s=${station.id}&pw=${env.HOLFUY_KEY}&m=JSON&tu=C&su=km%2Fh`;
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          return { ...station, error: `HTTP ${response.status}` };
        }

        const data = await response.json();
        return {
          ...station,
          wind: data.wind?.speed ?? null,
          gust: data.wind?.gust ?? null,
          direction: data.wind?.direction ?? null,
          temperature: data.temperature ?? null,
          dateTime: data.dateTime ?? null,
        };
      } catch (error) {
        return { ...station, error: errorMessage(error) };
      }
    })
  );

  const payload = { stations: results, fetchedAt: new Date().toISOString() };

  const cacheResponse = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Holfuy-Stationen senden minütlich -- 60s Cache reicht, schont
      // aber unnötige Mehrfachabrufe bei mehreren Seitenaufrufen.
      "Cache-Control": "public, max-age=60",
    },
  });

  await cache.put(cacheKey, cacheResponse.clone());

  const headers = new Headers(cacheResponse.headers);
  Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
  headers.set("X-RUDI-Cache", "MISS");

  return new Response(cacheResponse.body, { status: 200, headers });
}

/* =========================================================
   LAWINENLAGEBERICHT BAYERN (CAAML) FOR R.U.D.I. -- SNOW PAGE

   Additiv. Holt den offiziellen CAAML-XML-Lagebericht des
   Lawinenwarndienst Bayern und extrahiert die Gefahrenstufe für die
   Region "Chiemgauer Alpen" (bzw. Ost/West, falls die Region seit der
   10er-Unterteilung getrennt geführt wird).

   Quelle: https://static.lawinen-warnung.eu/bulletins/latest/DE-BY_de.xml
   (offiziell verlinkt von lawinenwarndienst.bayern.de/presse/)

   WICHTIG -- ehrlicher Hinweis: Nur in der Wintersaison (ca. Dezember
   bis April) mit echten Daten befüllt. Außerhalb der Saison liefert
   die Quelle 404 -- das wird hier sauber als "keine aktuelle
   Warnung/Saison beendet" behandelt, nicht als Fehler.

   Der genaue Regionsname/-code in der XML-Datei wurde nie live
   verifiziert (Quelle war beim Bau dieses Codes 404, außerhalb der
   Saison) -- die Suchbegriffe unten ("Chiemgau") sind ein plausibler
   Best-Guess nach dem CAAML/EAWS-Standard, sollten aber beim ersten
   Live-Test in der nächsten Wintersaison verifiziert werden.
   ========================================================= */

const AVALANCHE_SOURCE_URL = "https://static.lawinen-warnung.eu/bulletins/latest/DE-BY_de.xml";
// Exakte Regionsnamen (kein vages Pattern) -- Bayern hat "Chiemgauer
// Alpen" seit der 10er-Unterteilung in West/Ost getrennt. Zuordnung
// nach bestem geografischem Wissen, aber OHNE verifizierte Grenzkarte:
//   West: Hochfelln, Kampenwand (Achental, eindeutig Richtung Inntal)
//   Ost:  Winklmoos-Steinplatte, Unternberg -- geografisch weiter
//         östlich, Zuordnung zu West/Ost hier NICHT verifiziert.
const AVALANCHE_REGIONS = {
  west: /Chiemgauer\s+Alpen\s+West/i,
  ost: /Chiemgauer\s+Alpen\s+Ost/i,
};

async function handleAvalanche(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/avalanche`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  let payload;

  try {
    const response = await fetch(AVALANCHE_SOURCE_URL, {
      headers: { Accept: "application/xml" },
    });

    if (response.status === 404) {
      // Außerhalb der Wintersaison -- kein Fehler, einfach keine
      // aktuelle Warnung verfügbar.
      payload = {
        available: false,
        reason: "Keine aktuelle Ausgabe (vermutlich außerhalb der Wintersaison)",
        region: "Chiemgauer Alpen",
      };
    } else if (!response.ok) {
      payload = { available: false, reason: `HTTP ${response.status}`, region: "Chiemgauer Alpen" };
    } else {
      const xml = await response.text();
      payload = parseAvalancheCaaml(xml);
    }
  } catch (error) {
    payload = { available: false, reason: errorMessage(error), region: "Chiemgauer Alpen" };
  }

  const cacheResponse = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Lagebericht wird max. 1-2x täglich aktualisiert -- 30 Min Cache
      "Cache-Control": "public, max-age=1800",
    },
  });

  await cache.put(cacheKey, cacheResponse.clone());

  const headers = new Headers(cacheResponse.headers);
  Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
  headers.set("X-RUDI-Cache", "MISS");

  return new Response(cacheResponse.body, { status: 200, headers });
}

/**
 * Simpler Regex-basierter CAAML-Parser (kein volles XML-DOM im Worker
 * nötig). Sucht gezielt nach den EXAKTEN Regionsnamen "Chiemgauer
 * Alpen West" und "Chiemgauer Alpen Ost" (getrennt, kein Sammel-Match
 * auf "chiemgau") und liest jeweils die zugehörige Gefahrenstufe aus.
 *
 * WICHTIG: Nie gegen echte Daten getestet (Quelle war 404, Sommerpause)
 * -- beim ersten Live-Test in der Wintersaison verifizieren, ob die
 * Regionsnamen in der echten XML-Datei exakt so geschrieben sind.
 */
function parseAvalancheCaaml(xml) {
  const regionBlocks = xml.split(/<bulletin[ >]/i).slice(1);
  const result = { west: null, ost: null };

  for (const block of regionBlocks) {
    const head = block.slice(0, 2000);

    let key = null;
    if (AVALANCHE_REGIONS.west.test(head)) key = "west";
    else if (AVALANCHE_REGIONS.ost.test(head)) key = "ost";
    else continue;

    const dangerMatch = block.match(/<mainValue>\s*(\d)\s*<\/mainValue>/i)
      || block.match(/dangerRatingValue="(\d)"/i);
    const validTimeMatch = block.match(/<startTime>([^<]+)<\/startTime>/i);

    if (dangerMatch) {
      result[key] = {
        dangerLevel: Number(dangerMatch[1]),
        validFrom: validTimeMatch ? validTimeMatch[1] : null,
      };
    }
  }

  if (!result.west && !result.ost) {
    return {
      available: false,
      reason: "Weder 'Chiemgauer Alpen West' noch 'Ost' im Lagebericht gefunden -- Regionsname evtl. anders geschrieben, Parser prüfen",
      region: "Chiemgauer Alpen",
    };
  }

  return {
    available: true,
    // "west" ist die verifizierte Zuordnung für Hochfelln/Kampenwand.
    // Für Rückwärtskompatibilität mit der bisherigen Anzeige (ein
    // einzelner Wert) wird primär West gezeigt.
    dangerLevel: result.west?.dangerLevel ?? result.ost?.dangerLevel ?? null,
    region: "Chiemgauer Alpen West",
    regions: {
      "Chiemgauer Alpen West": result.west,
      "Chiemgauer Alpen Ost": result.ost,
    },
    source: "Lawinenwarndienst Bayern",
  };
}

/* =========================================================
   TRAININGS-AUSWERTUNG FUER R.U.D.I. -- TRAINING.HTML

   Additiv. Zeigt eigene Rad-Aktivitaeten aus intervals.icu:
   Wochen-/Monatsbilanz, letzte Fahrten, Jahresziel-Fortschritt und
   Trendvergleich.

   WARUM INTERVALS.ICU STATT STRAVA: Strava verlangt OAuth mit
   ablaufenden Tokens und Browser-Autorisierung. intervals.icu bietet
   dieselben Daten (es synchronisiert u.a. von Strava/Garmin) hinter
   einem simplen API-Key -- kein Token-Ablauf, keine Erneuerungslogik,
   nichts, was nach sechs Stunden still kaputtgeht.

   EINMALIGE EINRICHTUNG:
   1. intervals.icu -> Settings -> ganz unten "Developer Settings"
      -> API-Key erzeugen
   2. Athlete-ID steht auf derselben Seite (Format: i12345)
   3. Beides als Cloudflare-Secrets hinterlegen:
      INTERVALS_API_KEY, INTERVALS_ATHLETE_ID

   VERIFIZIERT (24.08.2026, offizielle API-Doku):
     Basis:  https://intervals.icu/api/v1
     Auth:   Header "Authorization: ApiKey API_KEY:<key>"
     Abruf:  /athlete/{id}/activities?oldest=JJJJ-MM-TT&newest=JJJJ-MM-TT
   NICHT verifiziert: die exakten Feldnamen der Antwort. Sie folgen
   der Strava-Konvention (distance, moving_time, total_elevation_gain,
   start_date_local, type), da intervals.icu von dort synchronisiert --
   getestet wurde das hier aber nicht. Falls Werte auf 0 stehen,
   zuerst /training aufrufen und die Rohantwort pruefen.

   Daten werden 20 Minuten in KV zwischengespeichert -- das Display
   aktualisiert ohnehin nur alle 15 Minuten (Lehre aus dem
   adsb.lol-429-Problem: nicht oefter fragen als noetig).
   ========================================================= */

const INTERVALS_API = "https://intervals.icu/api/v1";
const TRAINING_CACHE_MINUTES = 20;
const TRAINING_DEFAULT_GOAL_KM = 3000;

// Alle Rad-Varianten zaehlen mit, alles andere (Laufen, Schwimmen,
// Wandern) bleibt draussen.
const BIKE_TYPES = new Set([
  "Ride",
  "VirtualRide",
  "GravelRide",
  "MountainBikeRide",
  "EBikeRide",
  "EMountainBikeRide",
  "Velomobile",
  "Handcycle",
]);

/**
 * Beide dokumentierten Authentifizierungs-Formate, in Reihenfolge
 * der Verlaesslichkeit der Quelle.
 *
 * KORRIGIERT (24.08.2026, nach HTTP 401): Zuerst wurde nur der Header
 * "ApiKey API_KEY:<key>" genutzt -- der stammt aus Drittanbieter-
 * Dokumentationen. Das offizielle intervals.icu-Forum zeigt dagegen
 * HTTP Basic Auth ("curl -u API_KEY:<key>", Benutzername woertlich
 * "API_KEY"). Statt auf eine Variante zu wetten, werden beide
 * probiert -- kostet einen Fehlversuch, dafuer ist es egal, welche
 * Form der Server tatsaechlich erwartet.
 */
function intervalsAuthHeaders(env) {
  const key = env.INTERVALS_API_KEY;

  return [
    // HTTP Basic -- Form aus dem offiziellen Forum.
    { Authorization: `Basic ${btoa(`API_KEY:${key}`)}` },
    // Alternative Header-Form aus der API-Beschreibung.
    { Authorization: `ApiKey API_KEY:${key}` },
  ];
}

/**
 * Holt Rad-Aktivitaeten ab Jahresbeginn des Vorjahres.
 * Das Vorjahr kommt mit, damit der Trendvergleich
 * "Vorjahr zum selben Zeitpunkt" moeglich ist.
 */
async function fetchTrainingActivities(env) {
  if (!env.INTERVALS_API_KEY || !env.INTERVALS_ATHLETE_ID) {
    throw new Error("INTERVALS_API_KEY / INTERVALS_ATHLETE_ID sind nicht gesetzt");
  }

  const now = new Date();
  const oldest = `${now.getUTCFullYear() - 1}-01-01`;
  const newest = now.toISOString().slice(0, 10);

  const url = `${INTERVALS_API}/athlete/${env.INTERVALS_ATHLETE_ID}/activities`
    + `?oldest=${oldest}&newest=${newest}`;

  let lastError = null;

  for (const authHeader of intervalsAuthHeaders(env)) {
    const response = await fetch(url, {
      headers: { ...authHeader, Accept: "application/json" },
    });

    if (response.status === 401 || response.status === 403) {
      // Falsches Format oder falscher Key -- naechste Variante testen.
      lastError = new Error(`Zugriff abgelehnt (HTTP ${response.status})`);
      continue;
    }

    if (!response.ok) {
      throw new Error(`intervals.icu HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error("Unerwartete Antwort (keine Liste)");
    }

    return data.filter((a) => BIKE_TYPES.has(a.type || a.sport_type));
  }

  throw new Error(
    `${lastError ? errorMessage(lastError) : "Zugriff abgelehnt"} -- beide Auth-Formate abgelehnt. `
    + "API-Key und Athlete-ID im Dashboard pruefen (ID mit fuehrendem i, z.B. i562023)."
  );
}

/**
 * Kalorienverbrauch einer Aktivitaet.
 *
 * Erst nach einem echten Kalorienfeld suchen (Schreibweise variiert),
 * sonst aus der geleisteten Arbeit herleiten: Beim Radfahren liegt
 * der Wirkungsgrad des Menschen bei rund 20-25 %, wodurch sich die
 * mechanische Arbeit in Kilojoule und der Energieverbrauch in
 * Kilokalorien naeherungsweise 1:1 entsprechen -- eine gaengige
 * Faustformel, keine exakte Messung.
 *
 * Ohne Leistungsmesser und ohne Kalorienfeld bleibt es bei 0; dann
 * zeigt das Display den Pizza-Wert gar nicht erst an, statt eine
 * erfundene Zahl auszuweisen.
 */
function activityCalories(a) {
  const direct = a.calories ?? a.icu_calories ?? a.kcal;
  if (direct != null && direct > 0) return direct;

  const joules = a.icu_joules ?? a.joules;
  if (joules != null && joules > 0) return joules / 1000;

  const kj = a.icu_kj ?? a.kilojoules;
  if (kj != null && kj > 0) return kj;

  return 0;
}

/**
 * Berechnet Wochen-, Monats- und Jahreswerte plus Vergleichszeitraeume.
 *
 * Alle Zeitgrenzen bewusst in Europe/Berlin, nicht UTC -- sonst
 * landet eine Feierabendrunde am Sonntagabend in der falschen Woche
 * (dieselbe Zeitzonen-Falle wie bei den Screenshot-Zeitstempeln).
 */
/**
 * Gibt den ersten gueltigen Zahlenwert aus mehreren Kandidaten zurueck
 * -- fuer Felder, deren genaue Schreibweise bei intervals.icu nicht
 * live verifiziert ist (siehe activityCalories fuer dasselbe Muster).
 */
function numericFirst(...candidates) {
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Rundet auf eine Nachkommastelle, laesst null/undefined unveraendert. */
function round1(value) {
  return value === null || value === undefined ? null : Math.round(value * 10) / 10;
}

function summarizeTrainingActivities(activities) {
  const berlinNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));

  const startOfDay = (d) => {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };

  // Wochenstart Montag (nicht Sonntag).
  const dayIndex = (berlinNow.getDay() + 6) % 7;
  const weekStart = startOfDay(new Date(berlinNow));
  weekStart.setDate(weekStart.getDate() - dayIndex);

  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);

  const monthStart = new Date(berlinNow.getFullYear(), berlinNow.getMonth(), 1);
  const yearStart = new Date(berlinNow.getFullYear(), 0, 1);

  const lastYearStart = new Date(berlinNow.getFullYear() - 1, 0, 1);
  // Gleicher Kalendertag im Vorjahr -- fairer Vergleich statt
  // "ganzes Vorjahr gegen ein halbes aktuelles".
  const lastYearSamePoint = new Date(berlinNow);
  lastYearSamePoint.setFullYear(berlinNow.getFullYear() - 1);

  const empty = () => ({ km: 0, elevation: 0, seconds: 0, count: 0, kcal: 0 });

  const buckets = {
    week: empty(),
    lastWeek: empty(),
    month: empty(),
    year: empty(),
    lastYearToDate: empty(),
  };

  const add = (bucket, a) => {
    bucket.km += (a.distance || 0) / 1000;
    bucket.elevation += a.total_elevation_gain || 0;
    bucket.seconds += a.moving_time || 0;
    bucket.count += 1;
    bucket.kcal += activityCalories(a);
  };

  for (const a of activities) {
    const localDate = a.start_date_local || a.start_date;
    if (!localDate) continue;
    // start_date_local ist bereits Ortszeit -- ein "Z" am Ende waere
    // irrefuehrend, deshalb abschneiden.
    const when = new Date(String(localDate).replace("Z", ""));
    if (Number.isNaN(when.getTime())) continue;

    if (when >= weekStart) add(buckets.week, a);
    else if (when >= lastWeekStart) add(buckets.lastWeek, a);

    if (when >= monthStart) add(buckets.month, a);
    if (when >= yearStart) add(buckets.year, a);

    if (when >= lastYearStart && when <= lastYearSamePoint) {
      add(buckets.lastYearToDate, a);
    }
  }

  const round = (b) => ({
    km: Math.round(b.km),
    elevation: Math.round(b.elevation),
    hours: Math.round((b.seconds / 3600) * 10) / 10,
    count: b.count,
    kcal: Math.round(b.kcal),
  });

  const recent = activities
    .slice()
    .sort((a, b) =>
      String(b.start_date_local || b.start_date).localeCompare(String(a.start_date_local || a.start_date))
    )
    .slice(0, 10)
    .map((a) => ({
      name: a.name || "Fahrt",
      date: String(a.start_date_local || a.start_date || "").slice(0, 10) || null,
      km: Math.round(((a.distance || 0) / 1000) * 10) / 10,
      elevation: Math.round(a.total_elevation_gain || 0),
      minutes: Math.round((a.moving_time || 0) / 60),
      // Schnitt aus Distanz und reiner Fahrzeit -- steht im Display
      // im Vordergrund, da der Aktivitaetsname meist nur "Cycling"
      // lautet und damit nichts aussagt.
      speed: a.moving_time
        ? Math.round(((a.distance || 0) / 1000) / (a.moving_time / 3600) * 10) / 10
        : null,
      kcal: Math.round(activityCalories(a)),
      // WICHTIG (auf Nutzerwunsch, "alles was intervals anbietet"):
      // zusaetzliche Kennzahlen pro Fahrt. Feldnamen nicht fuer alle
      // live verifiziert -- mehrere gaengige Schreibweisen defensiv
      // geprueft (gleiches Muster wie bei activityCalories), sonst
      // bleibt der Wert null und die Anzeige laesst das Feld einfach weg.
      avgWatts: round1(numericFirst(a.icu_average_watts, a.average_watts)),
      normalizedWatts: round1(numericFirst(a.icu_weighted_avg_watts, a.weighted_avg_watts)),
      avgHr: round1(numericFirst(a.average_heartrate, a.icu_average_heartrate)),
      maxHr: round1(numericFirst(a.max_heartrate, a.icu_max_heartrate)),
      avgCadence: round1(numericFirst(a.average_cadence, a.icu_average_cadence)),
      trainingLoad: round1(numericFirst(a.icu_training_load)),
      intensity: round1(numericFirst(a.icu_intensity, a.intensity)),
      lrBalance: round1(numericFirst(
        a.avg_lr_balance, a.icu_avg_lr_balance,
        a.left_right_balance, a.icu_left_right_balance
      )),
    }));

  return {
    week: round(buckets.week),
    lastWeek: round(buckets.lastWeek),
    month: round(buckets.month),
    year: round(buckets.year),
    lastYearToDate: round(buckets.lastYearToDate),
    recent,
  };
}

/**
 * Holt den aktuellen eFTP aus dem Athleten-Profil.
 *
 * WICHTIG (24.08.2026, aus der intervals.icu-Oberflaeche abgelesen):
 * Es gibt ZWEI eFTP-Werte, die leicht zu verwechseln sind:
 *   - der eFTP des Athleten (aktueller Stand, hier gesucht)
 *   - "Aktivitaet eFTP" (Schaetzung aus EINER einzelnen Fahrt)
 * Beispiel aus echten Daten: Athlet 195 W, Einzelfahrt 171 W. Wer
 * versehentlich den Aktivitaetswert nimmt, zeigt einen deutlich zu
 * niedrigen Wert an, der wie ein Formverlust aussieht, obwohl er nur
 * eine einzelne Fahrt beschreibt.
 *
 * Feldname nicht live verifiziert -- mehrere Schreibweisen werden
 * abgeklopft, sonst bleibt der Wert null und die Zeile entfaellt.
 */
async function fetchAthleteEftp(env) {
  const url = `${INTERVALS_API}/athlete/${env.INTERVALS_ATHLETE_ID}`;

  for (const authHeader of intervalsAuthHeaders(env)) {
    try {
      const response = await fetch(url, {
        headers: { ...authHeader, Accept: "application/json" },
      });

      if (response.status === 401 || response.status === 403) continue;
      if (!response.ok) return null;

      const data = await response.json();

      // Direkt am Profil, oder in den Sport-Einstellungen fuer Rad.
      const direct = data.icu_eftp ?? data.eftp ?? data.estimated_ftp;
      if (direct != null) return Math.round(direct);

      const settings = data.sportSettings || data.sport_settings;
      if (Array.isArray(settings)) {
        const bike = settings.find((s) =>
          Array.isArray(s.types)
            ? s.types.some((t) => BIKE_TYPES.has(t))
            : BIKE_TYPES.has(s.type)
        );
        const fromSettings = bike?.icu_eftp ?? bike?.eftp ?? bike?.estimated_ftp;
        if (fromSettings != null) return Math.round(fromSettings);
      }

      return null;
    } catch (error) {
      logEvent("athlete_eftp_failed", { error: errorMessage(error) });
      return null;
    }
  }

  return null;
}

/**
 * Holt die Wellness-Zeitreihe (Fitness/Ermuedung) der letzten 90 Tage.
 *
 * CTL = Fitness (langfristige Belastung), ATL = Ermuedung
 * (kurzfristig), Form = CTL - ATL. Positive Form heisst frisch,
 * negative heisst noch belastet vom Training.
 *
 * NICHT LIVE VERIFIZIERT: die Feldnamen (ctl, atl). Sie sind in der
 * intervals.icu-Community die gaengige Bezeichnung, geprueft habe ich
 * sie nicht. Fehlen sie, liefert die Funktion null statt zu werfen --
 * das Fenster zeigt dann den Rest weiter an, statt komplett
 * auszufallen.
 */
async function fetchTrainingWellness(env) {
  const now = new Date();
  const past = new Date(now);
  past.setDate(past.getDate() - 90);

  const url = `${INTERVALS_API}/athlete/${env.INTERVALS_ATHLETE_ID}/wellness`
    + `?oldest=${past.toISOString().slice(0, 10)}&newest=${now.toISOString().slice(0, 10)}`;

  for (const authHeader of intervalsAuthHeaders(env)) {
    try {
      const response = await fetch(url, {
        headers: { ...authHeader, Accept: "application/json" },
      });

      if (response.status === 401 || response.status === 403) continue;
      if (!response.ok) return null;

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) return null;

      // Neueste zuerst sortieren, dann den juengsten Eintrag mit
      // echten Werten nehmen -- der heutige Tag kann noch leer sein.
      const sorted = data
        .slice()
        .sort((a, b) => String(b.id || b.date).localeCompare(String(a.id || a.date)));

      const latest = sorted.find((d) => d.ctl != null || d.atl != null);
      if (!latest) return null;

      const ctl = latest.ctl != null ? Math.round(latest.ctl) : null;
      const atl = latest.atl != null ? Math.round(latest.atl) : null;

      // Verlauf fuer die Mini-Kurve: taeglich, aelteste zuerst.
      const history = sorted
        .slice(0, 42)
        .reverse()
        .map((d) => (d.ctl != null ? Math.round(d.ctl) : null))
        .filter((v) => v != null);

      // Fitness-Entwicklung ueber 4 Wochen -- steigt oder faellt sie?
      const fourWeeksAgo = sorted.find((d, i) => i >= 28 && d.ctl != null);
      const ctlTrend = ctl != null && fourWeeksAgo?.ctl != null
        ? Math.round(ctl - fourWeeksAgo.ctl)
        : null;

      return {
        fitness: ctl,
        fatigue: atl,
        form: ctl != null && atl != null ? Math.round(ctl - atl) : null,
        ctlTrend,
        history,
        restingHR: latest.restingHR != null ? Math.round(latest.restingHR) : null,
        hrv: latest.hrv != null ? Math.round(latest.hrv) : null,
      };
    } catch (error) {
      logEvent("wellness_fetch_failed", { error: errorMessage(error) });
      return null;
    }
  }

  return null;
}

/**
 * Zieht Leistungswerte aus den Aktivitaeten selbst.
 *
 * Wieder defensiv: alle Felder optional behandeln. Wer ohne
 * Leistungsmesser faehrt, hat hier schlicht nichts stehen -- dann
 * zeigt das Fenster den Block einfach nicht an, statt Nullen.
 */
function summarizePower(activities) {
  const withPower = activities.filter(
    (a) => a.icu_weighted_avg_watts != null || a.icu_ftp != null
  );

  if (withPower.length === 0) return null;

  // Aktuellster FTP-Wert.
  const sortedByDate = withPower
    .slice()
    .sort((a, b) =>
      String(b.start_date_local || b.start_date).localeCompare(String(a.start_date_local || a.start_date))
    );

  // eFTP statt des manuell gesetzten FTP: der manuelle Wert aendert
  // sich nur, wenn man daran denkt, und sagt damit nichts ueber die
  // aktuelle Form. eFTP wird von intervals.icu laufend aus den
  // gefahrenen Daten geschaetzt und bewegt sich mit dem Training mit.
  //
  // NICHT LIVE VERIFIZIERT: der Feldname. "icu_eftp" ist die
  // naheliegende Vermutung; mehrere Schreibweisen werden deshalb
  // abgeklopft. Findet sich keine, bleibt die Zeile im Display
  // einfach weg, statt einen falschen Wert zu zeigen.
  // Rueckfallebene, falls das Athleten-Profil keinen eFTP liefert:
  // der BESTE Aktivitaets-eFTP der letzten 90 Tage. Der juengste
  // einzelne Wert waere irrefuehrend -- eine ruhige Ausfahrt liefert
  // eine niedrige Schaetzung, ohne dass die Form schlechter waere.
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const eftpValue = sortedByDate
    .filter((a) => String(a.start_date_local || a.start_date || "") >= cutoffIso)
    .reduce((max, a) => {
      const v = a.icu_eftp ?? a.eftp ?? a.icu_estimated_ftp;
      return v != null && v > max ? v : max;
    }, 0) || null;

  // Beste normalisierte Leistung und hoechste Trainingsbelastung
  // im laufenden Jahr.
  const thisYear = String(new Date().getFullYear());
  const yearActs = withPower.filter((a) =>
    String(a.start_date_local || a.start_date || "").startsWith(thisYear)
  );

  const maxWatts = yearActs.reduce(
    (max, a) => Math.max(max, a.icu_weighted_avg_watts || 0),
    0
  );

  const maxLoad = yearActs.reduce(
    (max, a) => Math.max(max, a.icu_training_load || 0),
    0
  );

  const longest = activities.reduce(
    (max, a) => Math.max(max, (a.distance || 0) / 1000),
    0
  );

  // WICHTIG (auf Nutzerwunsch, "L/R-Wattverteilung"): Durchschnitt
  // ueber alle Aktivitaeten des laufenden Jahres, die einen Wert
  // dafuer melden (nicht jeder Leistungsmesser liefert das). Feldname
  // wie bei den Einzelfahrten defensiv geprueft.
  const lrValues = yearActs
    .map((a) => numericFirst(a.avg_lr_balance, a.icu_avg_lr_balance, a.left_right_balance, a.icu_left_right_balance))
    .filter((v) => v !== null);
  const avgLrBalance = lrValues.length
    ? Math.round((lrValues.reduce((sum, v) => sum + v, 0) / lrValues.length) * 10) / 10
    : null;

  const avgCadenceValues = yearActs
    .map((a) => numericFirst(a.average_cadence, a.icu_average_cadence))
    .filter((v) => v !== null);
  const avgCadence = avgCadenceValues.length
    ? Math.round(avgCadenceValues.reduce((sum, v) => sum + v, 0) / avgCadenceValues.length)
    : null;

  const avgHrValues = yearActs
    .map((a) => numericFirst(a.average_heartrate, a.icu_average_heartrate))
    .filter((v) => v !== null);
  const avgHr = avgHrValues.length
    ? Math.round(avgHrValues.reduce((sum, v) => sum + v, 0) / avgHrValues.length)
    : null;

  const maxHr = yearActs.reduce(
    (max, a) => Math.max(max, numericFirst(a.max_heartrate, a.icu_max_heartrate) || 0),
    0
  );

  return {
    eftp: eftpValue != null ? Math.round(eftpValue) : null,
    bestWatts: maxWatts > 0 ? Math.round(maxWatts) : null,
    bestLoad: maxLoad > 0 ? Math.round(maxLoad) : null,
    longestRideKm: longest > 0 ? Math.round(longest) : null,
    avgLrBalance,
    avgCadence,
    avgHr,
    maxHr: maxHr > 0 ? Math.round(maxHr) : null,
  };
}

/* =========================================================
   PIZZA-BILANZ (pizza.html)

   Additiv. Sobald eine bisher unbekannte Radfahrt in intervals.icu
   auftaucht, wird sie mit Zeitstempel in KV vermerkt. maybeInsertPizzaWindow
   (siehe Routing-Abschnitt) schiebt pizza.html dann 24 Stunden lang
   zusaetzlich in die Tagesrotation -- OHNE das ansonsten rein manuelle
   Monats-Raster selbst wieder automatisch zu machen (siehe Kommentar
   bei WORKER_VERSION).

   Die Pruefung laeuft sowohl beim Seitenaufruf (/training) als auch
   im Cron mit, damit eine Fahrt auch dann erkannt wird, wenn gerade
   niemand aufs Display schaut.
   ========================================================= */

const PIZZA_WINDOW_HOURS = 24;
const KCAL_PRO_PIZZASTUECK = 285;

async function checkForNewRide(env, activities) {
  if (!Array.isArray(activities) || activities.length === 0) return;

  const newest = activities
    .slice()
    .sort((a, b) =>
      String(b.start_date_local || b.start_date).localeCompare(String(a.start_date_local || a.start_date))
    )[0];

  if (!newest) return;

  // Kennung der Aktivitaet. Faellt "id" aus, dient Datum+Distanz als
  // Ersatz -- unwahrscheinlich, dass zwei Fahrten darin exakt
  // uebereinstimmen.
  const rideId = newest.id
    ? String(newest.id)
    : `${newest.start_date_local || newest.start_date}-${Math.round(newest.distance || 0)}`;

  const stored = await env.RUDI_KV.get("pizza:state", "json");

  if (stored && stored.rideId === rideId) return; // schon bekannt

  const kcal = Math.round(activityCalories(newest));

  await env.RUDI_KV.put(
    "pizza:state",
    JSON.stringify({
      rideId,
      detectedAt: new Date().toISOString(),
      date: String(newest.start_date_local || newest.start_date || "").slice(0, 10),
      km: Math.round(((newest.distance || 0) / 1000) * 10) / 10,
      elevation: Math.round(newest.total_elevation_gain || 0),
      minutes: Math.round((newest.moving_time || 0) / 60),
      kcal,
      slices: Math.floor(kcal / KCAL_PRO_PIZZASTUECK),
    })
  );

  logEvent("pizza_new_ride", { rideId, kcal });
}

async function handlePizza(request, env) {
  requireKv(env);

  const state = await env.RUDI_KV.get("pizza:state", "json");

  if (!state) {
    return jsonResponse({ active: false, reason: "Noch keine Fahrt erkannt" }, 200, request);
  }

  const ageHours = (Date.now() - Date.parse(state.detectedAt)) / 3600000;

  return jsonResponse(
    {
      active: ageHours < PIZZA_WINDOW_HOURS,
      ageHours: Math.round(ageHours * 10) / 10,
      kcalProStueck: KCAL_PRO_PIZZASTUECK,
      ...state,
    },
    200,
    request
  );
}

/* =========================================================
   INTERESSANTE-FLUGZEUGE-ALARM FÜR R.U.D.I. (nutzt A.L.V.I.N.html)

   Additiv. Wie das Pizza-Fenster, nur für Flugzeuge: Statt die
   Flugradar-Seite manuell im Monats-Raster einzutragen, taucht sie
   automatisch für ein Zeitfenster auf, sobald ein "interessantes"
   Flugzeug mit ECHTER Flugbahn-Hochrechnung innerhalb der nächsten
   ~30 Minuten in die Nähe von Grassau kommen wird.

   "Interessant" (nach Nutzerentscheidung, 26.08.2026):
     - Widebody/Langstrecken-Typen (siehe WIDEBODY_TYPES)
     - Ungewöhnliche Airlines (Callsign-Präfix nicht in den üblichen
       Linien, die hier ständig durchfliegen)
     - Militärtransporter (siehe MILITARY_TRANSPORT_TYPES) --
       AUSDRÜCKLICH OHNE Kampfjets, die fliegen zu schnell/unvorher-
       sehbar für eine sinnvolle 30-Min-Vorwarnung.

   WARUM FLUGBAHN-HOCHRECHNUNG STATT "IST GERADE NAH": Bei
   Reisegeschwindigkeit sind 30 Minuten ca. 400-450km -- weit
   außerhalb der Empfangsreichweite. Eine echte Vorwarnung braucht
   also: aktuelle Position + Kurs + Geschwindigkeit -> Position in
   30 Minuten -> Abstand davon zu Grassau.

   Nutzt den bereits bestehenden Service Binding AVIRADAR_API_BINDING
   (siehe handleFlightProxy) -- keine neue Anbindung nötig.

   BETRIEB: Dieser Endpunkt (/flightalert/check) muss regelmäßig von
   außen angestoßen werden (z.B. cron-job.org, alle 5 Minuten -- siehe
   Projektnotizen zum selben Muster bei /training). Der eigentliche
   Anzeige-Endpunkt /flightalert liest nur den zuletzt gespeicherten
   Zustand, kostet also nichts extra.
   ========================================================= */

const FLIGHT_ALERT_RADIUS_KM = 40;
const FLIGHT_ALERT_LOOKAHEAD_MINUTES = 30;
const FLIGHT_ALERT_WINDOW_MINUTES = 45; // 30 Min Vorlauf + ca. 15 Min nach der Passage

// ICAO-Typencodes für Widebody/Langstrecken-Flugzeuge. Nicht
// erschöpfend, aber deckt die gängigen Typen ab, die über Bayern
// auf Langstrecke unterwegs sind.
const WIDEBODY_TYPES = new Set([
  "B742", "B743", "B744", "B748",
  "B762", "B763", "B764",
  "B772", "B773", "B77L", "B77W",
  "B788", "B789", "B78X",
  "A306", "A30B", "A310",
  "A332", "A333", "A337", "A338", "A339",
  "A342", "A343", "A345", "A346",
  "A359", "A35K", "A388",
  "MD11", "IL96", "DC10",
]);

// Militärtransporter -- bewusst OHNE Kampfjets (siehe Kommentar oben).
const MILITARY_TRANSPORT_TYPES = new Set([
  "A400", "C130", "C17", "C5M", "C5", "KC135", "KC10", "KC30", "C295", "CN35",
]);

// Callsign-Präfixe der Airlines, die hier ständig/gewöhnlich
// durchfliegen -- alles ANDERE gilt als "ungewöhnliche Airline".
const COMMON_AIRLINE_PREFIXES = new Set([
  "DLH", "EWG", "CFG", "SWR", "AUA", "BAW", "AFR", "KLM", "BEL", "IBE",
  "ITY", "LOT", "SAS", "FIN", "RYR", "EZY", "WZZ", "THY", "UAE", "QTR",
  "ETD", "SIA", "UAL", "DAL", "AAL", "TAP", "VLG", "TVS", "OCN", "EJU",
  "TAY", "GPX", "AIZ", "WMT", "WUK", "CTN", "PGT", "AEE", "NOZ", "ROT",
  // Erweitert (26.08.2026), nach SunExpress-Fehltreffer nochmal gegen
  // unsere früheren echten ADS-B-Dumps über Bayern abgeglichen --
  // alles unten kam dort mehrfach vor, also regelmäßiger Verkehr,
  // keine echte Seltenheit.
  "SXS", // SunExpress -- der konkrete Fehltreffer-Auslöser
  "TOM", // TUI fly
  "NSZ", // Norwegian
  "BTI", // Air Baltic
  "CAI", // Corendon Airlines
  "ELY", // El Al
  "CCA", // Air China
  "KQA", // Kenya Airways
  "AIC", // Air India
  "LGL", // Luxair
  "ASL", // Air Serbia
  "FHY", // Freebird Airlines
  "MNE", // Montenegro Airlines
  "UBD", "ADZ", "AMQ", // bulgarische Charter (GullivAir/Bulgarian Air Charter Varianten)
]);

/**
 * Prüft, ob ein Flugzeug nach obigen Kriterien "interessant" ist.
 * Gibt einen kurzen Grund-String zurück, oder null.
 */
// WICHTIG (Fix 01.09.2026, nach echtem Fehlalarm: Rettungshubschrauber
// EC135 mit Rufzeichen "CHX14" hat einen A400M-Alarm überschrieben,
// weil "CHX" nicht auf der Airline-Liste stand). Hubschrauber fliegen
// organisatorisch (Polizei, Rettung, Bundeswehr-intern etc.), nicht
// mit echten Airline-Rufzeichen -- auch wenn ihr Callsign zufällig wie
// eins aussieht (3 Buchstaben + Zahl), ist "ungewöhnliche Airline"
// hier der falsche Test und erzeugt nur Rauschen. Nicht erschöpfend,
// deckt aber die gängigsten Typcodes ab.
const HELICOPTER_TYPE_PATTERN = /^(EC1|EC2|EC3|EC4|H60|H64|H65|AS3|AS5|A109|A139|A169|R22|R44|R66|B06|B47|S76|S92|AW09|AW1|AW6|BK17|UH1|UH60|CH47|MD5|MD9)/;

function classifyInterestingAircraft(ac) {
  const type = String(ac.t || "").toUpperCase();
  const callsign = String(ac.flight || "").trim().toUpperCase();
  const registration = String(ac.r || "").trim().toUpperCase();
  const prefix = callsign.slice(0, 3);
  const isHelicopter = HELICOPTER_TYPE_PATTERN.test(type);

  // WICHTIG (Fix 26.08.2026, auf Nutzerwunsch): Militär-Erkennung jetzt
  // primär über das "dbFlags"-Feld der Flugzeugdatenbank (Bit 0 = 1
  // bedeutet militärisch) statt nur über eine Liste bekannter
  // Transporter-Typcodes. Das ist deutlich zuverlässiger -- erfasst
  // jetzt auch Kampfjets und Hubschrauber, nicht nur Transporter wie
  // A400M/C-130 (die MILITARY_TRANSPORT_TYPES-Liste bleibt als
  // Fallback, falls dbFlags bei einem Datensatz mal fehlt).
  const dbFlags = Number(ac.dbFlags) || 0;
  if (dbFlags & 1) {
    return `Militär (${type || callsign || "Typ unbekannt"})`;
  }

  if (MILITARY_TRANSPORT_TYPES.has(type)) {
    return `Militärtransporter (${type})`;
  }

  // WICHTIG (Fix 04.09.2026, auf Nutzerwunsch): Flying-Bulls-Prüfung
  // hier mit ergänzt, statt eine zweite, separate Liste in display.html
  // zu pflegen -- eine einzige Quelle der Wahrheit für "besonders",
  // die sowohl der Flugzeug-Alarm als auch der Stern in A.L.V.I.N.
  // nutzen (siehe handleFlightProxy für die Stern-Anreicherung).
  if (FLYING_BULLS_REGISTRATIONS.has(registration)) {
    return "Flying Bulls";
  }

  if (WIDEBODY_TYPES.has(type)) {
    return `Widebody (${type})`;
  }

  if (!isHelicopter && callsign && prefix && !COMMON_AIRLINE_PREFIXES.has(prefix)) {
    return `Ungewöhnliche Airline (${prefix})`;
  }

  return null;
}

/**
 * Projeziert eine Position um die angegebenen Minuten vorwärts, anhand
 * Kurs (Grad) und Geschwindigkeit (Knoten). Vereinfachte ebene
 * Projektion -- auf den hier relevanten Distanzen (<500km) ist die
 * Abweichung vernachlässigbar.
 */
function projectPosition(lat, lon, trackDeg, groundSpeedKt, minutesAhead) {
  const speedKmh = groundSpeedKt * 1.852;
  const distanceKm = speedKmh * (minutesAhead / 60);
  const trackRad = (trackDeg * Math.PI) / 180;

  const dLatKm = distanceKm * Math.cos(trackRad);
  const dLonKm = distanceKm * Math.sin(trackRad);

  return {
    lat: lat + dLatKm / 111,
    lon: lon + dLonKm / (111 * Math.cos((lat * Math.PI) / 180)),
  };
}

// WICHTIG (Fix 04.09.2026, auf Nutzerwunsch): Gleiche Liste wie in
// display.html (siehe dort für Quelle/Vorbehalte) -- hier zusätzlich
// serverseitig für die Benachrichtigungsprüfung.
const FLYING_BULLS_REGISTRATIONS = new Set([
  "OE-CKW", "OE-ADM", "OE-AMM", "F-AYSB", "N991DM", "OE-EDM", "OE-EAS",
  "OE-LDM", "N996DM", "OE-ARN", "OE-ARO", "N50429", "N68RW", "N25Y",
  "N6123C", "OE-EFB", "F-AZSB", "OE-EMM", "OE-ERB", "OE-FSE", "OE-EMD",
  "OE-FAS", "OE-FRB", "OE-FDM", "D-ICDM", "OE-XTV", "N11FX", "OE-XDM",
  "OE-XSY", "D-HSDM", "D-HTDM", "D-HUDM", "OE-XFB", "N69KL",
]);

// WICHTIG (Fix 04.09.2026, nach echtem 429-Vorfall): ntfy.sh drosselt
// anonyme Anfragen pro IP-Adresse -- Cloudflare Workers teilen sich
// Ausgangs-IPs mit potenziell tausenden anderen Workern weltweit, was zu
// Drosselung durch FREMDEN Traffic führen kann. Mit einem echten
// (kostenlosen) ntfy-Konto + Bearer-Token wird stattdessen pro Nutzer
// gedrosselt, nicht pro IP. NTFY_TOKEN ist optional -- ohne Token läuft
// es wie bisher anonym (nur mit dem beschriebenen Risiko).
// WICHTIG (Fix 04.09.2026, auf Nutzerwunsch): ntfy.sh aufgegeben --
// deren 250-Nachrichten-Tageslimit wird pro IP-Adresse gezählt, und
// Cloudflare Workers teilen sich Ausgangs-IPs mit tausenden anderen,
// unabhängigen Workern weltweit (bestätigt durch GitHub-Issue
// binwiederhier/ntfy#1711 "Invisible ratelimit leakage" -- exakt
// unser Symptom bei einem anderen Nutzer). Telegram Bot API ist
// dauerhaft kostenlos, kein Nachrichtenlimit für normale Nutzung, und
// nutzt einen echten Bot-Token statt einer geteilten IP-Adresse.
async function sendTelegram(env, { title, body }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID fehlt");
  }
  const text = title ? `*${title}*\n${body}` : body;
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  });
}

/**
 * Prüft die (schon abgerufene) Flugzeugliste auf Flying-Bulls-Treffer
 * und schickt bei einem NEUEN Fund (nicht in den letzten 3 Stunden schon
 * gemeldet) eine ntfy-Push-Benachrichtigung. Die 3-Stunden-Sperre pro
 * Registrierung verhindert Spam, falls dasselbe Flugzeug über längere
 * Zeit in der Luft bleibt (wir prüfen ja alle 5 Minuten).
 */
async function checkForFlyingBulls(env, aircraft) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const airborneMatches = aircraft.filter((ac) => {
    const reg = String(ac.r || "").trim().toUpperCase();
    const altitude = ac.alt_baro === "ground" ? 0 : Number(ac.alt_baro ?? ac.alt_geom);
    return reg && FLYING_BULLS_REGISTRATIONS.has(reg) && Number.isFinite(altitude) && altitude > 0;
  });

  for (const ac of airborneMatches) {
    const reg = String(ac.r).trim().toUpperCase();
    const kvKey = `flyingbulls:notified:${reg}`;
    const lastNotified = await env.RUDI_KV.get(kvKey);
    const cooldownMs = 3 * 60 * 60 * 1000;
    if (lastNotified && Date.now() - Number(lastNotified) < cooldownMs) continue;

    const type = String(ac.t || "").trim() || "Flugzeug";
    const callsign = String(ac.flight || "").trim() || reg;

    // WICHTIG (Fix, auf Nutzerwunsch): Startort mit in die
    // Benachrichtigung aufnehmen -- nutzt dieselbe Routen-Quelle
    // (adsbdb, über aviradar-api gecacht) wie schon der Zielort bei
    // A.L.V.I.N., nur eben das "origin"-Feld statt "destination".
    // Bei Fehlschlag (kein Rufzeichen bekannt, keine Route gefunden
    // o.ä.) bleibt das Feld einfach leer -- kein harter Fehler.
    let origin = null;
    if (env.AVIRADAR_API_BINDING && callsign) {
      try {
        const routeResponse = await env.AVIRADAR_API_BINDING.fetch(
          `${AVIRADAR_API}/route?callsign=${encodeURIComponent(callsign)}`
        );
        const routeData = await routeResponse.json();
        const route = routeData?.route;
        origin = route?.origin?.municipality || route?.origin?.name || null;
      } catch (error) {
        logEvent("flyingbulls_origin_lookup_failed", { callsign, error: errorMessage(error) });
      }
    }

    try {
      await sendTelegram(env, {
        title: "Flying Bulls in der Luft ✈️",
        body: origin
          ? `${type} (${reg}, ${callsign}) ist gerade in der Luft. Gestartet in ${origin}.`
          : `${type} (${reg}, ${callsign}) ist gerade in der Luft.`,
      });
      await env.RUDI_KV.put(kvKey, String(Date.now()), { expirationTtl: 6 * 3600 });
      logEvent("flyingbulls_notified", { registration: reg, type });
    } catch (error) {
      logEvent("flyingbulls_notify_failed", { error: errorMessage(error) });
    }
  }
}

async function checkForInterestingFlight(env) {
  requireKv(env);

  if (!env.AVIRADAR_API_BINDING) {
    logEvent("flightalert_check_skipped", { reason: "AVIRADAR_API_BINDING fehlt" });
    return;
  }

  let aircraft;
  try {
    const response = await env.AVIRADAR_API_BINDING.fetch(
      new Request(`${AVIRADAR_API}/aircraft`, { headers: { Accept: "application/json" } })
    );
    const data = await response.json();
    aircraft = Array.isArray(data.ac) ? data.ac : [];
  } catch (error) {
    logEvent("flightalert_check_failed", { error: errorMessage(error) });
    return;
  }

  // Nutzt dieselben, schon abgerufenen Flugzeugdaten -- kein separater
  // Abruf/keine zusätzliche Last nötig.
  await checkForFlyingBulls(env, aircraft);

  let closestMatch = null;

  for (const ac of aircraft) {
    const lat = Number(ac.lat);
    const lon = Number(ac.lon);
    const track = Number(ac.track ?? ac.true_heading ?? ac.mag_heading);
    const gs = Number(ac.gs);

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(track) || !Number.isFinite(gs)) {
      continue;
    }

    const reason = classifyInterestingAircraft(ac);
    if (!reason) continue;

    // WICHTIG (beim Testen gefunden, 26.08.2026): Eine einzelne Prüfung
    // GENAU bei +30 Min übersieht schnelle Flugzeuge, die Grassau schon
    // VOR Ablauf der 30 Minuten passieren -- die Projektion zeigt dann
    // fälschlich "weit weg", weil das Flugzeug zu diesem Zeitpunkt schon
    // wieder auf der anderen Seite vorbeigeflogen ist. Stattdessen wird
    // die Position zu mehreren Zeitpunkten innerhalb der nächsten 30 Min
    // geprüft und der jeweils kleinste Abstand genommen -- damit wird
    // der tatsächliche kürzeste Vorbeiflug-Abstand erfasst, egal wann
    // genau er innerhalb des Fensters stattfindet.
    let closestApproachKm = Infinity;
    for (let minutesAhead = 5; minutesAhead <= FLIGHT_ALERT_LOOKAHEAD_MINUTES; minutesAhead += 5) {
      const projected = projectPosition(lat, lon, track, gs, minutesAhead);
      const d = haversineKm(GRASSAU_CENTER.lat, GRASSAU_CENTER.lon, projected.lat, projected.lon);
      if (d < closestApproachKm) closestApproachKm = d;
    }
    const distanceKm = closestApproachKm;

    if (distanceKm > FLIGHT_ALERT_RADIUS_KM) continue;

    if (!closestMatch || distanceKm < closestMatch.distanceKm) {
      closestMatch = {
        reason,
        distanceKm: Math.round(distanceKm * 10) / 10,
        callsign: String(ac.flight || "").trim() || null,
        registration: ac.r || null,
        type: ac.t || null,
        operator: ac.ownOp || null,
        altitudeFt: Number.isFinite(Number(ac.alt_baro)) ? Number(ac.alt_baro) : null,
      };
    }
  }

  if (!closestMatch) return;

  // WICHTIG (Fix 01.09.2026, nach echtem Fall: ein Rettungshubschrauber
  // mit "Ungewöhnliche Airline"-Treffer hat einen echten A400M-Alarm
  // überschrieben, bevor er auf dem Display sichtbar wurde -- weil wir
  // bisher IMMER den neuesten Treffer unconditional gespeichert haben).
  // Jetzt: ein neuer Treffer überschreibt einen noch aktiven (< 45 Min
  // alten) bestehenden Alarm nur, wenn er mindestens genauso wichtig
  // ist. Reihenfolge: Militär > Widebody > Ungewöhnliche Airline.
  const existing = await env.RUDI_KV.get("flightalert:state", "json");
  if (existing?.detectedAt) {
    const existingAgeMinutes = (Date.now() - Date.parse(existing.detectedAt)) / 60000;
    if (existingAgeMinutes < FLIGHT_ALERT_WINDOW_MINUTES) {
      const existingPriority = reasonPriority(existing.reason);
      const newPriority = reasonPriority(closestMatch.reason);
      if (newPriority < existingPriority) {
        logEvent("flightalert_kept_higher_priority", {
          existing: existing.reason,
          skipped: closestMatch.reason,
        });
        return;
      }
    }
  }

  await env.RUDI_KV.put(
    "flightalert:state",
    JSON.stringify({
      ...closestMatch,
      detectedAt: new Date().toISOString(),
    })
  );

  logEvent("flightalert_detected", closestMatch);
}

/**
 * Ordnet einen Erkennungsgrund-String einer Priorität zu, damit ein
 * neuer, weniger wichtiger Treffer einen noch aktiven wichtigeren
 * Alarm nicht überschreibt (siehe Kommentar oben bei der Nutzung).
 */
function reasonPriority(reason) {
  const text = String(reason || "");
  if (text.startsWith("Militär")) return 3;
  if (text.startsWith("Widebody")) return 2;
  if (text.startsWith("Ungewöhnliche Airline")) return 1;
  return 0;
}

async function handleFlightAlertCheck(request, env) {
  await checkForInterestingFlight(env);
  return jsonResponse({ checked: true }, 200, request);
}

async function handleFlightAlert(request, env) {
  requireKv(env);

  const state = await env.RUDI_KV.get("flightalert:state", "json");

  if (!state) {
    return jsonResponse({ active: false, reason: "Noch kein interessantes Flugzeug erkannt" }, 200, request);
  }

  const ageMinutes = (Date.now() - Date.parse(state.detectedAt)) / 60000;

  return jsonResponse(
    {
      active: ageMinutes < FLIGHT_ALERT_WINDOW_MINUTES,
      ageMinutes: Math.round(ageMinutes),
      ...state,
    },
    200,
    request
  );
}

/**
 * Diagnose: zeigt, welche Felder intervals.icu tatsaechlich liefert.
 *
 * Existiert, weil der eFTP-Feldname mehrfach falsch geraten wurde.
 * Statt eine weitere Vermutung zu deployen, hier einmal nachsehen --
 * die Antwort listet alle Feldnamen der juengsten Aktivitaet sowie
 * das Athleten-Profil.
 */
async function handleTrainingDebug(request, env) {
  if (!env.INTERVALS_API_KEY || !env.INTERVALS_ATHLETE_ID) {
    return jsonResponse({ error: "Secrets fehlen" }, 503, request);
  }

  const result = {};

  for (const authHeader of intervalsAuthHeaders(env)) {
    try {
      const now = new Date();
      const past = new Date(now);
      past.setDate(past.getDate() - 60);

      const actUrl = `${INTERVALS_API}/athlete/${env.INTERVALS_ATHLETE_ID}/activities`
        + `?oldest=${past.toISOString().slice(0, 10)}&newest=${now.toISOString().slice(0, 10)}`;

      const actRes = await fetch(actUrl, {
        headers: { ...authHeader, Accept: "application/json" },
      });

      if (actRes.status === 401 || actRes.status === 403) continue;

      const acts = await actRes.json();
      const newest = Array.isArray(acts) && acts.length ? acts[0] : null;

      if (newest) {
        result.aktivitaetFelder = Object.keys(newest).sort();
        result.ftpVerdaechtig = Object.fromEntries(
          Object.entries(newest).filter(([k]) => /ftp|watt|power|kcal|calor|joule/i.test(k))
        );
      } else {
        result.aktivitaetFelder = "keine Aktivitaet in den letzten 60 Tagen";
      }

      const profRes = await fetch(`${INTERVALS_API}/athlete/${env.INTERVALS_ATHLETE_ID}`, {
        headers: { ...authHeader, Accept: "application/json" },
      });

      if (profRes.ok) {
        const profile = await profRes.json();
        result.profilFelder = Object.keys(profile).sort();
        result.profilFtpVerdaechtig = Object.fromEntries(
          Object.entries(profile).filter(([k]) => /ftp|sport|setting/i.test(k))
        );
      } else {
        result.profilFehler = `HTTP ${profRes.status}`;
      }

      return jsonResponse(result, 200, request);
    } catch (error) {
      result.fehler = errorMessage(error);
    }
  }

  return jsonResponse({ ...result, error: "Kein Auth-Format akzeptiert" }, 502, request);
}

async function handleTrainingGoal(request, env) {
  requireKv(env);
  const url = new URL(request.url);

  if (!url.searchParams.has("km")) {
    const stored = await env.RUDI_KV.get("training:goal", "json");
    return jsonResponse({ goalKm: stored?.km ?? TRAINING_DEFAULT_GOAL_KM }, 200, request);
  }

  const km = Number(url.searchParams.get("km"));

  if (!Number.isFinite(km) || km <= 0) {
    return jsonResponse(
      { error: "Ungueltiger Wert", beispiel: "/training/goal?km=3000" },
      400,
      request
    );
  }

  await env.RUDI_KV.put("training:goal", JSON.stringify({ km }));
  return jsonResponse({ set: true, goalKm: km }, 200, request);
}

async function handleTraining(request, env) {
  requireKv(env);

  // ?force=1 uebergeht den Zwischenspeicher. Praktisch direkt nach
  // einem Deploy: sonst zeigt der Endpunkt bis zu 20 Minuten lang die
  // alte Antwort, und es sieht so aus, als haette die Aenderung nicht
  // gegriffen.
  const force = new URL(request.url).searchParams.get("force") === "1";

  const cached = await env.RUDI_KV.get("training:data", "json");
  const ageMinutes = cached?.fetchedAt
    ? (Date.now() - Date.parse(cached.fetchedAt)) / 60000
    : Infinity;

  if (!force && cached && ageMinutes < TRAINING_CACHE_MINUTES) {
    return jsonResponse(
      { workerVersion: WORKER_VERSION, ...cached, cached: true, cacheAgeMinutes: Math.round(ageMinutes) },
      200,
      request
    );
  }

  const goalStored = await env.RUDI_KV.get("training:goal", "json");
  const goalKm = goalStored?.km ?? TRAINING_DEFAULT_GOAL_KM;

  try {
    const activities = await fetchTrainingActivities(env);

    // Neue Fahrt? Dann Pizza-Fenster fuer 24 Stunden freischalten.
    await checkForNewRide(env, activities);

    const summary = summarizeTrainingActivities(activities);

    // Wellness separat holen -- schlaegt der Abruf fehl, laeuft der
    // Rest trotzdem weiter (liefert dann null).
    const wellness = await fetchTrainingWellness(env);
    const power = summarizePower(activities);

    // Athleten-eFTP hat Vorrang vor der aus Aktivitaeten abgeleiteten
    // Naeherung (siehe fetchAthleteEftp).
    const athleteEftp = await fetchAthleteEftp(env);
    if (power && athleteEftp != null) power.eftp = athleteEftp;

    const payload = {
      ...summary,
      wellness,
      power,
      goalKm,
      fetchedAt: new Date().toISOString(),
    };

    await env.RUDI_KV.put("training:data", JSON.stringify(payload));
    logEvent("training_refreshed", {
      activities: activities.length,
      yearKm: summary.year.km,
      hasWellness: Boolean(wellness),
      hasPower: Boolean(power),
    });

    return jsonResponse({ workerVersion: WORKER_VERSION, ...payload }, 200, request);
  } catch (error) {
    // Gleiche Linie wie bei den Rennergebnissen: lieber leicht
    // veraltete echte Daten zeigen als eine Fehlermeldung aufs
    // Display bringen.
    if (cached) {
      logEvent("training_refresh_failed_using_cache", { error: errorMessage(error) });
      return jsonResponse({ ...cached, cached: true, staleReason: errorMessage(error) }, 200, request);
    }

    return jsonResponse(
      { error: "Trainingsdaten nicht verfuegbar", detail: errorMessage(error), goalKm },
      503,
      request
    );
  }
}


async function handleParaglidable(request, env) {
  if (!env.PARAGLIDABLE_KEY) {
    return jsonResponse(
      { error: "PARAGLIDABLE_KEY is not configured" },
      503,
      request
    );
  }

  const cache = caches.default;
  const cacheKey = new Request(
    `${new URL(request.url).origin}/__rudi_cache/paraglidable`,
    { method: "GET" }
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "HIT");
    return new Response(cached.body, { status: 200, headers });
  }

  const upstreamUrl =
    `https://api.paraglidable.com/?key=${env.PARAGLIDABLE_KEY}&format=JSON&version=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      return jsonResponse(
        { error: "Paraglidable unavailable", upstreamStatus: response.status },
        502,
        request
      );
    }

    const data = await response.text();

    const cacheResponse = new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Paraglidable-Prognosen ändern sich träge -- 30 Min Cache reicht
        // und schont das Kontingent des Keys.
        "Cache-Control": "public, max-age=1800",
      },
    });

    await cache.put(cacheKey, cacheResponse.clone());

    const headers = new Headers(cacheResponse.headers);
    Object.entries(corsHeaders(request)).forEach(([k, v]) => headers.set(k, v));
    headers.set("X-RUDI-Cache", "MISS");

    return new Response(cacheResponse.body, { status: 200, headers });
  } catch (error) {
    return jsonResponse(
      { error: "Paraglidable request failed", detail: errorMessage(error) },
      502,
      request
    );
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   ROUTING / ZEITPLAN-SYSTEM FÜR R.U.D.I.

   Additiv. Entscheidet, welche Seite der Screenshot-Workflow gerade
   zeigen soll -- ohne dass dafür Code angefasst werden muss.

   NEU (25.08.2026, auf Nutzerwunsch): Keine automatische Erkennung
   mehr (kein "läuft gerade ein Rennen" oder "ist Winter"). Stattdessen
   eine vollständig manuelle MONATLICHE Rotation: für jeden Monat (1-12)
   trägt man in control.html ein, welche Seiten in diesem Monat
   rotieren sollen. Rührt man nichts an, rotiert es stur zwischen den
   für den aktuellen Monat hinterlegten Seiten.

   Priorität bei der Entscheidung:
     1. Manueller Override (heute explizit gesetzt über control.html)
     2. Monats-Rotation (siehe monthlyRotation, manuell gepflegt)
     3. Fallback (falls für den aktuellen Monat nichts hinterlegt ist)

   KV-Keys:
     schedule:config    -- die Zeitplan-Konfiguration (JSON)
     schedule:override:{displayId} -- {date:"YYYY-MM-DD", url, label}

   Beispiel /route Antwort:
     { "url": "weather.html", "source": "rotation", "label": "Wetter & Familie" }
   ========================================================= */

const BASE_URL = "https://hmmrmnn.github.io/r.u.d.i./";

// Startbestand der Seiten-Registry -- greift nur, solange KV noch leer
// ist (allererster Aufruf). Danach übernimmt KV, und neue Seiten kommen
// über /channels (POST) oder das Formular in control.html dazu.
const DEFAULT_CHANNELS = [
  { name: "Wetter & Familie", file: "weather.html", category: "R.U.D.I." },
  { name: "Gleitschirm & Segelflug", file: "paragliding.html", category: "R.U.D.I." },
  { name: "Schneebericht", file: "snow.html", category: "R.U.D.I." },
  { name: "Flugradar", file: "A.L.V.I.N.html", category: "R.U.D.I." },
  { name: "Pizza-Bilanz", file: "pizza.html", category: "R.U.D.I." },
  { name: "Training", file: "training.html", category: "R.U.D.I." },
  { name: "Gleitschirm Live", file: "paragliderslive.html", category: "R.U.D.I." },
  // WICHTIG (Fix 03.09.2026): racing.html existierte laut
  // Änderungsprotokoll (v14, 25.08.2026) schon länger als echte Seite,
  // fehlte aber hier im Code-Standard -- nur sicher, solange sie live
  // in KV eingetragen war. Bei einem /channels/reset wäre sie
  // verschwunden. Jetzt fest ergänzt.
  { name: "Radrennen", file: "racing.html", category: "R.U.D.I." },
  // WICHTIG (Fix, auf Nutzerwunsch): neue Seiten aus dieser
  // Sitzung ergänzt.
  { name: "Chiemsee", file: "chiemsee.html", category: "R.U.D.I." },
  { name: "Wetterwarnung", file: "warnings.html", category: "R.U.D.I." },
];

/* =========================================================
   DISPLAY-REGISTRY FÜR R.U.D.I.

   Additiv. Verwaltet mehrere physische Displays -- jedes hat eine
   eigene ID (für /route?display=ID und /route/override?display=ID)
   und einen eigenen Override, teilt sich aber den Basis-Zeitplan.
   ========================================================= */

const DEFAULT_DISPLAYS = [
  { id: "display1", name: "Hauptdisplay" },
];

async function handleGetDisplays(request, env) {
  requireKv(env);
  const displays = (await env.RUDI_KV.get("displays:registry", "json")) || DEFAULT_DISPLAYS;
  return jsonResponse(displays, 200, request);
}

async function handleAddDisplay(request, env) {
  requireKv(env);
  const body = await request.json().catch(() => null);

  if (!body || !body.id || !body.name) {
    return jsonResponse(
      { error: "Missing id or name", example: { id: "display2", name: "Küche" } },
      400,
      request
    );
  }

  const displays = (await env.RUDI_KV.get("displays:registry", "json")) || DEFAULT_DISPLAYS;
  const filtered = displays.filter((d) => d.id !== body.id);
  filtered.push({ id: body.id, name: body.name });

  await env.RUDI_KV.put("displays:registry", JSON.stringify(filtered));

  return jsonResponse({ added: true, displays: filtered }, 200, request);
}

async function handleRemoveDisplay(request, env) {
  requireKv(env);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) return jsonResponse({ error: "Missing id parameter" }, 400, request);
  if (id === "display1") {
    return jsonResponse({ error: "Hauptdisplay (display1) kann nicht entfernt werden" }, 400, request);
  }

  const displays = (await env.RUDI_KV.get("displays:registry", "json")) || DEFAULT_DISPLAYS;
  const filtered = displays.filter((d) => d.id !== id);

  await env.RUDI_KV.put("displays:registry", JSON.stringify(filtered));
  // Zugehörigen Override gleich mit aufräumen
  await env.RUDI_KV.delete(`schedule:override:${id}`);

  return jsonResponse({ removed: true, displays: filtered }, 200, request);
}

/* =========================================================
   STANDORT FÜR FLUGRADAR-SEITEN

   Additiv. Der Trackingpunkt ("wo bin ich gerade") wird serverseitig
   gespeichert -- nicht nur im Browser (localStorage o.ä.) -- damit
   sowohl die Live-Ansicht im Browser als auch der automatische
   Screenshot-Workflow (headless, ohne eigenes Gedächtnis zwischen
   Läufen) denselben, zuletzt gesetzten Ort verwenden.
   ========================================================= */

const DEFAULT_LOCATION = { lat: 48.1523053182125, lon: 11.503841513918516, label: "Laimer Str. 27" };

async function handleGetLocation(request, env) {
  requireKv(env);
  const stored = await env.RUDI_KV.get("flightradar:location", "json");
  return jsonResponse(stored || DEFAULT_LOCATION, 200, request);
}

async function handleSetLocation(request, env) {
  requireKv(env);
  const url = new URL(request.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const label = url.searchParams.get("label") || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return jsonResponse(
      { error: "Missing or invalid lat/lon", example: "/location?lat=48.1547&lon=11.5074&label=M%C3%BCnchen" },
      400,
      request
    );
  }

  const location = { lat, lon, label };
  await env.RUDI_KV.put("flightradar:location", JSON.stringify(location));

  return jsonResponse({ set: true, ...location }, 200, request);
}

async function handleGetChannels(request, env) {
  requireKv(env);
  const raw = (await env.RUDI_KV.get("channels:registry", "json")) || DEFAULT_CHANNELS;

  // Selbstheilung: Duplikate (gleiche "file") entfernen -- letzter
  // Eintrag gewinnt. Falls dabei was bereinigt wurde, gleich sauber
  // zurückschreiben, damit sich der Fehler nicht wieder ansammelt.
  const byFile = new Map();
  raw.forEach((c) => byFile.set(c.file, c));

  // WICHTIG (Fix, auf Nutzerwunsch): neue Standard-Seiten automatisch
  // nachtragen, falls sie noch nie synchronisiert wurden -- so tauchen
  // frisch in DEFAULT_CHANNELS ergänzte Seiten beim nächsten Laden von
  // selbst auf, ohne manuellen Reset. Eine separate Merkliste
  // ("channels:synced_defaults") verhindert, dass ein absichtlich per
  // /channels/remove entfernter Standard-Kanal hier wieder auftaucht --
  // nur "file"-Werte, die WEDER im aktiven Bestand NOCH je synchronisiert
  // wurden, gelten als wirklich neu.
  const syncedDefaults = new Set((await env.RUDI_KV.get("channels:synced_defaults", "json")) || []);
  let addedCount = 0;
  DEFAULT_CHANNELS.forEach((defaultChannel) => {
    if (!byFile.has(defaultChannel.file) && !syncedDefaults.has(defaultChannel.file)) {
      byFile.set(defaultChannel.file, defaultChannel);
      addedCount += 1;
    }
    syncedDefaults.add(defaultChannel.file);
  });

  const channels = Array.from(byFile.values());

  if (channels.length !== raw.length || addedCount > 0) {
    await env.RUDI_KV.put("channels:registry", JSON.stringify(channels));
    await env.RUDI_KV.put("channels:synced_defaults", JSON.stringify(Array.from(syncedDefaults)));
    logEvent("channels_deduped", { before: raw.length, after: channels.length, autoAdded: addedCount });
  }

  return jsonResponse(channels, 200, request);
}

async function handleResetChannels(request, env) {
  requireKv(env);
  await env.RUDI_KV.put("channels:registry", JSON.stringify(DEFAULT_CHANNELS));
  return jsonResponse(
    { reset: true, channels: DEFAULT_CHANNELS },
    200,
    request
  );
}

async function handleAddChannel(request, env) {
  requireKv(env);
  const body = await request.json().catch(() => null);

  if (!body || !body.name || !body.file) {
    return jsonResponse(
      { error: "Missing name or file", example: { name: "Schneehöhen", file: "snow.html" } },
      400,
      request
    );
  }

  const channels = (await env.RUDI_KV.get("channels:registry", "json")) || DEFAULT_CHANNELS;

  // Duplikate (gleiche Datei) überschreiben statt doppelt anzulegen
  const filtered = channels.filter((c) => c.file !== body.file);
  filtered.push({
    name: body.name,
    file: body.file,
    category: body.category || "R.U.D.I.",
    isApp: Boolean(body.isApp),
  });

  await env.RUDI_KV.put("channels:registry", JSON.stringify(filtered));

  return jsonResponse({ added: true, channels: filtered }, 200, request);
}

/* =========================================================
   MANUELLER SCREENSHOT-REFRESH FÜR R.U.D.I.

   Additiv. Löst den GitHub-Actions-Workflow "Update E-Ink Screenshot"
   im r.u.d.i.-Repo per GitHub-API aus (workflow_dispatch), statt auf
   den nächsten Cron-Lauf zu warten.

   Benötigt: Secret GITHUB_TOKEN (Fine-grained PAT, Actions:
   Read&Write, nur für das r.u.d.i.-Repo)
   ========================================================= */

const GITHUB_REPO = "HMMRMNN/r.u.d.i.";
const GITHUB_WORKFLOW_FILE = "update-screenshot.yml";

async function handleRefresh(request, env) {
  if (!env.GITHUB_TOKEN) {
    return jsonResponse(
      { error: "GITHUB_TOKEN is not configured" },
      503,
      request
    );
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW_FILE}/dispatches`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "rudi-worker",
      },
      body: JSON.stringify({ ref: "main" }),
    });

    if (response.status === 204) {
      return jsonResponse(
        { triggered: true, message: "Workflow gestartet, dauert ~1 Minute" },
        200,
        request
      );
    }

    const detail = await response.text();
    return jsonResponse(
      { error: "GitHub API lehnte den Aufruf ab", status: response.status, detail },
      502,
      request
    );
  } catch (error) {
    return jsonResponse(
      { error: "Anfrage an GitHub fehlgeschlagen", detail: errorMessage(error) },
      502,
      request
    );
  }
}

async function handleRemoveChannel(request, env) {
  requireKv(env);
  const url = new URL(request.url);
  const file = url.searchParams.get("file");

  if (!file) {
    return jsonResponse({ error: "Missing file parameter" }, 400, request);
  }

  const channels = (await env.RUDI_KV.get("channels:registry", "json")) || DEFAULT_CHANNELS;
  const target = file.trim();
  const filtered = channels.filter((c) => c.file.trim() !== target);
  const actuallyRemoved = filtered.length < channels.length;

  await env.RUDI_KV.put("channels:registry", JSON.stringify(filtered));

  return jsonResponse(
    { removed: actuallyRemoved, matched: actuallyRemoved, channels: filtered },
    200,
    request
  );
}

/**
 * Standard-Zeitplan, falls noch nie einer in KV gespeichert wurde.
 *
 * KOMPLETT UMGEBAUT (25.08.2026, auf Nutzerwunsch): Statt einer festen
 * Basis-Rotation + automatisch zugeschalteten Bedingungsfenstern gibt
 * es jetzt für JEDEN Monat (1-12) eine eigene, frei editierbare Liste
 * von Seiten. Keine automatische Erkennung mehr (kein "läuft gerade
 * ein Rennen", kein "ist Winter") -- alles wird in control.html von
 * Hand gepflegt. Rührt man einen Monat nicht an, rotiert es einfach
 * stur zwischen den hier als Default hinterlegten Seiten.
 */
const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

const DEFAULT_SCHEDULE = {
  monthlyRotation: {
    1: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }, { url: "snow.html", label: "Schneebericht" }],
    2: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }, { url: "snow.html", label: "Schneebericht" }],
    3: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }, { url: "snow.html", label: "Schneebericht" }],
    4: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    5: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    6: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    7: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    8: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    9: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    10: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }],
    11: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }, { url: "snow.html", label: "Schneebericht" }],
    12: [{ url: "weather.html", label: "Wetter & Familie" }, { url: "paragliding.html", label: "Gleitschirm & Segelflug" }, { url: "snow.html", label: "Schneebericht" }],
  },
  // Jedes Fenster wird für diese Dauer gezeigt, bevor zum nächsten
  // gewechselt wird (Minuten).
  rotationMinutes: 15,
  // Nachtmodus: in diesem Zeitfenster (Berlin-Zeit, Stunden 0-23)
  // pausiert die Aktualisierung komplett -- weder der Screenshot-
  // Workflow noch das Display machen dann irgendwas, spart GitHub-
  // Actions-Minuten und schont das E-Ink-Panel. startHour/endHour
  // dürfen über Mitternacht hinausgehen (z.B. 23 -> 7).
  nightMode: { enabled: false, startHour: 0, endHour: 7 },
};

/**
 * Prüft, ob JETZT (Berlin-Zeit) innerhalb des konfigurierten
 * Nachtmodus-Fensters liegt. Behandelt auch über-Mitternacht-Bereiche
 * (z.B. 23 Uhr bis 7 Uhr) korrekt.
 */
function isNightModeActive(nightMode, now) {
  if (!nightMode || !nightMode.enabled) return false;

  const hour = now.getHours();
  const { startHour, endHour } = nightMode;

  if (startHour === endHour) return false; // 0-Stunden-Fenster == aus

  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // Über Mitternacht hinweg, z.B. 23 -> 7
  return hour >= startHour || hour < endHour;
}

/**
 * Hängt pizza.html an eine Rotation an, falls gerade eine frische
 * Fahrt-Erkennung vorliegt (< PIZZA_WINDOW_HOURS) -- rein additiv,
 * rührt das übergebene Monats-Raster selbst nicht an. Kein KV-Eintrag
 * vorhanden oder abgelaufen -> unveränderte Rotation zurück.
 */
async function maybeInsertPizzaWindow(env, baseRotation) {
  try {
    const state = await env.RUDI_KV.get("pizza:state", "json");
    if (!state || !state.detectedAt) return baseRotation;

    const ageHours = (Date.now() - Date.parse(state.detectedAt)) / 3600000;
    if (ageHours >= PIZZA_WINDOW_HOURS) return baseRotation;

    return [...baseRotation, { url: "pizza.html", label: "Pizza-Bilanz" }];
  } catch (error) {
    return baseRotation;
  }
}

/**
 * Wie maybeInsertPizzaWindow, nur für interessante Flugzeuge --
 * schiebt A.L.V.I.N.html additiv in die Rotation, solange die letzte
 * Erkennung noch innerhalb von FLIGHT_ALERT_WINDOW_MINUTES liegt.
 */
async function maybeInsertFlightAlertWindow(env, baseRotation) {
  try {
    const state = await env.RUDI_KV.get("flightalert:state", "json");
    if (!state || !state.detectedAt) return baseRotation;

    const ageMinutes = (Date.now() - Date.parse(state.detectedAt)) / 60000;
    if (ageMinutes >= FLIGHT_ALERT_WINDOW_MINUTES) return baseRotation;

    return [...baseRotation, { url: "A.L.V.I.N.html", label: "Flugradar" }];
  } catch (error) {
    return baseRotation;
  }
}

async function handleGetRoute(request, env) {
  requireKv(env);

  const url = new URL(request.url);
  const displayId = url.searchParams.get("display") || "display1";

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" })
  );
  const todayIso = now.toISOString().slice(0, 10);

  // 1. Manueller Override für heute (pro Display eigener Speicher) --
  // hat immer Vorrang, unterbricht die Rotation komplett für den Rest
  // des Tages -- aber nur für DIESES Display, nicht für andere.
  const overrideRaw = await env.RUDI_KV.get(`schedule:override:${displayId}`, "json");
  if (overrideRaw && overrideRaw.date === todayIso) {
    return jsonResponse(
      {
        url: resolveUrl(overrideRaw.url),
        source: "override",
        label: overrideRaw.label || overrideRaw.url,
        display: displayId,
      },
      200,
      request
    );
  }

  const schedule = (await env.RUDI_KV.get("schedule:config", "json")) || DEFAULT_SCHEDULE;

  // 1b. Nachtmodus: komplette Pause, wenn aktiviert und gerade
  // innerhalb des konfigurierten Zeitfensters. Kein "url" in der
  // Antwort -- der Screenshot-Workflow erkennt "sleeping: true" und
  // überspringt den teuren Playwright-Schritt komplett, statt ein
  // Bild zu erzeugen.
  if (isNightModeActive(schedule.nightMode, now)) {
    return jsonResponse(
      {
        sleeping: true,
        source: "night",
        label: "Nachtmodus aktiv",
        display: displayId,
      },
      200,
      request
    );
  }

  // 2. Monats-Rotation nachschlagen -- komplett manuell gepflegt, keine
  // automatische Bedingungsprüfung mehr.
  const month = now.getMonth() + 1; // 1-12
  const monthlyRotation = (schedule.monthlyRotation && schedule.monthlyRotation[month]) || [];

  // 2b. Pizza-Bonus: additiv, unabhängig vom Monats-Raster. Läuft eine
  // frische Fahrt-Erkennung (< 24h), wird pizza.html zusätzlich in die
  // heutige Rotation eingeschoben -- OHNE dass dafür irgendwer am
  // Monats-Raster etwas einstellen müsste. Fällt von selbst wieder
  // raus, sobald die 24h um sind.
  const withPizza = await maybeInsertPizzaWindow(env, monthlyRotation);

  // 2c. Genauso für interessante Flugzeuge (siehe Kommentar bei
  // maybeInsertFlightAlertWindow) -- additiv obendrauf.
  const rotation = await maybeInsertFlightAlertWindow(env, withPizza);

  if (!rotation.length) {
    // Für diesen Monat wurde nichts hinterlegt -- Wetter als
    // Fallback zeigen, statt mit einem Fehler auszufallen.
    return jsonResponse(
      {
        url: resolveUrl("weather.html"),
        source: "fallback",
        label: "Kein Zeitplan für diesen Monat hinterlegt",
        month,
        display: displayId,
      },
      200,
      request
    );
  }

  // 3. Deterministisch anhand der Uhrzeit den aktuellen Rotations-Slot
  // bestimmen -- so zeigen alle gleichzeitigen Aufrufe (z.B. Screenshot-
  // Workflow + manuelles Nachschauen in control.html) konsistent
  // dasselbe Fenster, ohne einen Zustand speichern zu müssen.
  const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
  const slotIndex = Math.floor(minutesSinceMidnight / schedule.rotationMinutes) % rotation.length;
  const current = rotation[slotIndex];

  return jsonResponse(
    {
      url: resolveUrl(current.url),
      source: "rotation",
      label: current.label,
      rotation: rotation.map((w) => w.label),
      slot: `${slotIndex + 1}/${rotation.length}`,
      month,
      monthName: MONTH_NAMES[month - 1],
      display: displayId,
    },
    200,
    request
  );
}

function resolveUrl(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return BASE_URL + pathOrUrl;
}

async function handleSetOverride(request, env) {
  requireKv(env);

  const url = new URL(request.url);
  const displayId = url.searchParams.get("display") || "display1";
  const target = url.searchParams.get("url");
  const label = url.searchParams.get("label") || target;
  const clear = url.searchParams.get("clear") === "1";

  if (clear) {
    await env.RUDI_KV.delete(`schedule:override:${displayId}`);
    return jsonResponse({ cleared: true, display: displayId }, 200, request);
  }

  if (!target) {
    return jsonResponse(
      { error: "Missing url parameter", example: "/route/override?url=weather.html&display=display1" },
      400,
      request
    );
  }

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" })
  );
  const todayIso = now.toISOString().slice(0, 10);

  await env.RUDI_KV.put(
    `schedule:override:${displayId}`,
    JSON.stringify({ date: todayIso, url: target, label })
  );

  return jsonResponse(
    { set: true, date: todayIso, url: resolveUrl(target), label, display: displayId },
    200,
    request
  );
}

async function handleGetSchedule(request, env) {
  requireKv(env);
  const schedule = (await env.RUDI_KV.get("schedule:config", "json")) || DEFAULT_SCHEDULE;
  return jsonResponse(schedule, 200, request);
}

async function handleSetSchedule(request, env) {
  requireKv(env);
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, request);
  }

  await env.RUDI_KV.put("schedule:config", JSON.stringify(body));
  return jsonResponse({ saved: true }, 200, request);
}

function requireKv(env) {
  if (!env.RUDI_KV) {
    throw new Error("KV binding RUDI_KV is not configured");
  }
}

/* =========================================================
   MONITORING FÜR R.U.D.I.

   Additiv. Prüft echte Erreichbarkeit der angebundenen Dienste (nicht
   nur "ist der Secret gesetzt"), und schickt bei Problemen eine
   Push-Benachrichtigung über ntfy.sh (kostenlos, kein Account nötig --
   einfach einen eigenen, schwer erratbaren Themen-Namen als
   NTFY_TOPIC-Secret hinterlegen und die ntfy-App/Website auf dieses
   Thema abonnieren).
   ========================================================= */

async function runHealthCheck(env) {
  const checks = {};

  checks.kv = { ok: Boolean(env.RUDI_KV) };

  // Paraglidable -- echter Live-Check, nicht nur "Key gesetzt"
  if (!env.PARAGLIDABLE_KEY) {
    checks.paraglidable = { ok: false, reason: "PARAGLIDABLE_KEY nicht gesetzt" };
  } else {
    try {
      const res = await fetch(
        `https://api.paraglidable.com/?key=${env.PARAGLIDABLE_KEY}&format=JSON&version=1`,
        { signal: AbortSignal.timeout(8000) }
      );
      checks.paraglidable = { ok: res.ok, status: res.status };
    } catch (error) {
      checks.paraglidable = { ok: false, reason: errorMessage(error) };
    }
  }

  // Holfuy -- ein Stellvertreter-Stationsaufruf reicht als Lebenszeichen
  if (!env.HOLFUY_KEY) {
    checks.holfuy = { ok: false, reason: "HOLFUY_KEY nicht gesetzt" };
  } else {
    try {
      const res = await fetch(
        `https://api.holfuy.com/live/?s=604&pw=${env.HOLFUY_KEY}&m=JSON`,
        { signal: AbortSignal.timeout(8000) }
      );
      checks.holfuy = { ok: res.ok, status: res.status };
    } catch (error) {
      checks.holfuy = { ok: false, reason: errorMessage(error) };
    }
  }

  checks.githubToken = { ok: Boolean(env.GITHUB_TOKEN) };

  // Open-Meteo -- keine Keys, aber trotzdem prüfen, da alle Wetter-/
  // Schneeseiten komplett davon abhängen
  try {
    const res = await fetch(
      "https://api.open-meteo.com/v1/forecast?latitude=47.7756&longitude=12.4550&hourly=temperature_2m",
      { signal: AbortSignal.timeout(8000) }
    );
    checks.openMeteo = { ok: res.ok, status: res.status };
  } catch (error) {
    checks.openMeteo = { ok: false, reason: errorMessage(error) };
  }

  // Route-System selbst -- wenn das kaputt ist, zeigt der Screenshot-
  // Workflow den Fallback statt der geplanten Seite
  let routeOk = false;
  try {
    if (env.RUDI_KV) {
      await env.RUDI_KV.get("schedule:config");
      routeOk = true;
    }
  } catch (error) {
    routeOk = false;
  }
  checks.routeSystem = { ok: routeOk };

  const allOk = Object.values(checks).every((c) => c.ok);

  return { ok: allOk, checks, timestamp: new Date().toISOString() };
}

async function healthResponse(request, env) {
  const result = await runHealthCheck(env);

  return jsonResponse(
    {
      ok: result.ok,
      service: "R.U.D.I. Worker Platform",
      version: WORKER_VERSION,
      timestamp: result.timestamp,
      checks: result.checks,
    },
    result.ok ? 200 : 503,
    request
  );
}

async function handleNtfyTest(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return jsonResponse({ error: "TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID ist nicht gesetzt (Cloudflare → rudi → Settings → Variables and secrets)" }, 400, request);
  }
  try {
    const response = await sendTelegram(env, {
      title: "R.U.D.I. Testnachricht",
      body: "Wenn du das siehst, funktioniert die Einrichtung.",
    });
    const responseBody = await response.text().catch(() => null);
    return jsonResponse(
      { sent: response.ok, telegramStatus: response.status, telegramResponseBody: responseBody },
      response.ok ? 200 : 502, request
    );
  } catch (error) {
    return jsonResponse({ error: "Senden fehlgeschlagen", detail: errorMessage(error) }, 502, request);
  }
}

async function sendAlertIfUnhealthy(env, result) {
  if (result.ok) return;
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logEvent("healthcheck_failed_no_telegram", { checks: result.checks });
    return;
  }

  const failed = Object.entries(result.checks)
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => `${k}: ${v.reason || `HTTP ${v.status}` || "fehlgeschlagen"}`)
    .join("\n");

  try {
    await sendTelegram(env, {
      title: "R.U.D.I. Problem erkannt",
      body: `Folgende Dienste sind gerade gestört:\n\n${failed}`,
    });
  } catch (error) {
    logEvent("telegram_send_failed", { error: errorMessage(error) });
  }
}

function jsonResponse(payload, status, request, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Alle unsere Endpunkte liefern dynamische/aktuelle Daten -- kein
      // Endpunkt soll je vom Browser gecacht werden. Statt das an jeder
      // Aufrufstelle einzeln zu wiederholen, ist es hier der Standard.
      // Einzelne Aufrufe können es über extraHeaders weiterhin
      // überschreiben, falls je nötig.
      "Cache-Control": "no-store",
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowedOrigin = !origin
    ? "*"
    : CONFIG.allowedOrigins.has(origin)
      ? origin
      : "https://hmmrmnn.github.io";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // WICHTIG (Fix 04.09.2026): ohne Expose-Headers kann JavaScript im
    // Browser einen Header zwar in den Netzwerk-Entwicklertools sehen,
    // aber NICHT per fetch()/response.headers.get() auslesen -- auch
    // wenn der Header technisch in der Antwort steht. Nötig, damit
    // military-radar.html/display.html den echten Datenzeitstempel
    // anzeigen können statt nur "wann hat der Browser abgefragt".
    "Access-Control-Expose-Headers": "X-MARVIN-Fetched-At, X-MARVIN-Data-Age-Seconds",
    Vary: "Origin",
  };
}

function errorMessage(error) {
  if (error instanceof Error) {
    if (error.name === "AbortError") return "Upstream request timed out";
    return error.message;
  }
  return String(error);
}

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), ...fields }));
}
