"use strict";

/* =====================================================================
   R.U.D.I. iPhone-Ansicht -- Render-Module für alle 11 Screens.

   Jedes Modul holt sich die IDENTISCHEN Daten von den IDENTISCHEN
   Endpunkten wie die jeweilige Original-E-Ink-Seite (weather.html,
   traffic.html, ...), rendert sie aber komplett neu im Control-Design
   (siehe control.html: Zinc-Palette, JetBrains Mono/Inter, Panels mit
   Eckenklammern, Mono-Labels in Großbuchstaben) statt im starren
   800x480-E-Ink-Layout. Die Original-Dateien bleiben davon unberührt.

   API: SCREEN_MODULES[id] = { label, refreshMs, render(container) }
   render() gibt HTML zurück ODER schreibt direkt ins Element (bei
   Modulen mit Canvas/async Nachladen wie militär).
   ===================================================================== */

const RUDI_WORKER = "https://rudi.marvinradar.workers.dev";
const FLIGHTS_API = `${RUDI_WORKER}/flights`;

/* ---------------------------------------------------------------
   Gemeinsame Helfer -- identisch zu den mehrfach duplizierten
   Funktionen in den Original-Seiten, hier einmalig gebündelt.
   --------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function numericOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function radians(deg) { return (deg * Math.PI) / 180; }
function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat), lat2 = radians(b.lat);
  const v = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(v));
}
function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}
function fmtNum(value) { return Math.round(value).toLocaleString("de-DE"); }
function airlineIcaoFromCallsign(callsign) {
  const cs = String(callsign || "").trim().toUpperCase();
  const match = cs.match(/^([A-Z]{3})\d/);
  return match ? match[1] : null;
}
function windDirLabel(deg) {
  const dirs = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}
function windArrowFrom(deg) {
  // Pfeil zeigt in die Richtung, AUS der der Wind kommt (Wetterfahnen-Konvention).
  const arrows = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"];
  const idx = Math.round(((deg + 180) % 360) / 45) % 8;
  return arrows[idx];
}
function trackArrow(track) {
  if (track === null) return "–";
  const arrows = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
  return arrows[Math.round(track / 45) % 8];
}
function cityOnly(value) {
  if (!value) return null;
  const text = String(value).trim()
    .replace(/\s+International Airport$/i, "").replace(/\s+Airport$/i, "").replace(/\s+International$/i, "").trim();
  return text.includes(",") ? text.split(",")[0].trim() : text;
}
function extractFirst(...values) {
  for (const v of values) if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  return null;
}

function normalizeAircraft(raw) {
  const lat = Number(raw.lat), lon = Number(raw.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const altBaro = raw.alt_baro;
  const altitude = altBaro === "ground" ? 0 : numericOrNull(altBaro ?? raw.alt_geom);
  return {
    lat, lon,
    callsign: String(raw.flight || "").trim() || null,
    registration: String(raw.r || "").trim() || null,
    type: String(raw.t || "").trim() || null,
    operator: raw.ownOp ? String(raw.ownOp).trim() : null,
    altitude,
    speed: numericOrNull(raw.gs),
    verticalRate: numericOrNull(raw.baro_rate ?? raw.geom_rate),
    track: numericOrNull(raw.track ?? raw.true_heading ?? raw.mag_heading),
    isMilitary: Boolean(Number(raw.dbFlags) & 1),
    isSpecial: Boolean(raw.isSpecial),
    hex: String(raw.hex || "").replace(/^~/, ""),
  };
}

// Kleines "Sticker" (heller Kachel-Hintergrund) hinter Logos/Silhouetten
// -- die stammen von externen Quellen mit unbekannter Transparenz-
// Erwartung (mal hell, mal dunkel gedacht); ein fester heller Untergrund
// macht das Ergebnis unabhängig davon immer lesbar, statt sie wie zuvor
// nur unverändert auf E-Ink-Weiß zu betten.
function thumbHtml(item, { silhouetteOnly = false } = {}) {
  const airlineIcao = airlineIcaoFromCallsign(item.callsign);
  const effectiveIcao = item.isMilitary || silhouetteOnly ? null : airlineIcao;
  if (effectiveIcao) {
    const url = `${FLIGHTS_API}/airline-logo?icao=${encodeURIComponent(effectiveIcao)}&variant=tail`;
    return `<div class="thumb-box"><img src="${escapeHtml(url)}" alt="" loading="lazy"
      onerror="this.parentElement.innerHTML='<span class=&quot;thumb-fallback&quot;>${escapeHtml(item.type || "?")}</span>'" /></div>`;
  }
  if (item.type) {
    const url = `${RUDI_WORKER}/flights/silhouette?type=${encodeURIComponent(item.type)}`;
    return `<div class="thumb-box"><img src="${escapeHtml(url)}" alt="" loading="lazy"
      onerror="this.parentElement.innerHTML='<span class=&quot;thumb-fallback&quot;>${escapeHtml(item.type)}</span>'" /></div>`;
  }
  return `<div class="thumb-box"><span class="thumb-fallback">?</span></div>`;
}

function starHtml(isSpecial) {
  return isSpecial ? `<span class="star">★</span>` : "";
}

const POSITIONS = {
  grassau: { lat: 47.7756389, lon: 12.4551944, label: "Grassau" },
  ismaning: { lat: 48.226, lon: 11.674, label: "Ismaning" },
};

// Kleiner Positions-Umschalter (Grassau/Ismaning), wiederverwendet von
// traffic/military -- identische Auswahl wie in den Original-
// Seiten, nur als Segmented-Control statt <select> fürs Fingertippen.
function positionSwitcherHtml(activeKey, name) {
  return `
    <div class="seg" data-seg="${name}">
      ${Object.entries(POSITIONS).map(([key, pos]) => `
        <button class="seg-btn ${key === activeKey ? "active" : ""}" data-seg-value="${key}">${escapeHtml(pos.label)}</button>
      `).join("")}
    </div>
  `;
}
function bindPositionSwitcher(container, name, onChange) {
  container.querySelectorAll(`.seg[data-seg="${name}"] .seg-btn`).forEach((btn) => {
    btn.addEventListener("click", () => onChange(btn.dataset.segValue));
  });
}

/* =====================================================================
   1. WETTER & FAMILIE
   ===================================================================== */

const weatherModule = {
  label: "Wetter & Familie",
  refreshMs: 30 * 60000,
  async render(el) {
    const LOCATION = { lat: 47.7756, lon: 12.4550 };
    const WEATHER_LABELS = {
      0: "Klar", 1: "Überw. klar", 2: "Teilw. bewölkt", 3: "Bedeckt",
      45: "Nebel", 48: "Reifnebel", 51: "Nieselregen", 53: "Nieselregen", 55: "Nieselregen",
      61: "Regen", 63: "Regen", 65: "Regen", 71: "Schnee", 73: "Schnee", 75: "Schnee",
      80: "Schauer", 81: "Schauer", 82: "Schauer", 95: "Gewitter", 96: "Gewitter", 99: "Gewitter",
    };
    const weatherLabel = (code) => WEATHER_LABELS[Number(code)] || "Unbekannt";

    const RECIPE_IDEAS = [
      { name: "Tomatensuppe", desc: "Tomaten, Zwiebel, etwas Sahne, fein püriert" },
      { name: "Bolognese", desc: "Faschiertes, Tomaten, Gemüse fein gehackt, mit Nudeln" },
      { name: "Kürbissuppe", desc: "Kürbis, Kartoffel, etwas Kokosmilch, cremig püriert" },
      { name: "Brokkoli-Käse-Suppe", desc: "Brokkoli, Kartoffel, milder Käse, sämig" },
      { name: "Käse-Spätzle", desc: "Spätzleteig, mit Käse untergehoben" },
      { name: "Milchreis", desc: "Rundkornreis, Milch, leicht gesüßt, mit Zimt" },
      { name: "Gemüse-Risotto", desc: "Reis, buntes Gemüse fein gewürfelt, cremig gegart" },
      { name: "Linsen-Curry (mild)", desc: "Rote Linsen, Kokosmilch, ohne Schärfe" },
      { name: "Hackbällchen in Tomatensauce", desc: "Kleine Bällchen, milde Sauce, dazu Kartoffelpüree" },
      { name: "Ofengemüse-Sticks", desc: "Karotte, Zucchini, Süßkartoffel, weich im Ofen gegart" },
      { name: "Gemüse-Frikadellen", desc: "Karotte, Zucchini, Haferflocken, in der Pfanne gebraten" },
      { name: "Apfelmus", desc: "Äpfel weich gegart, fein püriert, ohne Zuckerzusatz" },
      { name: "Grießbrei", desc: "Milch, Grieß, mild gesüßt, mit Fruchtmus" },
      { name: "Blumenkohl-Käse-Auflauf", desc: "Blumenkohl gegart, milde Käsesauce, überbacken" },
      { name: "Gemüse-Couscous", desc: "Couscous, fein gewürfeltes Gemüse, mild gewürzt" },
      { name: "Pfannkuchen", desc: "Dünner Teig, in der Pfanne gebacken, mit Apfelmus" },
      { name: "Vollkorn-Pizza mit Gemüse", desc: "Teig, mildem Belag, im Ofen überbacken" },
      { name: "Süßkartoffel-Püree", desc: "Süßkartoffel, etwas Butter, cremig gestämpft" },
      { name: "Zucchini-Puffer", desc: "Zucchini fein geraspelt, in der Pfanne goldbraun gebraten" },
      { name: "Kartoffel-Möhren-Eintopf", desc: "Kartoffel, Karotte, mild gewürzt, stückig oder püriert" },
      { name: "Hähnchen-Gemüse-Auflauf", desc: "Zartes Hähnchen, Brokkoli, wenig Käse überbacken" },
      { name: "Blumenkohlsuppe", desc: "Blumenkohl, Kartoffel, etwas Muskat, fein püriert" },
      { name: "Süßkartoffelsuppe", desc: "Süßkartoffel, Karotte, mild gewürzt" },
      { name: "Spinat-Kartoffel-Suppe", desc: "Blattspinat, Kartoffel, etwas Sahne, fein püriert" },
      { name: "Maissuppe", desc: "Mais, Kartoffel, etwas Sahne, leicht süßlich" },
      { name: "Tomaten-Käse-Nudeln", desc: "Nudeln, milde Tomatensauce, geriebener Käse" },
      { name: "Frühstücksmuffins herzhaft", desc: "Ei, Gemüse, wenig Käse, im Muffinblech gebacken" },
      { name: "Hirsebrei", desc: "Hirse, Milch, mild gesüßt, mit Obst" },
      { name: "Polenta mit Gemüse", desc: "Maisgrieß cremig gekocht, mit weichem Gemüse" },
      { name: "Fischstäbchen selbstgemacht", desc: "Fisch, milde Panade, im Ofen statt frittiert" },
      { name: "Kichererbsenbratlinge", desc: "Kichererbsen, Karotte, mild gewürzt, gebraten" },
      { name: "Kartoffelpuffer", desc: "Kartoffel fein geraspelt, in der Pfanne goldbraun" },
      { name: "Ofen-Gemüsepuffer", desc: "Buntes Gemüse, Haferflocken, im Ofen statt in Fett gebacken" },
      { name: "Bananen-Hafer-Pfannkuchen", desc: "Nur Banane, Ei, Haferflocken, ohne Zuckerzusatz" },
      { name: "Vollkorn-Brötchen", desc: "Einfacher Teig, als kleine Portionen gebacken" },
      { name: "Birnen-Kompott", desc: "Birnen weich gegart, leicht gesüßt, mit Zimt" },
      { name: "Vanillepudding", desc: "Milch, Vanille, hausgemacht statt Fertigpulver" },
      { name: "Hausgemachte Tomatensauce", desc: "Tomaten, Zwiebel, Karotte, fein püriert, als Basis" },
      { name: "Gemüse-Muffins süß", desc: "Karotte oder Zucchini im Teig versteckt, mild gesüßt" },
      { name: "Mini-Gemüse-Quiche", desc: "Mürbteig, mit mildem Gemüse-Belag, im Ofen gebacken" },
    ];

    function deriveActivities(tempMax, precipSum, weathercode) {
      const isRainy = precipSum > 1 || [51,53,55,61,63,65,80,81,82,95,96,99].includes(weathercode);
      const isSnowy = [71,73,75].includes(weathercode) || tempMax < 1;
      const isHot = tempMax >= 24;
      const isNice = !isRainy && tempMax >= 12;
      if (isSnowy) return ["Schlitten fahren", "Schneemann bauen", "Kakao-Pause danach"];
      if (isRainy) return ["Indoor-Spielplatz", "Backen zusammen", "Bastelnachmittag"];
      if (isHot) return ["Freibad / Planschbecken", "Wasserspiele im Garten", "Schatten-Spielplatz vormittags"];
      if (isNice) return ["Spielplatz-Besuch", "Spaziergang / kleine Wanderung", "Fahrrad/Laufrad üben"];
      return ["Kurzer Spaziergang zwischendurch", "Spielplatz, wenn's trocken bleibt", "Bastel-/Spielenachmittag"];
    }
    function dayOfYear(date) {
      const start = new Date(date.getFullYear(), 0, 0);
      return Math.floor((date - start) / 86400000);
    }

    const params = new URLSearchParams({
      latitude: String(LOCATION.lat), longitude: String(LOCATION.lon),
      hourly: "temperature_2m",
      daily: ["temperature_2m_max", "temperature_2m_min", "uv_index_max", "sunrise", "sunset", "precipitation_sum", "windspeed_10m_max", "weathercode"].join(","),
      timezone: "Europe/Berlin", forecast_days: "6",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
    const data = await res.json();
    const { daily, hourly } = data;

    const now = new Date();
    const tMax = Math.round(daily.temperature_2m_max[0]);
    const tMin = Math.round(daily.temperature_2m_min[0]);
    const uvMax = daily.uv_index_max[0];
    const precipSum = daily.precipitation_sum[0];
    const windMax = Math.round(daily.windspeed_10m_max[0]);
    const sunrise = fmtTime(daily.sunrise[0]);
    const sunset = fmtTime(daily.sunset[0]);
    const weathercode = daily.weathercode[0];
    const nowIsoHour = now.toISOString().slice(0, 13);
    let liveIdx = hourly.time.findIndex((t) => t.startsWith(nowIsoHour));
    if (liveIdx < 0) liveIdx = 12;
    const tLive = Math.round(hourly.temperature_2m[liveIdx]);

    const outlookDays = [1, 2, 3, 4, 5].map((i) => {
      const d = new Date(daily.time[i] + "T12:00:00");
      return {
        name: d.toLocaleDateString("de-DE", { weekday: "short" }).toUpperCase(),
        cond: weatherLabel(daily.weathercode[i]),
        tMax: Math.round(daily.temperature_2m_max[i]),
      };
    });

    const activities = deriveActivities(tMax, precipSum, weathercode);
    const doy = dayOfYear(now);
    const n = RECIPE_IDEAS.length;
    const recipes = [doy % n, (doy + Math.floor(n / 3)) % n, (doy + Math.floor((2 * n) / 3)) % n].map((i) => RECIPE_IDEAS[i]);
    const needsJacket = tMax < 15 || precipSum > 0.5;
    const needsSunscreen = uvMax >= 4;

    el.innerHTML = `
      <div class="panel">
        <p class="label">Jetzt in Grassau</p>
        <div class="stat-row">
          <div class="stat-tile stat-tile--wide">
            <div class="stat-value">${tLive}°</div>
            <div class="stat-caption">${weatherLabel(weathercode)} &middot; ${tMin}°&ndash;${tMax}°C heute</div>
          </div>
        </div>
        <div class="kv-list" style="margin-top:12px;">
          <div class="kv"><span class="k">UV-Index</span><span class="v">${uvMax.toFixed(1)}</span></div>
          <div class="kv"><span class="k">Regen</span><span class="v">${precipSum.toFixed(1)} mm</span></div>
          <div class="kv"><span class="k">Wind max.</span><span class="v">${windMax} km/h</span></div>
          <div class="kv"><span class="k">Sonne auf / unter</span><span class="v">${sunrise} / ${sunset}</span></div>
        </div>
      </div>

      <div class="panel">
        <p class="label">5-Tage-Ausblick</p>
        <div class="chip-row">
          ${outlookDays.map((d) => `
            <div class="chip">
              <div class="chip-top">${d.name}</div>
              <div class="chip-value">${d.tMax}°</div>
              <div class="chip-sub">${d.cond}</div>
            </div>
          `).join("")}
        </div>
        <div class="kv-list" style="margin-top:12px;">
          <div class="kv"><span class="k">Kleidung</span><span class="v">${needsJacket ? "Jacke mitnehmen" : "Leicht reicht"}</span></div>
          <div class="kv"><span class="k">Sonnenschutz</span><span class="v">${needsSunscreen ? "Nötig" : "Nicht nötig"}</span></div>
        </div>
      </div>

      <div class="panel">
        <p class="label">Aktivitäten heute</p>
        <div class="kv-list">
          ${activities.map((a, i) => `<div class="kv"><span class="k">${i + 1}</span><span class="v" style="font-weight:400;">${escapeHtml(a)}</span></div>`).join("")}
        </div>
      </div>

      <div class="panel">
        <p class="label">Rezeptideen</p>
        <div class="stack-list">
          ${recipes.map((r) => `
            <div class="stack-item">
              <div class="stack-title">${escapeHtml(r.name)}</div>
              <div class="stack-sub">${escapeHtml(r.desc)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  },
};

/* =====================================================================
   2. WETTERWARNUNG
   ===================================================================== */

const warningsModule = {
  label: "Wetterwarnung",
  refreshMs: 15 * 60000,
  async render(el) {
    const SEVERITY_MAP = {
      Minor: { level: 1, label: "Stufe 1 · Wetterwarnung" },
      Moderate: { level: 2, label: "Stufe 2 · Markante Warnung" },
      Severe: { level: 3, label: "Stufe 3 · Unwetterwarnung" },
      Extreme: { level: 4, label: "Stufe 4 · Extreme Warnung" },
    };
    function formatRange(onsetMs, expiresMs) {
      const opts = { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" };
      const onset = onsetMs ? new Date(Number(onsetMs)).toLocaleString("de-DE", opts) : "?";
      const expires = expiresMs ? new Date(Number(expiresMs)).toLocaleString("de-DE", opts) : "?";
      return `${onset} bis ${expires} Uhr`;
    }

    const res = await fetch(`${RUDI_WORKER}/warnings/traunstein`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.warnings || !data.warnings.length) {
      el.innerHTML = `
        <div class="panel empty-panel">
          <div class="empty-mark">✓</div>
          <p class="empty-title">Keine Warnungen</p>
          <p class="empty-sub">Landkreis Traunstein &middot; Quelle: DWD</p>
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="panel">
        <p class="label">Landkreis Traunstein &middot; ${data.count ?? data.warnings.length} aktive Warnung(en)</p>
        <div class="stack-list">
          ${data.warnings.map((w) => {
            const sev = SEVERITY_MAP[w.severity] || { level: 0, label: w.severity || "Unbekannt" };
            return `
              <div class="stack-item stack-item--level${sev.level}">
                <div class="stack-item-top">
                  <span class="stack-title">${escapeHtml(w.event || "Warnung")}</span>
                  <span class="badge badge--level${sev.level}">${escapeHtml(sev.label)}</span>
                </div>
                <p class="stack-sub">${escapeHtml(w.headline || "")}</p>
                <p class="stack-meta">${formatRange(w.onset, w.expires)}</p>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  },
};

/* =====================================================================
   3. FLUGLISTE
   ===================================================================== */

const trafficModule = {
  label: "Flugliste",
  refreshMs: 5 * 60000,
  state: { sortKey: "grassau" },
  async render(el) {
    const refPoint = POSITIONS[this.state.sortKey];
    const res = await fetch(`${FLIGHTS_API}/aircraft`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const shortlist = (Array.isArray(payload.ac) ? payload.ac : [])
      .map(normalizeAircraft).filter(Boolean)
      .filter((a) => a.altitude !== 0 && a.callsign)
      .map((a) => ({ ...a, sortDistanceKm: haversineKm(refPoint, a) }))
      .sort((a, b) => a.sortDistanceKm - b.sortDistanceKm)
      .slice(0, 8);

    const aircraft = await Promise.all(shortlist.map(async (item) => {
      let destinationCity = null;
      try {
        const r = await fetch(`${FLIGHTS_API}/route?callsign=${encodeURIComponent(item.callsign)}`, { headers: { Accept: "application/json" } });
        if (r.ok) {
          const d = await r.json();
          const route = d?.route || null;
          destinationCity = route ? cityOnly(extractFirst(route?.destination?.municipality, route?.arrival?.municipality, route?.destination?.name, route?.arrival?.name)) : null;
        }
      } catch (error) { /* Zielort optional -- Zeile bleibt trotzdem nützlich */ }
      return { ...item, destinationCity };
    }));

    const rows = aircraft.length ? aircraft.map((item) => {
      const altitudeM = item.altitude !== null ? Math.round(item.altitude * 0.3048) : null;
      const speedKmh = item.speed !== null ? Math.round(item.speed * 1.852) : null;
      const idLine = item.callsign || item.registration || "—";
      const typeLine = [item.type, item.registration].filter(Boolean).join(" · ") || "Typ unbekannt";
      return `
        <div class="flight-card">
          ${thumbHtml(item)}
          <div class="flight-card-body">
            <div class="flight-card-top">
              <span class="flight-id">${escapeHtml(idLine)}</span>
              ${starHtml(item.isSpecial)}
            </div>
            <div class="flight-meta">${escapeHtml(typeLine)}</div>
            <div class="flight-stats">
              <span>${altitudeM !== null ? fmtNum(altitudeM) + " M" : "–"}</span>
              <span>${speedKmh !== null ? speedKmh + " KM/H" : "–"}</span>
              <span>${trackArrow(item.track)} ${item.track !== null ? Math.round(item.track).toString().padStart(3, "0") : "---"}</span>
            </div>
          </div>
          <div class="flight-dest">
            <div class="flight-dest-city">${escapeHtml(item.destinationCity || "–")}</div>
            <div class="flight-dest-label">${item.destinationCity ? "ZIEL" : "unbekannt"}</div>
          </div>
        </div>
      `;
    }).join("") : `<div class="empty-panel"><p class="empty-sub">No aircraft in range.</p></div>`;

    el.innerHTML = `
      <div class="panel">
        <div class="panel-head-row">
          <p class="label" style="margin:0;">Alle Bewegungen im Umkreis</p>
          ${positionSwitcherHtml(this.state.sortKey, "traffic")}
        </div>
        <div class="stack-list" style="margin-top:10px;">${rows}</div>
        <p class="panel-foot">${aircraft.length} of ${payload.total ?? "?"} tracked &middot; sortiert nach ${refPoint.label}</p>
      </div>
    `;
    bindPositionSwitcher(el, "traffic", (key) => { this.state.sortKey = key; this.render(el); });
  },
};

/* =====================================================================
   4. FLUGRADAR (A.L.V.I.N.)
   ===================================================================== */

const alvinModule = {
  label: "Flugradar",
  refreshMs: 5 * 60000,
  async render(el) {
    const FLYING_BULLS_REGISTRATIONS = new Set([
      "OE-CKW", "OE-ADM", "OE-AMM", "F-AYSB", "N991DM", "OE-EDM", "OE-EAS",
      "OE-LDM", "N996DM", "OE-ARN", "OE-ARO", "N50429", "N68RW", "N25Y",
      "N6123C", "OE-EFB", "F-AZSB", "OE-EMM", "OE-ERB", "OE-FSE", "OE-EMD",
      "OE-FAS", "OE-FRB", "OE-FDM", "D-ICDM", "OE-XTV", "N11FX", "OE-XDM",
      "OE-XSY", "D-HSDM", "D-HTDM", "D-HUDM", "OE-XFB", "N69KL",
    ]);
    const TYPE_MAP = {
      A318: "Airbus A318-100", A319: "Airbus A319-100", A320: "Airbus A320-200", A321: "Airbus A321-100/200",
      A20N: "Airbus A320neo", A21N: "Airbus A321neo", A332: "Airbus A330-200", A333: "Airbus A330-300",
      A339: "Airbus A330-900neo", A359: "Airbus A350-900", A35K: "Airbus A350-1000", A388: "Airbus A380-800",
      B737: "Boeing 737-700", B738: "Boeing 737-800", B739: "Boeing 737-900", B38M: "Boeing 737 MAX 8",
      B39M: "Boeing 737 MAX 9", B744: "Boeing 747-400", B748: "Boeing 747-8", B752: "Boeing 757-200",
      B763: "Boeing 767-300", B772: "Boeing 777-200", B773: "Boeing 777-300", B77W: "Boeing 777-300ER",
      B788: "Boeing 787-8", B789: "Boeing 787-9", B78X: "Boeing 787-10", E190: "Embraer 190",
      E195: "Embraer 195", E290: "Embraer E190-E2", E295: "Embraer E195-E2", CRJ9: "Bombardier CRJ900",
      AT76: "ATR 72-600", DH8D: "De Havilland Dash 8-Q400",
    };
    const expandType = (code) => TYPE_MAP[String(code || "").trim().toUpperCase()] || code || "Unknown aircraft";
    function deriveFlightPhase(altM, vRate, remainingKm) {
      if (remainingKm !== null && remainingKm < 80 && altM !== null && altM < 3500) return "APPROACH";
      if (vRate !== null) { if (vRate > 500) return "CLIMB"; if (vRate < -500) return "DESCENT"; }
      return "CRUISE";
    }

    let LOCATION = { lat: 48.1547, lon: 11.5074, label: "München" };
    try {
      const r = await fetch(`${RUDI_WORKER}/location`);
      if (r.ok) LOCATION = await r.json();
    } catch (error) { /* Fallback bleibt bestehen */ }

    const res = await fetch(`${FLIGHTS_API}/aircraft`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const candidates = (Array.isArray(payload.ac) ? payload.ac : [])
      .map(normalizeAircraft).filter(Boolean)
      .filter((a) => a.altitude !== 0 && a.callsign)
      .map((a) => ({ ...a, distanceKm: haversineKm(LOCATION, a) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 12);

    const enriched = await Promise.all(candidates.map(async (item) => {
      try {
        const r = await fetch(`${FLIGHTS_API}/route?callsign=${encodeURIComponent(item.callsign)}`, { headers: { Accept: "application/json" } });
        if (!r.ok) return item;
        const data = await r.json();
        const route = data?.route || null;
        if (!route) return item;
        return {
          ...item,
          destinationCity: cityOnly(extractFirst(route?.destination?.municipality, route?.arrival?.municipality, route?.destination?.name, route?.arrival?.name)),
          operator: extractFirst(route?.airline?.name, item.operator),
        };
      } catch (error) { return item; }
    }));

    const withFlyingBulls = enriched.map((item) => {
      if (item.destinationCity || !FLYING_BULLS_REGISTRATIONS.has(item.registration)) return item;
      return { ...item, destinationCity: "THE FLYING BULLS", operator: "The Flying Bulls (Red Bull)" };
    });

    const aircraft = withFlyingBulls.filter((item) => item.destinationCity).slice(0, 6);

    const rows = aircraft.length ? aircraft.map((item) => {
      const altM = item.altitude !== null ? Math.round(item.altitude * 0.3048) : null;
      const speedKmh = item.speed !== null ? Math.round(item.speed * 1.852) : null;
      const flightLine = [item.operator, item.registration].filter(Boolean).join(" · ");
      const phase = deriveFlightPhase(altM, item.verticalRate, null);
      return `
        <div class="flight-card flight-card--tall">
          ${thumbHtml(item)}
          <div class="flight-card-body">
            <div class="flight-card-top"><span class="flight-id">${escapeHtml(expandType(item.type))}</span>${starHtml(item.isSpecial)}</div>
            <div class="flight-meta">${escapeHtml(flightLine)}</div>
            <div class="flight-meta" style="text-transform:uppercase; letter-spacing:0.04em;">${escapeHtml(item.destinationCity)}</div>
            <div class="flight-stats">
              ${altM !== null ? `<span>${fmtNum(altM)} M</span>` : ""}
              ${speedKmh !== null ? `<span>${fmtNum(speedKmh)} KM/H</span>` : ""}
              <span>${Math.round(item.track)}°</span>
              <span>${phase}</span>
            </div>
          </div>
        </div>
      `;
    }).join("") : `<div class="empty-panel"><p class="empty-sub">No airborne aircraft with route data nearby.</p></div>`;

    el.innerHTML = `
      <div class="panel">
        <p class="label">Live-Flugverfolgung &amp; Routeninfo &middot; ${escapeHtml(LOCATION.label)}</p>
        <div class="stack-list">${rows}</div>
      </div>
    `;
  },
};

/* =====================================================================
   5. MILITÄRFLUGZEUGE
   ===================================================================== */

const militaryModule = {
  label: "Militärflugzeuge",
  refreshMs: 5 * 60000,
  state: { posKey: "grassau" },
  async render(el) {
    const BAYER_4X4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

    function ditherImageToCanvas(img, canvas) {
      const tw = 160, th = 108;
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(tw / img.naturalWidth, th / img.naturalHeight);
      const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
      ctx.drawImage(img, (tw - dw) / 2, (th - dh) / 2, dw, dh);
      const imageData = ctx.getImageData(0, 0, tw, th);
      const data = imageData.data;
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const idx = (y * tw + x) * 4;
          let gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
          gray = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
          const threshold = ((BAYER_4X4[y % 4][x % 4] + 0.5) / 16) * 255;
          const value = gray > threshold ? 255 : 0;
          data[idx] = data[idx + 1] = data[idx + 2] = value;
          data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);
    }

    function renderSilhouette(container, type) {
      if (!type) { container.innerHTML = `<span class="thumb-fallback">NO PHOTO</span>`; return; }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const canvas = document.createElement("canvas");
        ditherImageToCanvas(img, canvas);
        container.innerHTML = "";
        container.appendChild(canvas);
      };
      img.onerror = () => { container.innerHTML = `<span class="thumb-fallback">${escapeHtml(type)}</span>`; };
      img.src = `${RUDI_WORKER}/flights/silhouette?type=${encodeURIComponent(type)}`;
    }

    async function renderPhotoFromUrl(container, url, type) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          ditherImageToCanvas(img, canvas);
          container.innerHTML = "";
          container.appendChild(canvas);
        } catch (error) { renderSilhouette(container, type); }
      };
      img.onerror = () => renderSilhouette(container, type);
      img.src = url;
    }

    function deriveFlightPhase(vRate) {
      if (vRate !== null) { if (vRate > 500) return "CLIMB"; if (vRate < -500) return "DESCENT"; }
      return "CRUISE";
    }

    const LOCATION = POSITIONS[this.state.posKey];

    const res = await fetch(`${FLIGHTS_API}/aircraft`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();

    const aircraft = (Array.isArray(payload.ac) ? payload.ac : [])
      .map(normalizeAircraft).filter(Boolean)
      .filter((a) => a.isMilitary && a.altitude !== 0 && a.callsign)
      .map((a) => ({ ...a, distanceKm: haversineKm(LOCATION, a) }))
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 6);

    if (!aircraft.length) {
      el.innerHTML = `
        <div class="panel">
          <div class="panel-head-row">
            <p class="label" style="margin:0;">Live-Erfassung &amp; Fotos</p>
            ${positionSwitcherHtml(this.state.posKey, "military")}
          </div>
        </div>
        <div class="empty-panel"><p class="empty-sub">Gerade keine Militärflugzeuge in der Nähe.</p></div>
      `;
      bindPositionSwitcher(el, "military", (key) => { this.state.posKey = key; this.render(el); });
      return;
    }

    el.innerHTML = `
      <div class="panel">
        <div class="panel-head-row">
          <p class="label" style="margin:0;">Live-Erfassung &amp; Fotos</p>
          ${positionSwitcherHtml(this.state.posKey, "military")}
        </div>
        <div class="stack-list">
          ${aircraft.map((item, i) => {
            const altM = item.altitude !== null ? Math.round(item.altitude * 0.3048) : null;
            const speedKmh = item.speed !== null ? Math.round(item.speed * 1.852) : null;
            const distance = `${fmtNum(Math.round(item.distanceKm))} km von ${LOCATION.label}`;
            return `
              <div class="flight-card flight-card--tall">
                <div class="thumb-box thumb-box--lg" id="mil-photo-${i}"><span class="thumb-fallback">LOADING</span></div>
                <div class="flight-card-body">
                  <div class="flight-card-top"><span class="flight-id" id="mil-type-${i}">${escapeHtml(item.type || "Identifiziere…")}</span></div>
                  <div class="flight-meta" id="mil-operator-${i}">${escapeHtml(item.operator || "Operator unbekannt")}</div>
                  <div class="flight-meta" id="mil-country-${i}"></div>
                  <div class="flight-meta">${escapeHtml(item.callsign)} · ${escapeHtml(item.registration || "—")}</div>
                  <div class="flight-stats">
                    ${altM !== null ? `<span>${fmtNum(altM)} M</span>` : ""}
                    ${speedKmh !== null ? `<span>${fmtNum(speedKmh)} KM/H</span>` : ""}
                    <span>${Math.round(item.track)}°</span>
                    <span>${deriveFlightPhase(item.verticalRate)}</span>
                  </div>
                  <div class="flight-meta">${distance}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
    bindPositionSwitcher(el, "military", (key) => { this.state.posKey = key; this.render(el); });

    const COUNTRY_NAMES = { DE: "Germany", GB: "United Kingdom", FR: "France", IT: "Italy", AT: "Austria", CH: "Switzerland", US: "United States", NL: "Netherlands", BE: "Belgium", PL: "Poland", ES: "Spain", CA: "Canada" };

    aircraft.forEach(async (item, i) => {
      const typeEl = el.querySelector(`#mil-type-${i}`);
      const operatorEl = el.querySelector(`#mil-operator-${i}`);
      const countryEl = el.querySelector(`#mil-country-${i}`);
      const photoEl = el.querySelector(`#mil-photo-${i}`);
      let photoUrl = null, typeCode = null;
      try {
        const params = new URLSearchParams();
        if (item.hex) params.set("icao", item.hex);
        if (item.callsign) params.set("callsign", item.callsign);
        if (item.registration) params.set("registration", item.registration);
        if (item.type) params.set("type", item.type);
        params.set("military", "1");
        const r = await fetch(`${RUDI_WORKER}/flights/identify?${params}`);
        if (!r.ok) throw new Error("identify failed");
        const data = await r.json();
        const x = data?.assessment;
        if (!x) throw new Error("no assessment");
        if (typeEl) typeEl.textContent = x.aircraftType || item.type || "Typ unbekannt";
        if (operatorEl) operatorEl.textContent = x.operator || item.operator || "Operator unbekannt";
        if (countryEl) countryEl.textContent = COUNTRY_NAMES[x.countryCode] || x.countryCode || "";
        typeCode = x.typeCode || null;
        photoUrl = x.photo?.thumbnailUrl || x.photo?.url || null;
      } catch (error) {
        if (typeEl) typeEl.textContent = item.type || "Typ unbekannt";
      }
      if (photoEl) {
        if (photoUrl) renderPhotoFromUrl(photoEl, photoUrl, item.type);
        else renderSilhouette(photoEl, typeCode || item.type);
      }
    });
  },
};

/* =====================================================================
   6. GLEITSCHIRM & SEGELFLUG
   ===================================================================== */

const paraglidingModule = {
  label: "Gleitschirm & Segelflug",
  refreshMs: 15 * 60000,
  async render(el) {
    const LOCATION = { lat: 47.7756, lon: 12.4550 };
    const FOEHN_SOUTH = { lat: 46.4983, lon: 11.3548 };

    function deriveFoehn(hourly, foehnData) {
      if (!foehnData?.hourly) return { label: "K.A.", hint: "Süd-Referenzdaten nicht verfügbar" };
      const nowIso = new Date().toISOString().slice(0, 13);
      let idxN = hourly.time.findIndex((t) => t.startsWith(nowIso));
      let idxS = foehnData.hourly.time.findIndex((t) => t.startsWith(nowIso));
      if (idxN < 0) idxN = 12; if (idxS < 0) idxS = 12;
      const pN = hourly.pressure_msl[idxN], pS = foehnData.hourly.pressure_msl[idxS];
      if (pN === undefined || pS === undefined) return { label: "K.A.", hint: "Druckdaten unvollständig" };
      const diff = pS - pN;
      if (diff >= 6) return { label: "DEUTET AUF FÖHN", hint: `Δp ${diff.toFixed(1)} hPa` };
      if (diff >= 3) return { label: "NICHT AUSZUSCHLIESSEN", hint: `Δp ${diff.toFixed(1)} hPa` };
      if (diff <= -3) return { label: "EHER NORDSTAU", hint: `Δp ${diff.toFixed(1)} hPa` };
      return { label: "KEIN HINWEIS", hint: `Δp ${diff.toFixed(1)} hPa` };
    }
    function ratingFromParaglidable(spots) {
      const bestFly = Math.max(...spots.map((s) => s.forecast.fly));
      const bestSpot = spots.find((s) => s.forecast.fly === bestFly);
      const bestXc = Math.max(...spots.map((s) => s.forecast.XC));
      return {
        label: bestFly >= 0.75 ? "GUT" : bestFly >= 0.4 ? "MÄSSIG" : "SCHLECHT",
        bestWindow: bestXc >= 0.3 ? `${bestSpot.name} (XC)` : bestSpot.name,
        shear: `${Math.round(bestFly * 100)}% Fly-Score`,
      };
    }

    const params = new URLSearchParams({
      latitude: String(LOCATION.lat), longitude: String(LOCATION.lon),
      hourly: ["windspeed_10m", "windspeed_80m", "winddirection_10m", "cloudcover", "pressure_msl"].join(","),
      daily: ["precipitation_sum", "windspeed_10m_max", "sunrise", "sunset"].join(","),
      timezone: "Europe/Berlin",
    });
    const foehnParams = new URLSearchParams({ latitude: String(FOEHN_SOUTH.lat), longitude: String(FOEHN_SOUTH.lon), hourly: "pressure_msl", timezone: "Europe/Berlin" });

    const [res, foehnRes, pgRes, holfuyRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { headers: { Accept: "application/json" } }),
      fetch(`https://api.open-meteo.com/v1/forecast?${foehnParams}`, { headers: { Accept: "application/json" } }).catch(() => null),
      fetch(`${RUDI_WORKER}/paraglidable`, { headers: { Accept: "application/json" } }).catch(() => null),
      fetch(`${RUDI_WORKER}/holfuy`, { headers: { Accept: "application/json" } }).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
    const data = await res.json();
    const foehnData = foehnRes?.ok ? await foehnRes.json() : null;
    const pgData = pgRes?.ok ? await pgRes.json() : null;
    const holfuyData = holfuyRes?.ok ? await holfuyRes.json() : null;

    const { daily, hourly } = data;
    const precipSum = daily.precipitation_sum[0];
    const windMax = Math.round(daily.windspeed_10m_max[0]);
    const sunrise = fmtTime(daily.sunrise[0]), sunset = fmtTime(daily.sunset[0]);
    const pgToday = pgData ? pgData[daily.time[0]] : null;
    const rating = pgToday?.length ? ratingFromParaglidable(pgToday) : { label: "K.A.", bestWindow: "–", shear: "–" };
    const foehn = deriveFoehn(hourly, foehnData);

    const holfuyRows = holfuyData?.stations?.filter((s) => !s.error && s.wind != null) || [];
    const pgRows = pgToday?.length ? pgToday : [];

    el.innerHTML = `
      <div class="panel">
        <p class="label">Flugtauglichkeit</p>
        <div class="stat-row">
          <div class="stat-tile stat-tile--wide"><div class="stat-value" style="font-size:26px;">${rating.label}</div><div class="stat-caption">Beste Zeit: ${rating.bestWindow}</div></div>
        </div>
        <div class="kv-list" style="margin-top:10px;">
          <div class="kv"><span class="k">Niederschlag</span><span class="v">${precipSum.toFixed(1)} mm</span></div>
          <div class="kv"><span class="k">Wind max.</span><span class="v">${windMax} km/h</span></div>
          <div class="kv"><span class="k">Sonne auf / unter</span><span class="v">${sunrise} / ${sunset}</span></div>
          <div class="kv"><span class="k">Föhn-Heuristik</span><span class="v">${foehn.label}</span></div>
        </div>
      </div>

      ${holfuyRows.length ? `
        <div class="panel">
          <p class="label">Startplätze &ndash; Live</p>
          <table class="data-table">
            <thead><tr><th>Startplatz</th><th>Wind</th><th>Böe</th><th>Richtung</th></tr></thead>
            <tbody>${holfuyRows.map((s) => `<tr><td>${escapeHtml(s.label)}</td><td>${s.wind ?? "-"} km/h</td><td>${s.gust ?? "-"} km/h</td><td>${s.direction != null ? Math.round(s.direction) + "°" : "-"}</td></tr>`).join("")}</tbody>
          </table>
        </div>
      ` : ""}

      ${pgRows.length ? `
        <div class="panel">
          <p class="label">Startplätze &ndash; heute</p>
          <table class="data-table">
            <thead><tr><th>Startplatz</th><th>Fly</th><th>XC</th><th>Start</th></tr></thead>
            <tbody>${pgRows.map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${Math.round(s.forecast.fly * 100)}%</td><td>${Math.round(s.forecast.XC * 100)}%</td><td>${Math.round(s.forecast.takeoff * 100)}%</td></tr>`).join("")}</tbody>
          </table>
        </div>
      ` : ""}

      <div class="panel">
        <p class="panel-foot" style="margin:0;">Fly/XC/Start: KI-Prognose paraglidable.com. Wind/Bewölkung: Open-Meteo. Kein Ersatz für eine offizielle Flugwetterberatung.</p>
      </div>
    `;
  },
};

/* =====================================================================
   7. GLEITSCHIRM LIVE
   ===================================================================== */

const paraglidersLiveModule = {
  label: "Gleitschirm Live",
  refreshMs: 5 * 60000,
  async render(el) {
    const res = await fetch(`${RUDI_WORKER}/paragliders`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || data.error) {
      el.innerHTML = `<div class="empty-panel"><p class="empty-sub">${escapeHtml(data.detail || data.reason || "OGN nicht erreichbar")}</p></div>`;
      return;
    }

    const pilots = data.pilots || [];
    function project(lat, lon, center, scale) {
      const kmPerDegLat = 111, kmPerDegLon = 111 * Math.cos((center.lat * Math.PI) / 180);
      return { x: (lon - center.lon) * kmPerDegLon * scale, y: -(lat - center.lat) * kmPerDegLat * scale };
    }
    function climbArrow(v) {
      if (v == null) return "–";
      if (v >= 1.5) return "↑↑"; if (v >= 0.3) return "↑";
      if (v <= -1.5) return "↓↓"; if (v <= -0.3) return "↓";
      return "→";
    }

    const W = 260, H = 220;
    const scale = (Math.min(W, H) / 2 - 16) / data.radiusKm;
    const center = data.center;
    let svg = `<svg viewBox="${-W / 2} ${-H / 2} ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    [5, 10, 15].forEach((km) => {
      if (km > data.radiusKm) return;
      svg += `<circle cx="0" cy="0" r="${km * scale}" fill="none" stroke="var(--ink-ghost)" stroke-width="1" stroke-dasharray="2 3" />`;
      svg += `<text x="4" y="${-km * scale - 3}" font-size="7" fill="var(--ink-faint)" font-family="var(--mono)">${km}km</text>`;
    });
    svg += `<circle cx="0" cy="0" r="4" fill="var(--ink)" />`;
    svg += `<text x="7" y="4" font-size="9" font-weight="700" fill="var(--ink-dim)" font-family="var(--sans)">${escapeHtml(center.label)}</text>`;
    (data.launchSites || []).forEach((site) => {
      const p = project(site.lat, site.lon, center, scale);
      if (Math.abs(p.x) > W / 2 || Math.abs(p.y) > H / 2) return;
      svg += `<path d="M${p.x} ${p.y - 6} L${p.x + 5} ${p.y + 4} L${p.x - 5} ${p.y + 4} Z" fill="none" stroke="var(--ink-faint)" stroke-width="1.5" />`;
    });
    pilots.forEach((pilot, i) => {
      const p = project(pilot.lat, pilot.lon, center, scale);
      svg += `<circle cx="${p.x}" cy="${p.y}" r="8" fill="var(--ink)" stroke="var(--bg)" stroke-width="1.5" />`;
      svg += `<text x="${p.x}" y="${p.y + 3}" font-size="8" font-weight="700" text-anchor="middle" fill="var(--bg)" font-family="var(--mono)">${i + 1}</text>`;
    });
    svg += `</svg>`;

    const list = pilots.length ? pilots.map((p, i) => `
      <div class="kv">
        <span class="k">${i + 1} · ${p.altitude != null ? p.altitude + " m" : "–"}</span>
        <span class="v">${climbArrow(p.climbRate)} ${p.climbRate != null ? p.climbRate.toFixed(1) + " m/s" : ""}</span>
      </div>
    `).join("") : "";

    el.innerHTML = `
      <div class="panel">
        <p class="label">${pilots.length ? `${pilots.length} Gleitschirm${pilots.length === 1 ? "" : "e"} in der Luft` : "Gerade niemand in der Luft"}</p>
        <div class="radar-box">${svg}</div>
      </div>
      ${pilots.length ? `<div class="panel"><p class="label">Piloten</p><div class="kv-list">${list}</div></div>` : ""}
      <div class="panel"><p class="panel-foot" style="margin:0;">Open Glider Network · ${data.radiusKm} km um Grassau</p></div>
    `;
  },
};

/* =====================================================================
   8. CHIEMSEE
   ===================================================================== */

const chiemseeModule = {
  label: "Chiemsee",
  refreshMs: 15 * 60000,
  async render(el) {
    function windRating(speedKmh, gustKmh) {
      if (gustKmh >= 35 || speedKmh >= 28) return { level: "low", text: "Zu stark zum Fahren" };
      if (speedKmh >= 16) return { level: "medium", text: "Gut für Geübte" };
      if (speedKmh >= 6) return { level: "high", text: "Gut geeignet (SUP & Segeln)" };
      return { level: "medium", text: "Sehr ruhig, kaum Wind" };
    }
    function compassLabel(deg) {
      const dirs = ["N", "NO", "O", "SO", "S", "SW", "W", "NW"];
      return dirs[Math.round((deg % 360) / 45) % 8];
    }

    const [currentRes, historyRes, windRes] = await Promise.all([
      fetch(`${RUDI_WORKER}/chiemsee/watertemp`, { headers: { Accept: "application/json" } }),
      fetch(`${RUDI_WORKER}/chiemsee/watertemp/history`, { headers: { Accept: "application/json" } }).catch(() => null),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=47.875&longitude=12.45&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant&timezone=Europe%2FBerlin&wind_speed_unit=kmh&forecast_days=5`),
    ]);
    if (!currentRes.ok) throw new Error(`HTTP ${currentRes.status}`);
    const waterData = await currentRes.json();
    const historyData = historyRes?.ok ? await historyRes.json() : null;
    const windData = windRes.ok ? await windRes.json() : null;

    const speed = windData ? Math.round(windData.current.wind_speed_10m) : null;
    const gust = windData ? Math.round(windData.current.wind_gusts_10m) : null;
    const dir = windData ? windData.current.wind_direction_10m : null;
    const rating = speed !== null ? windRating(speed, gust) : null;

    const outlookRows = windData ? windData.daily.time.map((dateStr, i) => {
      const dayLabel = new Date(dateStr).toLocaleDateString("de-DE", { weekday: "short" });
      const speedVal = Math.round(windData.daily.wind_speed_10m_max[i]);
      const maxSpeed = Math.max(...windData.daily.wind_speed_10m_max, 1);
      return { dayLabel, speedVal, pct: Math.round((speedVal / maxSpeed) * 100), dir: windDirLabel(windData.daily.wind_direction_10m_dominant[i]) };
    }) : [];

    el.innerHTML = `
      <div class="panel">
        <div class="stat-row">
          <div class="stat-tile">
            <div class="stat-label">Wassertemperatur</div>
            <div class="stat-value">${waterData.temperatureC.toFixed(1)}<span class="stat-unit">°C</span></div>
            <div class="stat-caption">Station ${escapeHtml(waterData.station)}</div>
          </div>
          ${speed !== null ? `
            <div class="stat-tile">
              <div class="stat-label">Wind jetzt</div>
              <div class="stat-value">${speed}<span class="stat-unit">km/h</span></div>
              <div class="stat-caption">Aus ${compassLabel(dir)} · Böen bis ${gust} km/h</div>
            </div>
          ` : ""}
        </div>
        ${rating ? `<div class="badge-row"><span class="badge badge--${rating.level}">${escapeHtml(rating.text)}</span></div>` : ""}
      </div>

      ${outlookRows.length ? `
        <div class="panel">
          <p class="label">5-Tage-Wind-Aussicht (Tagesmaximum)</p>
          <div class="bar-list">
            ${outlookRows.map((r) => `
              <div class="bar-row">
                <span class="bar-row-label">${escapeHtml(r.dayLabel)}</span>
                <div class="bar-row-track"><div class="bar-row-fill" style="width:${r.pct}%"></div></div>
                <span class="bar-row-value">${r.speedVal} km/h ${r.dir}</span>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <div class="panel"><p class="panel-foot" style="margin:0;">Wasser: GKD Bayern (Stock) · Wind: Open-Meteo</p></div>
    `;
  },
};

/* =====================================================================
   9. SCHNEEBERICHT
   ===================================================================== */

const snowModule = {
  label: "Schneebericht",
  refreshMs: 30 * 60000,
  async render(el) {
    const VALLEY = { name: "Grassau (Tal)", lat: 47.7756, lon: 12.4550, elevation: 540 };
    const RESORTS = [
      { name: "Hochfelln", lat: 47.7631, lon: 12.5606, elevation: 1674 },
      { name: "Kampenwand", lat: 47.7461, lon: 12.3567, elevation: 1669 },
      { name: "Winklmoos-Steinplatte", lat: 47.6690, lon: 12.4870, elevation: 1800, unclear: true },
      { name: "Unternberg", lat: 47.7333, lon: 12.6333, elevation: 1450, unclear: true },
    ];
    const ALL = [VALLEY, ...RESORTS];

    function extractPoint(d) {
      const hourly = d.hourly;
      const nowIso = new Date().toISOString().slice(0, 13);
      let idx = hourly.time.findIndex((t) => t.startsWith(nowIso));
      if (idx < 0) idx = 12;
      return {
        snowDepthCm: Math.round((hourly.snow_depth[idx] || 0) * 100),
        newSnow24hCm: Math.round(d.daily.snowfall_sum[0] || 0),
        freezingLevel: Math.round(hourly.freezinglevel_height[idx] || 0),
        wind: Math.round(hourly.windspeed_10m[idx] || 0),
        windDir: Math.round(hourly.winddirection_10m[idx] || 0),
        temp: Math.round(hourly.temperature_2m[idx]),
      };
    }

    const params = new URLSearchParams({
      latitude: ALL.map((r) => r.lat).join(","), longitude: ALL.map((r) => r.lon).join(","),
      hourly: ["snow_depth", "snowfall", "temperature_2m", "freezinglevel_height", "windspeed_10m", "winddirection_10m"].join(","),
      daily: ["temperature_2m_max", "temperature_2m_min", "snowfall_sum", "sunrise", "sunset"].join(","),
      timezone: "Europe/Berlin",
    });
    const [res, avalancheRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { headers: { Accept: "application/json" } }),
      fetch(`${RUDI_WORKER}/avalanche`, { headers: { Accept: "application/json" } }).catch(() => null),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.json();
    const dataArray = Array.isArray(arr) ? arr : [arr];
    const avalancheData = avalancheRes?.ok ? await avalancheRes.json() : null;

    const valleyData = extractPoint(dataArray[0]);
    const resortData = RESORTS.map((r, i) => ({ ...r, ...extractPoint(dataArray[i + 1]) }));
    const mainResort = resortData[0];
    const avgSnow = resortData.reduce((s, r) => s + r.snowDepthCm, 0) / resortData.length;
    const rating = avgSnow >= 40 ? "GUT" : avgSnow >= 15 ? "MÄSSIG" : "SCHLECHT";
    const avalancheLabel = avalancheData?.available && avalancheData?.dangerLevel
      ? `STUFE ${avalancheData.dangerLevel}` : avalancheData?.reason?.includes("Saison") ? "SAISON BEENDET" : "SIEHE LWD BAYERN";

    el.innerHTML = `
      <div class="panel">
        <div class="stat-row">
          <div class="stat-tile"><div class="stat-label">Tal (${VALLEY.elevation}m)</div><div class="stat-value">${valleyData.snowDepthCm}<span class="stat-unit">cm</span></div></div>
          <div class="stat-tile"><div class="stat-label">Berg (${mainResort.elevation}m)</div><div class="stat-value">${mainResort.snowDepthCm}<span class="stat-unit">cm</span></div></div>
        </div>
        <div class="kv-list" style="margin-top:10px;">
          <div class="kv"><span class="k">Neuschnee Berg 24h</span><span class="v">+${mainResort.newSnow24hCm} cm</span></div>
          <div class="kv"><span class="k">Temp Tal / Berg</span><span class="v">${valleyData.temp}° / ${mainResort.temp}°C</span></div>
          <div class="kv"><span class="k">Frostgrenze</span><span class="v">${mainResort.freezingLevel} m</span></div>
          <div class="kv"><span class="k">Lawinenwarnstufe (West)</span><span class="v">${avalancheLabel}</span></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head-row"><p class="label" style="margin:0;">Skigebiete Chiemgau</p><span class="badge">${rating}</span></div>
        <table class="data-table">
          <thead><tr><th>Gebiet</th><th>Gipfel</th><th>Schnee</th><th>Neu</th><th>Wind</th></tr></thead>
          <tbody>
            ${resortData.map((r) => `<tr><td>${escapeHtml(r.name)}${r.unclear ? " *" : ""}</td><td>${r.elevation} m</td><td>${r.snowDepthCm} cm</td><td>+${r.newSnow24hCm} cm</td><td>${r.wind} km/h ${windDirLabel(r.windDir)}</td></tr>`).join("")}
          </tbody>
        </table>
        <p class="panel-foot">* Zuordnung zur Lawinenregion nicht verifiziert &ndash; Warnstufe gilt nachweislich NICHT für diese Gebiete. Vor jeder Tour lawinenwarndienst.bayern.de prüfen.</p>
      </div>
    `;
  },
};

/* =====================================================================
   10. TRAINING
   ===================================================================== */

const trainingModule = {
  label: "Training",
  refreshMs: 30 * 60000,
  async render(el) {
    function formatDuration(minutes) {
      if (!minutes) return "–";
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return h > 0 ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
    }
    function yearProgressPercent() {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
      const start = new Date(now.getFullYear(), 0, 1), end = new Date(now.getFullYear() + 1, 0, 1);
      return ((now - start) / (end - start)) * 100;
    }
    function sparkline(values, width, height) {
      if (!values || values.length < 2) return "";
      const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
      const step = width / (values.length - 1);
      const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(" ");
      return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><polyline points="${points}" fill="none" stroke="var(--ink)" stroke-width="1.5" /></svg>`;
    }
    function formLabel(form) {
      if (form == null) return "";
      if (form > 15) return "sehr frisch"; if (form > 5) return "frisch";
      if (form >= -10) return "ausgeglichen"; if (form >= -25) return "belastet";
      return "stark belastet";
    }
    function formatDate(iso) {
      if (!iso) return "";
      return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { day: "2-digit", month: "short", timeZone: "Europe/Berlin" });
    }
    function weekdayShort(iso) {
      if (!iso) return "";
      return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "short", timeZone: "Europe/Berlin" });
    }

    const res = await fetch(`${RUDI_WORKER}/training`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || data.error) {
      el.innerHTML = `<div class="empty-panel"><p class="empty-sub">${escapeHtml(data.detail || "Keine Daten")}</p></div>`;
      return;
    }

    const goalKm = data.goalKm || 0, yearKm = data.year.km || 0;
    const pct = goalKm ? Math.min((yearKm / goalKm) * 100, 100) : 0;
    const targetPct = yearProgressPercent();
    const remaining = Math.max(goalKm - yearKm, 0);
    const w = data.wellness, p = data.power;

    el.innerHTML = `
      <div class="panel">
        <p class="label">Bilanz</p>
        <div class="stat-row">
          <div class="stat-tile"><div class="stat-label">Diese Woche</div><div class="stat-value">${data.week.km}<span class="stat-unit">km</span></div><div class="stat-caption">${data.week.elevation} hm · ${data.week.count} Fahrten</div></div>
          <div class="stat-tile"><div class="stat-label">Diesen Monat</div><div class="stat-value">${data.month.km}<span class="stat-unit">km</span></div><div class="stat-caption">${data.month.elevation} hm · ${data.month.count} Fahrten</div></div>
          <div class="stat-tile"><div class="stat-label">Dieses Jahr</div><div class="stat-value">${data.year.km}<span class="stat-unit">km</span></div><div class="stat-caption">${data.year.elevation} hm · ${data.year.count} Fahrten</div></div>
        </div>
      </div>

      <div class="panel">
        <p class="label">Jahresziel</p>
        <div class="goal-head"><span><strong>${yearKm}</strong> von ${goalKm} km</span><span>${Math.round(pct)}%</span></div>
        <div class="bar-wrap"><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div class="bar-target" style="left:${targetPct}%"></div></div>
        <p class="panel-foot">Noch ${remaining} km · Marke = Soll zum heutigen Tag (${Math.round(targetPct)}%)</p>
      </div>

      <div class="panel-row">
        <div class="panel panel--half">
          <p class="label">Form</p>
          ${w ? `
            <div class="stat-value" style="font-size:22px;">${w.form > 0 ? "+" : ""}${w.form ?? "–"}</div>
            <div class="stat-caption">${formLabel(w.form)}</div>
            <div class="kv-list" style="margin-top:8px;">
              <div class="kv"><span class="k">Fitness (CTL)</span><span class="v">${w.fitness ?? "–"}</span></div>
              <div class="kv"><span class="k">Ermüdung (ATL)</span><span class="v">${w.fatigue ?? "–"}</span></div>
            </div>
            <div style="margin-top:8px;">${sparkline(w.history, 200, 26)}</div>
          ` : `<p class="empty-sub">Keine Wellness-Daten</p>`}
        </div>
        <div class="panel panel--half">
          <p class="label">Leistung</p>
          ${p ? `
            <div class="kv-list">
              ${p.eftp != null ? `<div class="kv"><span class="k">eFTP</span><span class="v">${p.eftp} W</span></div>` : ""}
              ${p.bestWatts != null ? `<div class="kv"><span class="k">Beste NP</span><span class="v">${p.bestWatts} W</span></div>` : ""}
              ${p.longestRideKm != null ? `<div class="kv"><span class="k">Längste Fahrt</span><span class="v">${p.longestRideKm} km</span></div>` : ""}
            </div>
          ` : `<p class="empty-sub">Keine Leistungsdaten</p>`}
        </div>
      </div>

      <div class="panel">
        <p class="label">Letzte Fahrten</p>
        ${(data.recent || []).length ? `
          <div class="stack-list">
            ${data.recent.map((r) => `
              <div class="kv">
                <span class="k">${weekdayShort(r.date)}, ${formatDate(r.date)} · ${r.elevation} hm · ${formatDuration(r.minutes)}</span>
                <span class="v">${r.km} km${r.speed != null ? ` · ${r.speed} km/h` : ""}</span>
              </div>
            `).join("")}
          </div>
        ` : `<p class="empty-sub">Noch keine Fahrten erfasst</p>`}
      </div>
    `;
  },
};

/* =====================================================================
   11. PIZZA-BILANZ
   ===================================================================== */

const pizzaModule = {
  label: "Pizza-Bilanz",
  refreshMs: 30 * 60000,
  async render(el) {
    function formatDate(iso) {
      if (!iso) return "";
      return new Date(iso + "T12:00:00").toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", timeZone: "Europe/Berlin" });
    }
    function formatDuration(minutes) {
      if (!minutes) return "–";
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return h > 0 ? `${h}:${String(m).padStart(2, "0")} h` : `${m} min`;
    }
    function sliceSvg(size, partial) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 100 100">
        <path d="M50 6 L92 84 Q50 98 8 84 Z" fill="none" stroke="var(--ink)" stroke-width="4" stroke-linejoin="round" ${partial ? 'stroke-dasharray="6 4"' : ""}/>
        <circle cx="40" cy="40" r="6" fill="var(--ink)"/><circle cx="60" cy="52" r="6" fill="var(--ink)"/>
        <circle cx="36" cy="60" r="5" fill="var(--ink)"/><circle cx="58" cy="28" r="4.5" fill="var(--ink)"/>
      </svg>`;
    }
    function sliceSize(count) {
      if (count <= 3) return 64; if (count <= 6) return 52; if (count <= 9) return 44; return 36;
    }

    const res = await fetch(`${RUDI_WORKER}/pizza`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    if (!res.ok || !data.kcal) {
      el.innerHTML = `<div class="empty-panel"><p class="empty-title">Noch keine Fahrt erfasst</p><p class="empty-sub">${escapeHtml(data.reason || "Nach der nächsten Radfahrt geht es hier weiter")}</p></div>`;
      return;
    }

    const kcalProStueck = data.kcalProStueck || 285;
    const slices = data.slices || 0;
    const restKcal = (data.kcal || 0) - slices * kcalProStueck;
    const showPartial = restKcal >= kcalProStueck * 0.35;
    const size = sliceSize(slices + (showPartial ? 1 : 0));
    let svgs = "";
    for (let i = 0; i < slices; i++) svgs += sliceSvg(size, false);
    if (showPartial) svgs += sliceSvg(size, true);

    el.innerHTML = `
      <div class="panel">
        <div class="stat-row">
          <div class="stat-tile stat-tile--wide">
            <div class="stat-value" style="font-size:52px;">${slices}</div>
            <div class="stat-caption">Stück Pizza verdient ${showPartial ? "+ 1 angebissenes" : "(glatt aufgegangen)"}</div>
          </div>
        </div>
        <div class="slice-row">${svgs || '<p class="empty-sub">Nicht genug für ein ganzes Stück</p>'}</div>
        <div class="kv-list">
          <div class="kv"><span class="k">Verbrauch</span><span class="v">${data.kcal.toLocaleString("de-DE")} kcal</span></div>
          <div class="kv"><span class="k">Datum</span><span class="v">${formatDate(data.date)}</span></div>
          <div class="kv"><span class="k">1 Stück</span><span class="v">${kcalProStueck} kcal</span></div>
        </div>
      </div>

      <div class="panel">
        <p class="label">Die Fahrt</p>
        <div class="stat-row">
          <div class="stat-tile"><div class="stat-label">Distanz</div><div class="stat-value">${data.km}<span class="stat-unit">km</span></div></div>
          <div class="stat-tile"><div class="stat-label">Höhenmeter</div><div class="stat-value">${data.elevation}<span class="stat-unit">hm</span></div></div>
          <div class="stat-tile"><div class="stat-label">Dauer</div><div class="stat-value" style="font-size:20px;">${formatDuration(data.minutes)}</div></div>
        </div>
      </div>
    `;
  },
};

/* ---------------------------------------------------------------
   Export -- Reihenfolge bestimmt die Rotation in iphone.html.
   --------------------------------------------------------------- */

const SCREEN_MODULES = [
  { id: "weather", ...weatherModule },
  { id: "warnings", ...warningsModule },
  { id: "traffic", ...trafficModule },
  { id: "alvin", ...alvinModule },
  { id: "military", ...militaryModule },
  { id: "paragliding", ...paraglidingModule },
  { id: "paraglidersLive", ...paraglidersLiveModule },
  { id: "chiemsee", ...chiemseeModule },
  { id: "snow", ...snowModule },
  { id: "training", ...trainingModule },
  { id: "pizza", ...pizzaModule },
];
