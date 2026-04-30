import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const DATA_URL =
  process.env.FUEL_DATA_URL ||
  "https://donnees.roulez-eco.fr/opendata/instantane_ruptures";
const OVERPASS_URL =
  process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";
const CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const BRAND_SEARCH_RADIUS_METERS = 110;
const FUELS = ["Gazole", "E10", "SP95", "SP98", "E85", "GPLc"];

export async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") {
    return request.body;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function readFreshCachedXml(force = false, cacheDir = defaultCacheDir()) {
  const paths = cachePaths(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });

  if (!force && (await pathExists(paths.xml))) {
    const stat = await fs.stat(paths.xml);
    if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
      const cachedXml = await fs.readFile(paths.xml, "utf8");
      if (!hasBrokenEncoding(cachedXml) || !(await pathExists(paths.zip))) {
        return normalizeXmlDeclaration(cachedXml);
      }

      const repairedXml = extractXmlFromZip(await fs.readFile(paths.zip));
      await fs.writeFile(paths.xml, repairedXml);
      return repairedXml;
    }
  }

  try {
    const response = await fetch(DATA_URL, {
      headers: { "User-Agent": "ecoplein/0.1" },
    });

    if (!response.ok) {
      throw new Error(`Flux indisponible (${response.status})`);
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer());
    const xml = extractXmlFromZip(zipBuffer);
    await fs.writeFile(paths.zip, zipBuffer);
    await fs.writeFile(paths.xml, xml);
    return xml;
  } catch (error) {
    if (await pathExists(paths.xml)) {
      console.warn(`Utilisation du cache XML existant: ${error.message}`);
      const cachedXml = await fs.readFile(paths.xml, "utf8");
      if (hasBrokenEncoding(cachedXml) && (await pathExists(paths.zip))) {
        const repairedXml = extractXmlFromZip(await fs.readFile(paths.zip));
        await fs.writeFile(paths.xml, repairedXml);
        return repairedXml;
      }
      return normalizeXmlDeclaration(cachedXml);
    }
    throw error;
  }
}

export async function findStationBrands(stations, cacheDir = defaultCacheDir()) {
  const cache = await readBrandCache(cacheDir);
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

    await writeBrandCache(cache, cacheDir);
  }

  return Object.fromEntries(
    uniqueStations
      .filter((station) => cache[station.id])
      .map((station) => [station.id, cache[station.id]])
  );
}

export async function getStationRows({
  fuel = "Gazole",
  latitude,
  longitude,
  ids = [],
  limit = 10,
  force = false,
} = {}) {
  const selectedFuel = FUELS.includes(fuel) ? fuel : "Gazole";
  const xml = await readFreshCachedXml(force);
  const stations = parseFuelStations(xml);
  const idSet = new Set(ids.filter(Boolean));
  const hasIds = idSet.size > 0;
  const origin = {
    latitude: Number(latitude),
    longitude: Number(longitude),
  };

  const rows = stations
    .filter((station) => {
      if (station.isClosed || !station.prices.has(selectedFuel)) return false;
      if (hasIds) return idSet.has(station.id);
      return true;
    })
    .map((station) => ({
      id: station.id,
      latitude: station.latitude,
      longitude: station.longitude,
      postalCode: station.postalCode,
      city: station.city,
      address: station.address,
      price: station.prices.get(selectedFuel),
      distance:
        Number.isFinite(origin.latitude) && Number.isFinite(origin.longitude)
          ? distanceInKilometers(origin, station)
          : null,
    }))
    .filter((station) => hasIds || Number.isFinite(station.distance));

  if (hasIds) {
    return rows;
  }

  return rows
    .sort((a, b) => a.distance - b.distance || a.price.value - b.price.value)
    .slice(0, limit);
}

export function defaultCacheDir() {
  return process.env.VERCEL
    ? path.join(os.tmpdir(), "ecoplein-cache")
    : path.join(process.cwd(), ".cache");
}

function cachePaths(cacheDir) {
  return {
    zip: path.join(cacheDir, "prix-carburants.zip"),
    xml: path.join(cacheDir, "prix-carburants.xml"),
    brands: path.join(cacheDir, "station-brands.json"),
  };
}

function parseFuelStations(xml) {
  return [...xml.matchAll(/<pdv\b([^>]*)>([\s\S]*?)<\/pdv>/g)]
    .map((match) => {
      const attributes = parseAttributes(match[1]);
      const body = match[2];
      const latitude = Number(attributes.latitude) / 100000;
      const longitude = Number(attributes.longitude) / 100000;
      const prices = new Map(
        [...body.matchAll(/<prix\b([^>]*)\/?>/g)]
          .map((priceMatch) => parseAttributes(priceMatch[1]))
          .filter((price) => FUELS.includes(price.nom))
          .map((price) => [
            price.nom,
            {
              value: Number(price.valeur),
              updatedAt: price.maj || "",
            },
          ])
      );

      return {
        id: attributes.id,
        latitude,
        longitude,
        postalCode: attributes.cp || "",
        city: formatFrenchLabel(readXmlText(body, "ville")),
        address: formatFrenchLabel(readXmlText(body, "adresse")),
        prices,
        isClosed: /<fermeture\b[^>]*type=["']definitive["']/i.test(body),
      };
    })
    .filter(
      (station) =>
        station.id &&
        Number.isFinite(station.latitude) &&
        Number.isFinite(station.longitude)
    );
}

function parseAttributes(value) {
  return Object.fromEntries(
    [...value.matchAll(/([\w:-]+)=["']([^"']*)["']/g)].map((match) => [
      match[1],
      decodeXmlEntities(match[2]),
    ])
  );
}

function readXmlText(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return decodeXmlEntities(match?.[1] || "").trim();
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function formatFrenchLabel(value) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed !== trimmed.toLocaleUpperCase("fr-FR")) {
    return trimmed;
  }

  const lower = trimmed.toLocaleLowerCase("fr-FR");
  return lower
    .replace(/(^|[\s'-])([\p{L}])/gu, (match, separator, letter) => {
      return `${separator}${letter.toLocaleUpperCase("fr-FR")}`;
    })
    .replace(/\b(De|Du|Des|La|Le|Les|Lès|Sur|Sous|Aux|Au)\b/g, (word) =>
      word.toLocaleLowerCase("fr-FR")
    );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readBrandCache(cacheDir) {
  const paths = cachePaths(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });

  if (!(await pathExists(paths.brands))) {
    return {};
  }

  try {
    return JSON.parse(await fs.readFile(paths.brands, "utf8"));
  } catch {
    return {};
  }
}

async function writeBrandCache(cache, cacheDir) {
  const paths = cachePaths(cacheDir);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(paths.brands, JSON.stringify(cache, null, 2));
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
      "User-Agent": "ecoplein/0.1",
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

function distanceInKilometers(origin, target) {
  return distanceInMeters(origin, target) / 1000;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}
