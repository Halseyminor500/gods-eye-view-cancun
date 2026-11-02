/* God's Eye View — US Demographics Overlay Module
 * Runs after the main engine script. Uses its globals: STATE, projectLatLon, flyToCamera, showToast.
 * Data is fetched live in the browser from public APIs (Census ACS 5-yr, TIGERweb, CDC PLACES, FEMA NRI).
 * "Top 500" = the 500 most populous US incorporated places/CDPs, ranked from ACS B01003 at runtime.
 */
(function () {
  'use strict';

  // Sources are validated live in the browser (see validateSources) and disabled unless their data was published within MAX_AGE_DAYS.
  const MAX_AGE_DAYS = 730;
  const ACS_YEARS_TO_TRY = [2024, 2023];
  let ACS_YEAR = null;
  const PLACES_DATASET = 'cwsq-ngmh'; // CDC PLACES census-tract data, 2025 release (long format: locationname, measureid, data_value)
  const NRI_SERVICE = 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer';
  const NRI_URL = NRI_SERVICE + '/0/query';
  const TIGER_ROOT = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer';

  // ---------------------------------------------------------------- key / provider registry
  // cost: 'free' (no cost), 'metered' (free quota then paid -> green $), 'key' (free but needs a key)
  const PROVIDERS = {
    census: { name: 'Census Bureau API', keyName: 'CENSUS_API_KEY', cost: 'free', keyOptional: true, signup: 'https://api.census.gov/data/key_signup.html' },
    tiger: { name: 'Census TIGERweb', cost: 'free' },
    cdc: { name: 'CDC PLACES (Socrata)', keyName: 'SOCRATA_APP_TOKEN', cost: 'free', keyOptional: true, signup: 'https://data.cdc.gov/profile/edit/developer_settings' },
    fema: { name: 'FEMA National Risk Index', cost: 'free' },
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }
  };
  const keys = store.get('gev_demo_keys', {});
  const depleted = store.get('gev_demo_depleted', {}); // provider -> true when credits ran out

  const VALID = {}; // pid -> {status:'ok'|'stale'|'unavailable', note}

  function providerState(pid) {
    const p = PROVIDERS[pid];
    if (depleted[pid]) return 'depleted';
    const v = VALID[pid];
    if (v && v.status !== 'ok') return v.status;
    if (!v && pid !== 'tiger') return 'checking';
    if (p.keyName && !p.keyOptional && !keys[p.keyName]) return 'needkey';
    if (p.cost === 'metered') return 'metered';
    return 'ok';
  }

  // ---------------------------------------------------------------- ACS variable catalog
  const D = (n, d) => (d > 0 ? n / d : null);
  const pct = (n, d) => (d > 0 ? (100 * n) / d : null);
  const sum = (r, list) => list.reduce((a, c) => a + (r[c] || 0), 0);
  const BACH = ['B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E'];

  // id, window, label, needed ACS codes, calculator, format
  const ACS_LAYERS = [
    ['pop', 'pop', 'Total population', ['B01003_001E'], (r) => r.B01003_001E, 'n'],
    ['density', 'pop', 'Population density (per sq mi)', ['B01003_001E'], (r, f) => D(r.B01003_001E, f.sqmi), 'n'],
    ['age', 'pop', 'Median age', ['B01002_001E'], (r) => r.B01002_001E, 'd'],
    ['under18', 'pop', '% under 18', ['B09001_001E', 'B01003_001E'], (r) => pct(r.B09001_001E, r.B01003_001E), 'p'],
    ['over65', 'pop', '% age 65+', ['B01001_020E', 'B01001_021E', 'B01001_022E', 'B01001_023E', 'B01001_024E', 'B01001_025E', 'B01001_044E', 'B01001_045E', 'B01001_046E', 'B01001_047E', 'B01001_048E', 'B01001_049E', 'B01003_001E'],
      (r) => pct(sum(r, ['B01001_020E', 'B01001_021E', 'B01001_022E', 'B01001_023E', 'B01001_024E', 'B01001_025E', 'B01001_044E', 'B01001_045E', 'B01001_046E', 'B01001_047E', 'B01001_048E', 'B01001_049E']), r.B01003_001E), 'p'],
      ['veterans', 'pop', '% veterans', ['B21001_002E', 'B21001_001E'], (r) => pct(r.B21001_002E, r.B21001_001E), 'p'],

    ['mhi', 'inc', 'Median household income', ['B19013_001E'], (r) => r.B19013_001E, '$'],
    ['pci', 'inc', 'Per-capita income', ['B19301_001E'], (r) => r.B19301_001E, '$'],
    ['poverty', 'inc', '% below poverty line', ['B17001_002E', 'B17001_001E'], (r) => pct(r.B17001_002E, r.B17001_001E), 'p'],
    ['unemp', 'inc', 'Unemployment rate', ['B23025_005E', 'B23025_003E'], (r) => pct(r.B23025_005E, r.B23025_003E), 'p'],
    ['gini', 'inc', 'Income inequality (Gini)', ['B19083_001E'], (r) => r.B19083_001E, 'd2'],
    ['snap', 'inc', '% households on SNAP', ['B22010_002E', 'B22010_001E'], (r) => pct(r.B22010_002E, r.B22010_001E), 'p'],

    ['black', 'race', '% Black / African American', ['B02001_003E', 'B01003_001E'], (r) => pct(r.B02001_003E, r.B01003_001E), 'p'],
    ['asian', 'race', '% Asian', ['B02001_005E', 'B01003_001E'], (r) => pct(r.B02001_005E, r.B01003_001E), 'p'],
    ['hisp', 'race', '% Hispanic / Latino', ['B03003_003E', 'B03003_001E'], (r) => pct(r.B03003_003E, r.B03003_001E), 'p'],
    ['white', 'race', '% White, non-Hispanic', ['B03002_003E', 'B03002_001E'], (r) => pct(r.B03002_003E, r.B03002_001E), 'p'],
    ['native', 'race', '% American Indian / Alaska Native', ['B02001_004E', 'B01003_001E'], (r) => pct(r.B02001_004E, r.B01003_001E), 'p'],
    ['foreign', 'race', '% foreign-born', ['B05002_013E', 'B05002_001E'], (r) => pct(r.B05002_013E, r.B05002_001E), 'p'],

    ['bach', 'edu', "% adults with bachelor's+", [...BACH, 'B15003_001E'], (r) => pct(sum(r, BACH), r.B15003_001E), 'p'],
    ['nohs', 'edu', '% adults without HS diploma', ['B15003_002E', 'B15003_003E', 'B15003_004E', 'B15003_005E', 'B15003_006E', 'B15003_007E', 'B15003_008E', 'B15003_009E', 'B15003_010E', 'B15003_011E', 'B15003_012E', 'B15003_013E', 'B15003_014E', 'B15003_015E', 'B15003_016E', 'B15003_001E'],
      (r) => pct(sum(r, ['B15003_002E', 'B15003_003E', 'B15003_004E', 'B15003_005E', 'B15003_006E', 'B15003_007E', 'B15003_008E', 'B15003_009E', 'B15003_010E', 'B15003_011E', 'B15003_012E', 'B15003_013E', 'B15003_014E', 'B15003_015E', 'B15003_016E']), r.B15003_001E), 'p'],
    ['hhsize', 'edu', 'Average household size', ['B25010_001E'], (r) => r.B25010_001E, 'd2'],
    ['single', 'edu', '% single-person households', ['B11001_008E', 'B11001_001E'], (r) => pct(r.B11001_008E, r.B11001_001E), 'p'],

    ['homeval', 'house', 'Median home value', ['B25077_001E'], (r) => r.B25077_001E, '$'],
    ['rent', 'house', 'Median gross rent', ['B25064_001E'], (r) => r.B25064_001E, '$'],
    ['renters', 'house', '% renter-occupied', ['B25003_003E', 'B25003_001E'], (r) => pct(r.B25003_003E, r.B25003_001E), 'p'],
    ['vacant', 'house', '% vacant housing units', ['B25002_003E', 'B25002_001E'], (r) => pct(r.B25002_003E, r.B25002_001E), 'p'],
    ['novehicle', 'house', '% households without a vehicle', ['B25044_003E', 'B25044_010E', 'B25044_001E'], (r) => pct(r.B25044_003E + r.B25044_010E, r.B25044_001E), 'p'],
    ['wfh', 'house', '% working from home', ['B08006_017E', 'B08006_001E'], (r) => pct(r.B08006_017E, r.B08006_001E), 'p'],
    ['transit', 'house', '% commuting by public transit', ['B08006_008E', 'B08006_001E'], (r) => pct(r.B08006_008E, r.B08006_001E), 'p'],

    ['bband', 'conn', '% households with broadband subscription', ['B28002_004E', 'B28002_001E'], (r) => pct(r.B28002_004E, r.B28002_001E), 'p'],
    ['nointernet', 'conn', '% households with no internet', ['B28002_013E', 'B28002_001E'], (r) => pct(r.B28002_013E, r.B28002_001E), 'p']
  ].map(([id, win, label, codes, calc, fmt]) => ({ id, win, label, src: 'acs', provider: 'census', codes, calc, fmt }));

  const PLACES_LAYERS = [
    ['obesity', 'Obesity (adults)', 'OBESITY'],
    ['diabetes', 'Diagnosed diabetes', 'DIABETES'],
    ['bphigh', 'High blood pressure', 'BPHIGH'],
    ['csmoking', 'Current smoking', 'CSMOKING'],
    ['casthma', 'Current asthma', 'CASTHMA'],
    ['depression', 'Depression', 'DEPRESSION'],
    ['mhlth', 'Poor mental health (14+ days)', 'MHLTH'],
    ['access2', 'No health insurance (18–64)', 'ACCESS2'],
    ['lpa', 'No leisure-time physical activity', 'LPA']
  ].map(([id, label, col]) => ({ id: 'pl_' + id, win: 'health', label: label + ' %', src: 'places', provider: 'cdc', col, fmt: 'p' }));

  const NRI_LAYERS = [
    ['risk', 'Composite natural-hazard risk score', 'RISK_SCORE'],
    ['eal', 'Expected annual loss score', 'EAL_SCORE'],
    ['sovi', 'Social vulnerability score', 'SOVI_SCORE'],
    ['resl', 'Community resilience score', 'RESL_SCORE']
  ].map(([id, label, col]) => ({ id: 'nri_' + id, win: 'risk', label, src: 'nri', provider: 'fema', col, fmt: 'd' }));

  const ALL_LAYERS = [...ACS_LAYERS, ...PLACES_LAYERS, ...NRI_LAYERS];

  const WINDOWS = [
    { id: 'ctl', icon: '🗺️', title: 'City & API Keys', control: true },
    { id: 'pop', icon: '👥', title: 'Population & Age' },
    { id: 'inc', icon: '💵', title: 'Income & Employment' },
    { id: 'race', icon: '🌎', title: 'Race, Ethnicity & Nativity' },
    { id: 'edu', icon: '🎓', title: 'Education & Households' },
    { id: 'house', icon: '🏠', title: 'Housing & Commute' },
    { id: 'conn', icon: '📡', title: 'Internet Access' },
    { id: 'health', icon: '🩺', title: 'Health · CDC PLACES' },
    { id: 'risk', icon: '🌪️', title: 'Hazard & Resilience · FEMA NRI' }
  ];

  // ---------------------------------------------------------------- state
  const S = {
    places: null, // [{name,state,place,pop}], loaded after ACS vintage is validated
    city: null, // loaded city record
    activeLayer: null, // one choropleth at a time
    opacity: 0.55,
    classes: null, // quantile breaks for active layer
    hover: null,
    winState: store.get('gev_demo_wins', {}), // id -> {open, collapsed, x, y}
    hits: [],
    crawl: { running: false, done: 0, total: 0 }
  };

  // ---------------------------------------------------------------- IndexedDB cache (city records)
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const q = indexedDB.open('gev-demographics', 1);
        q.onupgradeneeded = () => q.result.createObjectStore('cities');
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    }
    return dbp;
  }
  async function idbGet(k) {
    try { const d = await db(); return await new Promise((r) => { const q = d.transaction('cities').objectStore('cities').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch (e) { return null; }
  }
  async function idbPut(k, v) {
    try { const d = await db(); await new Promise((r) => { const t = d.transaction('cities', 'readwrite'); t.objectStore('cities').put(v, k); t.oncomplete = r; t.onerror = r; }); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- networking
  class DepletedError extends Error {}
  async function getJSON(url, pid) {
    const r = await fetch(url);
    if (r.status === 402 || r.status === 429 || r.status === 403) {
      const t = await r.text().catch(() => '');
      if (r.status === 402 || /credit|quota|billing|payment|limit/i.test(t)) {
        if (PROVIDERS[pid].cost === 'metered' || r.status === 402) markDepleted(pid);
        throw new DepletedError(`${PROVIDERS[pid].name}: quota/credits exhausted`);
      }
      throw new Error(`${PROVIDERS[pid].name}: HTTP ${r.status}`);
    }
    if (!r.ok) throw new Error(`${PROVIDERS[pid].name}: HTTP ${r.status}`);
    return r.json();
  }
  function markDepleted(pid) {
    depleted[pid] = true;
    store.set('gev_demo_depleted', depleted);
    renderAll();
  }
  function clearDepleted(pid) {
    delete depleted[pid];
    store.set('gev_demo_depleted', depleted);
    renderAll();
  }
  const toast = (m) => (typeof showToast === 'function' ? showToast(m) : console.log(m));

  // ---------------------------------------------------------------- live source validation
  const ageDays = (ms) => (Date.now() - ms) / 864e5;
  const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  async function validateSources() {
    const k = keys.CENSUS_API_KEY ? `&key=${keys.CENSUS_API_KEY}` : '';
    VALID.census = { status: 'unavailable', note: 'Census API not reachable' };
    for (const y of ACS_YEARS_TO_TRY) {
      try {
        const r = await fetch(`https://api.census.gov/data/${y}/acs/acs5?get=B01003_001E&for=state:06${k}`);
        if (r.ok) { ACS_YEAR = y; VALID.census = { status: 'ok', note: `ACS ${y - 4}–${y} 5-year estimates` }; break; }
      } catch (e) { /* try older vintage */ }
    }
    try {
      const m = await (await fetch(`https://data.cdc.gov/api/views/${PLACES_DATASET}.json`)).json();
      const ms = m.rowsUpdatedAt * 1000;
      VALID.cdc = ageDays(ms) <= MAX_AGE_DAYS
        ? { status: 'ok', note: `${m.name}, updated ${isoDay(ms)}` }
        : { status: 'stale', note: `last updated ${isoDay(ms)} (older than 2 years)` };
    } catch (e) { VALID.cdc = { status: 'unavailable', note: 'CDC metadata not reachable' }; }
    try {
      const m = await (await fetch(`${NRI_SERVICE}?f=json`)).json();
      const ms = m.editingInfo && m.editingInfo.lastEditDate;
      if (!ms) VALID.fema = { status: 'unavailable', note: 'publication date not reported by service' };
      else VALID.fema = ageDays(ms) <= MAX_AGE_DAYS
        ? { status: 'ok', note: `service updated ${isoDay(ms)}` }
        : { status: 'stale', note: `last updated ${isoDay(ms)} (older than 2 years)` };
    } catch (e) { VALID.fema = { status: 'unavailable', note: 'FEMA service not reachable' }; }
    renderAll();
  }

  // ---------------------------------------------------------------- Top-500 places
  async function loadTop500() {
    if (S.places && S.places.year === ACS_YEAR) return S.places;
    if (providerState('census') !== 'ok') throw new Error('Census API not validated');
    const k = keys.CENSUS_API_KEY ? `&key=${keys.CENSUS_API_KEY}` : '';
    const j = await getJSON(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=NAME,B01003_001E&for=place:*&in=state:*${k}`, 'census');
    const rows = j.slice(1).map((r) => ({ name: r[0], pop: +r[1], state: r[2], place: r[3] })).filter((r) => r.pop > 0);
    rows.sort((a, b) => b.pop - a.pop);
    S.places = rows.slice(0, 500);
    S.places.year = ACS_YEAR;
    return S.places;
  }

  // ---------------------------------------------------------------- TIGERweb geometry
  let tigerLayers = null;
  async function tigerLayerId(name) {
    if (!tigerLayers) {
      const j = await getJSON(`${TIGER_ROOT}?f=json`, 'tiger');
      tigerLayers = j.layers;
    }
    const l = tigerLayers.find((x) => x.name === name);
    if (!l) throw new Error('TIGERweb layer not found: ' + name);
    return l.id;
  }

  async function loadGeometry(pl) {
    const placeLayer = await tigerLayerId('Incorporated Places');
    const censusPlaceLayer = await tigerLayerId('Census Designated Places');
    const q = (layer, extra) => `${TIGER_ROOT}/${layer}/query?f=json&where=${encodeURIComponent(`STATE='${pl.state}' AND PLACE='${pl.place}'`)}&returnExtentOnly=true&outSR=4326${extra || ''}`;
    let ext = (await getJSON(q(placeLayer), 'tiger')).extent;
    if (!ext || ext.xmin == null) ext = (await getJSON(q(censusPlaceLayer), 'tiger')).extent;
    if (!ext || ext.xmin == null) throw new Error('Place extent not found');
    const tractLayer = await tigerLayerId('Census Tracts');
    const env = `${ext.xmin},${ext.ymin},${ext.xmax},${ext.ymax}`;
    const feats = [];
    for (let off = 0; off < 20000; off += 1000) {
      const url = `${TIGER_ROOT}/${tractLayer}/query?f=geojson&where=1%3D1&geometry=${env}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GEOID,STATE,COUNTY,TRACT,AREALAND&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.0002&resultOffset=${off}&resultRecordCount=1000`;
      const j = await getJSON(url, 'tiger');
      (j.features || []).forEach((f) => feats.push(f));
      if (!j.exceededTransferLimit && (j.features || []).length < 1000) break;
    }
    return {
      bbox: ext,
      tracts: feats.map((f) => {
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        const rings = [];
        polys.forEach((p) => p.forEach((ring) => rings.push(ring.map((c) => [c[1], c[0]]))));
        return { geoid: f.properties.GEOID, sqmi: (f.properties.AREALAND || 0) / 2589988.11, state: f.properties.STATE, county: f.properties.COUNTY, rings };
      })
    };
  }

  // ---------------------------------------------------------------- ACS tract data
  async function loadACS(tracts) {
    const codes = [...new Set(ACS_LAYERS.flatMap((l) => l.codes))];
    const counties = [...new Set(tracts.map((t) => t.state + t.county))];
    const k = keys.CENSUS_API_KEY ? `&key=${keys.CENSUS_API_KEY}` : '';
    const out = {};
    for (const sc of counties) {
      const st = sc.slice(0, 2), co = sc.slice(2);
      // ACS allows 50 variables per call: chunk and merge by tract
      for (let i = 0; i < codes.length; i += 45) {
        const chunk = codes.slice(i, i + 45);
        const j = await getJSON(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5?get=${chunk.join(',')}&for=tract:*&in=state:${st}&in=county:${co}${k}`, 'census');
        const head = j[0];
        j.slice(1).forEach((row) => {
          const geoid = row[head.indexOf('state')] + row[head.indexOf('county')] + row[head.indexOf('tract')];
          const o = out[geoid] || (out[geoid] = {});
          chunk.forEach((c) => { const v = +row[head.indexOf(c)]; o[c] = v < -1e8 || isNaN(v) ? null : v; });
        });
      }
    }
    return out;
  }

  async function loadPLACES(tracts) {
    const counties = [...new Set(tracts.map((t) => t.state + t.county))];
    const ids = PLACES_LAYERS.map((l) => `'${l.col}'`).join(',');
    const tok = keys.SOCRATA_APP_TOKEN ? `&$$app_token=${keys.SOCRATA_APP_TOKEN}` : '';
    const out = {};
    for (const sc of counties) {
      const where = `starts_with(locationname,'${sc}') AND datavaluetypeid='CrdPrv' AND measureid in(${ids})`;
      const url = `https://data.cdc.gov/resource/${PLACES_DATASET}.json?$select=locationname,measureid,data_value&$where=${encodeURIComponent(where)}&$limit=50000${tok}`;
      (await getJSON(url, 'cdc')).forEach((r) => { (out[r.locationname] || (out[r.locationname] = {}))[r.measureid] = r.data_value; });
    }
    return out;
  }

  async function loadNRI(tracts) {
    const counties = [...new Set(tracts.map((t) => t.state + t.county))];
    const out = {};
    for (const sc of counties) {
      const url = `${NRI_URL}?f=json&where=${encodeURIComponent(`STCOFIPS='${sc}'`)}&outFields=TRACTFIPS,${NRI_LAYERS.map((l) => l.col).join(',')}&returnGeometry=false&resultRecordCount=5000`;
      const j = await getJSON(url, 'fema');
      (j.features || []).forEach((f) => { out[f.attributes.TRACTFIPS] = f.attributes; });
    }
    return out;
  }

  // ---------------------------------------------------------------- city loading
  const cityKey = (pl) => `${ACS_YEAR}-${pl.state}${pl.place}`;
  async function ensureCity(pl, opts = {}) {
    const key = cityKey(pl);
    let rec = await idbGet(key);
    if (!rec) {
      const g = await loadGeometry(pl);
      rec = { key, name: pl.name, bbox: g.bbox, tracts: g.tracts, acs: await loadACS(g.tracts), places: null, nri: null, ts: Date.now() };
      await idbPut(key, rec);
    }
    return rec;
  }

  async function ensureSource(rec, src) {
    if (src === 'places' && !rec.places) {
      rec.places = await loadPLACES(rec.tracts).catch((e) => { toast('CDC PLACES: ' + e.message); return {}; });
      await idbPut(rec.key, rec);
    }
    if (src === 'nri' && !rec.nri) {
      rec.nri = await loadNRI(rec.tracts).catch((e) => { toast('FEMA NRI: ' + e.message); return {}; });
      await idbPut(rec.key, rec);
    }
  }

  async function selectCity(pl) {
    setStatus(`Loading ${pl.name}…`);
    try {
      S.city = await ensureCity(pl);
      const b = S.city.bbox;
      if (typeof flyToCamera === 'function') flyToCamera({ lat: (b.ymin + b.ymax) / 2, lon: (b.xmin + b.xmax) / 2, zoom: 10.6, tilt: 0 });
      setStatus(`${pl.name}: ${S.city.tracts.length} census tracts loaded`);
      if (!S.activeLayer) setActive('mhi'); else recomputeClasses();
    } catch (e) {
      setStatus('Failed: ' + e.message, true);
    }
  }

  async function crawlAll() {
    if (S.crawl.running) { S.crawl.running = false; return; }
    const list = await loadTop500();
    S.crawl = { running: true, done: 0, total: list.length };
    for (const pl of list) {
      if (!S.crawl.running) break;
      try {
        if (!(await idbGet(cityKey(pl)))) { await ensureCity(pl); await new Promise((r) => setTimeout(r, 400)); }
      } catch (e) {
        if (e instanceof DepletedError) { setStatus(e.message, true); break; }
      }
      S.crawl.done++;
      setStatus(`Caching top-500 cities: ${S.crawl.done}/${S.crawl.total}`);
    }
    S.crawl.running = false;
    renderAll();
  }

  // ---------------------------------------------------------------- values, classes, colors
  const PAL = ['#fde68a', '#fbbf24', '#f97316', '#dc2626', '#7f1d1d'];
  function layerById(id) { return ALL_LAYERS.find((l) => l.id === id); }
  function valueOf(layer, t) {
    const c = S.city;
    if (!c) return null;
    if (layer.src === 'acs') {
      const r = c.acs[t.geoid];
      if (!r) return null;
      for (const code of layer.codes) if (r[code] == null) return null;
      const v = layer.calc(r, t);
      return v == null || !isFinite(v) ? null : v;
    }
    const row = layer.src === 'places' ? c.places && c.places[t.geoid] : c.nri && c.nri[t.geoid];
    if (!row) return null;
    const v = parseFloat(row[layer.col]);
    return isNaN(v) ? null : v;
  }
  function recomputeClasses() {
    const layer = layerById(S.activeLayer);
    if (!layer || !S.city) { S.classes = null; return; }
    const vals = S.city.tracts.map((t) => (t._v = valueOf(layer, t))).filter((v) => v != null).sort((a, b) => a - b);
    S.classes = vals.length ? [1, 2, 3, 4].map((i) => vals[Math.floor((vals.length * i) / 5)]) : null;
    S.vmin = vals[0]; S.vmax = vals[vals.length - 1];
    renderLegend();
  }
  function colorFor(v) {
    if (v == null || !S.classes) return null;
    let i = 0;
    while (i < 4 && v >= S.classes[i]) i++;
    return PAL[i];
  }
  function fmt(layer, v) {
    if (v == null) return 'n/a';
    switch (layer.fmt) {
      case '$': return '$' + Math.round(v).toLocaleString();
      case 'p': return v.toFixed(1) + '%';
      case 'd': return v.toFixed(1);
      case 'd2': return v.toFixed(2);
      default: return Math.round(v).toLocaleString();
    }
  }

  async function setActive(id) {
    const layer = layerById(id);
    if (!layer || providerState(layer.provider) !== 'ok') return;
    S.activeLayer = id;
    renderAll();
    if (S.city) {
      await ensureSource(S.city, layer.src);
      recomputeClasses();
    }
  }
  function clearActive() { S.activeLayer = null; S.classes = null; renderAll(); }

  // ---------------------------------------------------------------- canvas hook (called from renderGlobe)
  function draw(ctx) {
    S.hits = [];
    if (!S.city || !S.activeLayer || !S.classes || STATE.cam.zoom < 6.5) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.globalAlpha = S.opacity;
    S.city.tracts.forEach((t) => {
      const color = colorFor(t._v);
      if (!color) return;
      const path = new Path2D();
      let any = false, bad = false;
      for (const ring of t.rings) {
        let first = true;
        for (const pt of ring) {
          const p = projectLatLon(pt[0], pt[1]);
          if (p.clipped) { bad = true; break; }
          if (first) { path.moveTo(p.x, p.y); first = false; } else path.lineTo(p.x, p.y);
          any = true;
        }
        if (bad) break;
        path.closePath();
      }
      if (bad || !any) return;
      ctx.fillStyle = color;
      ctx.fill(path, 'evenodd');
      S.hits.push({ t, path });
      if (S.hover === t) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; } else { ctx.lineWidth = 0.6; ctx.strokeStyle = 'rgba(15,23,42,0.75)'; }
      ctx.stroke(path);
    });
    ctx.restore();
  }

  // hover tooltip
  const tip = document.createElement('div');
  tip.className = 'fixed z-[60] hidden pointer-events-none rounded bg-slate-950/95 border border-amber-400/60 text-[11px] font-mono-tech text-slate-100 px-2 py-1 max-w-xs';
  document.body.appendChild(tip);
  let lastMove = 0;
  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 60) return;
    lastMove = now;
    const cv = document.getElementById('gev-canvas');
    if (!cv || e.target !== cv || !S.hits.length) { S.hover = null; tip.classList.add('hidden'); return; }
    const c = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let hit = null;
    for (let i = S.hits.length - 1; i >= 0; i--) {
      if (c.isPointInPath(S.hits[i].path, e.clientX * dpr, e.clientY * dpr, 'evenodd')) { hit = S.hits[i].t; break; }
    }
    S.hover = hit;
    if (!hit) { tip.classList.add('hidden'); return; }
    const layer = layerById(S.activeLayer);
    const r = S.city.acs[hit.geoid] || {};
    tip.innerHTML = `<b class="text-amber-300">Tract ${hit.geoid}</b><br>${layer.label}: <b>${fmt(layer, hit._v)}</b><br>Pop ${r.B01003_001E != null ? r.B01003_001E.toLocaleString() : 'n/a'} · Income ${r.B19013_001E != null ? '$' + r.B19013_001E.toLocaleString() : 'n/a'}`;
    tip.style.left = e.clientX + 14 + 'px';
    tip.style.top = e.clientY + 14 + 'px';
    tip.classList.remove('hidden');
  });

  // ---------------------------------------------------------------- UI
  const root = document.createElement('div');
  root.id = 'demo-root';
  document.body.appendChild(root);
  const css = document.createElement('style');
  css.textContent = `
    #demo-dock{position:fixed;right:.75rem;top:3.95rem;z-index:47;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
    .demo-btn{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;font:600 10px 'JetBrains Mono',monospace;border:1px solid rgba(34,211,238,.45);background:rgba(2,6,23,.9);color:#a5f3fc;cursor:pointer;white-space:nowrap}
    .demo-btn.open{background:rgba(34,211,238,.25);color:#fff}
    .demo-win{position:fixed;z-index:46;width:19rem;max-height:70vh;display:flex;flex-direction:column;border-radius:8px;border:1px solid rgba(34,211,238,.4);background:rgba(2,6,23,.95);backdrop-filter:blur(6px);font:11px 'JetBrains Mono',monospace;color:#e2e8f0}
    .demo-win header{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:move;border-bottom:1px solid rgba(51,65,85,.8);font-weight:700;color:#67e8f9}
    .demo-win header span.t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .demo-win header button{color:#94a3b8;padding:0 4px}.demo-win header button:hover{color:#fff}
    .demo-body{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px}
    .demo-row{display:flex;align-items:center;gap:6px;padding:3px 4px;border-radius:4px;cursor:pointer}
    .demo-row:hover{background:rgba(51,65,85,.6)}
    .demo-row.active{background:rgba(245,158,11,.2);outline:1px solid rgba(245,158,11,.6)}
    .demo-row.off{background:#1f2937;color:#6b7280;cursor:not-allowed;opacity:.85}
    .demo-row.pend{opacity:.65;cursor:default}
    .badge{font-size:9px;padding:0 4px;border-radius:3px;flex:none}
    .b-free{background:rgba(34,211,238,.2);color:#67e8f9}.b-key{background:rgba(245,158,11,.2);color:#fcd34d}
    .b-cost{background:#16a34a;color:#fff}.b-off{background:#374151;color:#9ca3af}.b-soon{background:rgba(148,163,184,.2);color:#cbd5e1}
    .demo-in{width:100%;background:#020617;border:1px solid #334155;border-radius:4px;padding:2px 5px;color:#cbd5e1}
    .demo-leg{display:flex;height:10px;border-radius:2px;overflow:hidden}.demo-leg i{flex:1}
  `;
  document.head.appendChild(css);

  function ws(id) {
    if (!S.winState[id]) {
      const i = WINDOWS.findIndex((w) => w.id === id);
      S.winState[id] = { open: false, collapsed: false, x: 360 + (i % 4) * 40, y: 120 + (i % 6) * 36 };
    }
    return S.winState[id];
  }
  const saveWins = () => store.set('gev_demo_wins', S.winState);
  let statusMsg = '', statusErr = false;
  function setStatus(m, err) { statusMsg = m; statusErr = !!err; const el = document.getElementById('demo-status'); if (el) { el.textContent = m; el.style.color = err ? '#fda4af' : '#94a3b8'; } }

  function badge(layer) {
    const st = providerState(layer.provider);
    const p = PROVIDERS[layer.provider];
    if (st === 'depleted') return '<span class="badge b-off" title="Data available, but unfunded: API credits are depleted so requests are failing">UNFUNDED</span>';
    if (st === 'metered') return '<span class="badge b-cost" title="Free quota, then paid">$ PAID</span>';
    if (st === 'needkey') return '<span class="badge b-key" title="Free key required — add it in City & API Keys">KEY</span>';
    if (st === 'stale') return `<span class="badge b-off" title="${(VALID[layer.provider].note || '').replace(/"/g, '')}">STALE</span>`;
    if (st === 'unavailable') return `<span class="badge b-off" title="${(VALID[layer.provider].note || '').replace(/"/g, '')}">UNAVAILABLE</span>`;
    if (st === 'checking') return '<span class="badge b-soon">CHECKING…</span>';
    return `<span class="badge b-free">FREE${p.keyOptional ? '+' : ''}</span>`;
  }

  function winHTML(w) {
    if (w.control) {
      const kn = [...new Set(Object.values(PROVIDERS).filter((p) => p.keyName).map((p) => p))];
      return `
        <input id="demo-search" class="demo-in" placeholder="Search top-500 cities…" />
        <select id="demo-city" size="8" class="demo-in">${(S.places || []).map((p, i) => `<option value="${i}">#${i + 1} ${p.name} (${p.pop.toLocaleString()})</option>`).join('')}</select>
        <div class="flex gap-1">
          <button id="demo-load500" class="demo-btn">${S.places ? '↻ Reload' : '⬇ Load'} top-500 list</button>
          <button id="demo-crawl" class="demo-btn">${S.crawl.running ? '■ Stop' : '⬇ Cache all 500'}</button>
        </div>
        <div id="demo-status" style="color:${statusErr ? '#fda4af' : '#94a3b8'}">${statusMsg}</div>
        <div class="text-slate-400 mt-1">Opacity <input id="demo-op" type="range" min="15" max="90" value="${Math.round(S.opacity * 100)}"></div>
        <div id="demo-legend"></div>
        <div class="text-cyan-300 font-bold mt-2">API keys (stored only in this browser)</div>
        ${kn.map((p) => `<label class="block text-slate-400">${p.keyName} ${p.keyOptional ? '<i>(optional)</i>' : ''} ${p.cost === 'metered' ? '<span class="badge b-cost">$</span>' : ''}
          <input data-key="${p.keyName}" type="password" class="demo-in" value="${keys[p.keyName] || ''}" placeholder="paste key" />
          <a class="text-cyan-400 underline" target="_blank" rel="noopener" href="${p.signup}">get key</a></label>`).join('')}
        ${Object.keys(depleted).length ? `<button id="demo-reset-funds" class="demo-btn">Funds deposited — retry unfunded APIs</button>` : ''}`;
    }
    const rows = ALL_LAYERS.filter((l) => l.win === w.id).map((l) => {
      const st = providerState(l.provider);
      const cls = st === 'depleted' ? 'off' : st !== 'ok' ? 'pend' : S.activeLayer === l.id ? 'active' : '';
      const tt = `${PROVIDERS[l.provider].name}${VALID[l.provider] && VALID[l.provider].note ? ' — ' + VALID[l.provider].note : ''}`;
      return `<div class="demo-row ${cls}" data-layer="${l.id}" title="${tt}">
        <span style="width:12px">${S.activeLayer === l.id ? '◉' : '○'}</span><span class="flex-1">${l.label}</span>${badge(l)}</div>`;
    }).join('');
    return rows + '<div class="text-slate-500 mt-1">One tract overlay shows at a time. Hover a tract for values.</div>';
  }

  function renderLegend() {
    const el = document.getElementById('demo-legend');
    const layer = layerById(S.activeLayer);
    if (!el || !layer || !S.classes) { if (el) el.innerHTML = ''; return; }
    el.innerHTML = `<div class="mt-1 text-amber-300">${layer.label}</div><div class="demo-leg">${PAL.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="flex justify-between text-slate-400"><span>${fmt(layer, S.vmin)}</span><span>${fmt(layer, S.classes[1])}</span><span>${fmt(layer, S.vmax)}</span></div>`;
  }

  function renderAll() {
    const dock = `<div id="demo-dock"><button class="demo-btn ${S.dockOpen ? 'open' : ''}" id="demo-launch">📊 DEMOGRAPHICS ${S.dockOpen ? '▴' : '▾'}</button>${!S.dockOpen ? '' : WINDOWS.map((w) => `<button class="demo-btn ${ws(w.id).open ? 'open' : ''}" data-win="${w.id}" title="${w.title}">${w.icon} ${w.title}</button>`).join('')}</div>`;
    const wins = WINDOWS.filter((w) => ws(w.id).open).map((w) => {
      const s = ws(w.id);
      return `<div class="demo-win" data-w="${w.id}" style="left:${s.x}px;top:${s.y}px">
        <header data-drag="${w.id}"><span class="t">${w.icon} ${w.title}</span>
          <button data-collapse="${w.id}" title="Collapse / expand">${s.collapsed ? '▸' : '▾'}</button>
          <button data-close="${w.id}" title="Hide window (back to button)">✕</button></header>
        ${s.collapsed ? '' : `<div class="demo-body">${winHTML(w)}</div>`}</div>`;
    }).join('');
    root.innerHTML = dock + wins;
    renderLegend();
    wire();
  }

  function wire() {
    document.getElementById('demo-launch').onclick = () => { S.dockOpen = !S.dockOpen; renderAll(); };
    root.querySelectorAll('[data-win]').forEach((b) => (b.onclick = () => { const s = ws(b.dataset.win); s.open = !s.open; saveWins(); renderAll(); }));
    root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => { ws(b.dataset.close).open = false; saveWins(); renderAll(); }));
    root.querySelectorAll('[data-collapse]').forEach((b) => (b.onclick = () => { const s = ws(b.dataset.collapse); s.collapsed = !s.collapsed; saveWins(); renderAll(); }));
    root.querySelectorAll('.demo-row[data-layer]').forEach((r) => (r.onclick = () => {
      const l = layerById(r.dataset.layer);
      if (r.classList.contains('off')) return toast(`${PROVIDERS[l.provider].name}: data exists but API funds are depleted`);
      if (providerState(l.provider) !== 'ok' && providerState(l.provider) !== 'needkey') return toast(`${PROVIDERS[l.provider].name}: ${(VALID[l.provider] && VALID[l.provider].note) || 'not validated yet'}`);
      if (providerState(l.provider) === 'needkey') return toast(`Add ${PROVIDERS[l.provider].keyName} in City & API Keys`);
      S.activeLayer === l.id ? clearActive() : setActive(l.id);
    }));
    root.querySelectorAll('[data-drag]').forEach((h) => (h.onmousedown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const w = h.parentElement, s = ws(h.dataset.drag);
      const ox = e.clientX - s.x, oy = e.clientY - s.y;
      const mv = (ev) => { s.x = ev.clientX - ox; s.y = Math.max(0, ev.clientY - oy); w.style.left = s.x + 'px'; w.style.top = s.y + 'px'; };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); saveWins(); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    }));
    const sel = document.getElementById('demo-city');
    if (sel) {
      sel.onchange = () => selectCity(S.places[+sel.value]);
      document.getElementById('demo-search').oninput = (e) => {
        const q = e.target.value.toLowerCase();
        [...sel.options].forEach((o) => (o.hidden = !!q && !o.textContent.toLowerCase().includes(q)));
      };
      document.getElementById('demo-load500').onclick = async () => {
        S.places = null; setStatus('Loading top-500 list…');
        try { await loadTop500(); renderAll(); setStatus('Top-500 places loaded'); } catch (e) { setStatus(e.message, true); }
      };
      document.getElementById('demo-crawl').onclick = () => { crawlAll(); renderAll(); };
      document.getElementById('demo-op').oninput = (e) => (S.opacity = e.target.value / 100);
      root.querySelectorAll('[data-key]').forEach((i) => (i.onchange = () => {
        keys[i.dataset.key] = i.value.trim(); store.set('gev_demo_keys', keys);
        Object.entries(PROVIDERS).forEach(([pid, p]) => { if (p.keyName === i.dataset.key) clearDepleted(pid); });
        renderAll();
      }));
      const rf = document.getElementById('demo-reset-funds');
      if (rf) rf.onclick = () => { Object.keys(depleted).forEach(clearDepleted); };
    }
  }

  window.GEV_DEMO = { draw, state: S, markDepleted, clearDepleted, layers: ALL_LAYERS, selectCity, loadTop500 };
  renderAll();
  validateSources().then(() => loadTop500()).then(renderAll).catch((e) => setStatus('Top-500 list not loaded: ' + e.message, true));
})();
