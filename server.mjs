import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_URL =
  process.env.FUEL_DATA_URL ||
  "https://donnees.roulez-eco.fr/opendata/instantane_ruptures";
const CACHE_DIR = path.join(__dirname, ".cache");
const ZIP_CACHE = path.join(CACHE_DIR, "prix-carburants.zip");
const XML_CACHE = path.join(CACHE_DIR, "prix-carburants.xml");
const BRAND_CACHE = path.join(CACHE_DIR, "station-brands.json");
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const BRAND_SEARCH_RADIUS_METERS = 110;
const OVERPASS_URL =
  process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const PUBLIC_FILES = new Set(["/index.html", "/app.js", "/styles.css"]);

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBrandCache() {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  if (!(await pathExists(BRAND_CACHE))) {
    return {};
  }

  try {
    return JSON.parse(await fs.readFile(BRAND_CACHE, "utf8"));
  } catch {
    return {};
  }
}

async function writeBrandCache(cache) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(BRAND_CACHE, JSON.stringify(cache, null, 2));
}

async function readFreshCachedXml(force = false) {
  await fs.mkdir(CACHE_DIR, { recursive: true });

  if (!force && (await pathExists(XML_CACHE))) {
    const stat = await fs.stat(XML_CACHE);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
      const cachedXml = await fs.readFile(XML_CACHE, "utf8");
      if (!hasBrokenEncoding(cachedXml) || !(await pathExists(ZIP_CACHE))) {
        return normalizeXmlDeclaration(cachedXml);
      }

      const repairedXml = extractXmlFromZip(await fs.readFile(ZIP_CACHE));
      await fs.writeFile(XML_CACHE, repairedXml);
      return repairedXml;
    }
  }

  try {
    const response = await fetch(DATA_URL, {
      headers: { "User-Agent": "prix-carburants-local/0.1" },
    });

    if (!response.ok) {
      throw new Error(`Flux indisponible (${response.status})`);
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const xml = extractXmlFromZip(zipBuffer);
    await fs.writeFile(ZIP_CACHE, zipBuffer);
    await fs.writeFile(XML_CACHE, xml);
    return xml;
  } catch (error) {
    if (await pathExists(XML_CACHE)) {
      console.warn(`Utilisation du cache XML existant: ${error.message}`);
      const cachedXml = await fs.readFile(XML_CACHE, "utf8");
      if (hasBrokenEncoding(cachedXml) && (await pathExists(ZIP_CACHE))) {
        const repairedXml = extractXmlFromZip(await fs.readFile(ZIP_CACHE));
        await fs.writeFile(XML_CACHE, repairedXml);
        return repairedXml;
      }
      return normalizeXmlDeclaration(cachedXml);
    }
    throw error;
  }
}

function hasBrokenEncoding(xml) {
  return xml.includes("�");
}

function extractXmlFromZip(zipBuffer) {
  const eocdOffset = findEndOfCentralDirectory(zipBuffer);
  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  let cursor = centralDirectoryOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Archive ZIP invalide: repertoire central introuvable.");
    }

    const method = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraLength = zipBuffer.readUInt16LE(cursor + 30);
    const commentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const fileName = zipBuffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString("utf8");

    if (fileName.toLowerCase().endsWith(".xml")) {
      const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

      if (method === 0) {
        return decodeXmlBuffer(compressed);
      }
      if (method === 8) {
        return decodeXmlBuffer(inflateRawSync(compressed));
      }
      throw new Error(`Methode ZIP non supportee: ${method}`);
    }

    cursor += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error("Aucun fichier XML trouve dans le ZIP.");
}

function decodeXmlBuffer(xmlBuffer) {
  const header = xmlBuffer.subarray(0, 200).toString("ascii");
  const encoding = header.match(/encoding=["']([^"']+)["']/i)?.[1]?.toLowerCase();

  if (encoding === "iso-8859-1" || encoding === "latin1") {
    return normalizeXmlDeclaration(new TextDecoder("iso-8859-1").decode(xmlBuffer));
  }

  return normalizeXmlDeclaration(new TextDecoder("utf-8").decode(xmlBuffer));
}

function normalizeXmlDeclaration(xml) {
  return xml.replace(
    /<\?xml([^>]*?)encoding=["'][^"']+["']([^>]*?)\?>/i,
    '<?xml$1encoding="UTF-8"$2?>'
  );
}

function findEndOfCentralDirectory(zipBuffer) {
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      return i;
    }
  }
  throw new Error("Archive ZIP invalide: fin du repertoire central introuvable.");
}

async function findStationBrands(stations) {
  const cache = await readBrandCache();
  const uniqueStations = stations
    .filter(
      (station) =>
        station.id &&
        Number.isFinite(station.latitude) &&
        Number.isFinite(station.longitude)
    )
    .slice(0, 20);
  const missing = uniqueStations.filter((station) => !cache[station.id]);

  if (missing.length > 0) {
    const candidates = await fetchOverpassFuelCandidates(missing).catch((error) => {
      console.warn(`Enseignes indisponibles: ${error.message}`);
      return [];
    });

    for (const station of missing) {
      const match = findClosestCandidate(station, candidates);
      cache[station.id] = match
        ? {
            label: match.label,
            source: "OpenStreetMap",
            distanceMeters: Math.round(match.distanceMeters),
            osmId: match.osmId,
            updatedAt: new Date().toISOString(),
          }
        : {
            label: "",
            source: "OpenStreetMap",
            distanceMeters: null,
            osmId: null,
            updatedAt: new Date().toISOString(),
          };
    }

    await writeBrandCache(cache);
  }

  return Object.fromEntries(
    uniqueStations
      .filter((station) => cache[station.id])
      .map((station) => [station.id, cache[station.id]])
  );
}

async function fetchOverpassFuelCandidates(stations) {
  const selectors = stations
    .map(
      (station) => `
        node["amenity"="fuel"](around:${BRAND_SEARCH_RADIUS_METERS},${station.latitude},${station.longitude});
        way["amenity"="fuel"](around:${BRAND_SEARCH_RADIUS_METERS},${station.latitude},${station.longitude});
        relation["amenity"="fuel"](around:${BRAND_SEARCH_RADIUS_METERS},${station.latitude},${station.longitude});`
    )
    .join("\n");
  const query = `[out:json][timeout:18];(${selectors});out center tags;`;
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "prix-carburants-local/0.1",
    },
    body: new URLSearchParams({ data: query }),
  });

  if (!response.ok) {
    throw new Error(`OpenStreetMap indisponible (${response.status})`);
  }

  const data = await response.json();
  return (data.elements || [])
    .map((element) => {
      const tags = element.tags || {};
      const latitude = element.lat ?? element.center?.lat;
      const longitude = element.lon ?? element.center?.lon;
      const label = pickBrandLabel(tags);

      if (!label || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
      }

      return {
        osmId: `${element.type}/${element.id}`,
        latitude,
        longitude,
        label,
      };
    })
    .filter(Boolean);
}

function findClosestCandidate(station, candidates) {
  let bestMatch = null;

  for (const candidate of candidates) {
    const distanceMeters = distanceInMeters(station, candidate);
    if (distanceMeters > BRAND_SEARCH_RADIUS_METERS) {
      continue;
    }

    if (!bestMatch || distanceMeters < bestMatch.distanceMeters) {
      bestMatch = { ...candidate, distanceMeters };
    }
  }

  return bestMatch;
}

function pickBrandLabel(tags) {
  return cleanLabel(tags.brand || tags.name || tags.operator);
}

function cleanLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function distanceInMeters(origin, target) {
  const radius = 6371000;
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(target.latitude);
  const deltaLat = toRadians(target.latitude - origin.latitude);
  const deltaLon = toRadians(target.longitude - origin.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;

  if (!PUBLIC_FILES.has(safePath)) {
    response.writeHead(404).end("Not found");
    return;
  }

  const resolvedPath = path.normalize(path.join(__dirname, safePath));

  if (!resolvedPath.startsWith(__dirname)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(resolvedPath);
    const contentType =
      MIME_TYPES[path.extname(resolvedPath)] || "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (requestUrl.pathname === "/api/fuel.xml") {
      const force = requestUrl.searchParams.get("fresh") === "1";
      const xml = await readFreshCachedXml(force);
      response.writeHead(200, {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(xml);
      return;
    }

    if (requestUrl.pathname === "/api/brands" && request.method === "POST") {
      const body = await readJsonBody(request);
      const brands = await findStationBrands(Array.isArray(body.stations) ? body.stations : []);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ brands }));
      return;
    }

    if (requestUrl.pathname === "/api/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, dataUrl: DATA_URL }));
      return;
    }

    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Prix carburants local: http://${HOST}:${PORT}`);
  console.log(`Flux utilise: ${DATA_URL}`);
});
