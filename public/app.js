const FUELS = ["Gazole", "E10", "SP95", "SP98", "E85", "GPLc"];
const FAVORITES_KEY = "prix-carburants:favorites";
const VIEW_QUERY_VALUES = {
  nearby: "autour",
  favorites: "favoris",
};
const ORDER_QUERY_VALUES = {
  asc: "croissant",
  desc: "decroissant",
};
const SORT_QUERY_VALUES = {
  distance: "distance",
  price: "prix",
  none: "aucun",
};
let versionCache = null;

const DEFAULT_POSITION = {
  latitude: 48.8566,
  longitude: 2.3522,
  label: "Paris par défaut",
};
const initialUrlState = readUrlState();

const state = {
  stations: [],
  userPosition: null,
  selectedFuel: initialUrlState.selectedFuel,
  sortBy: initialUrlState.sortBy,
  sortOrder: initialUrlState.sortOrder,
  view: initialUrlState.view,
  favorites: readFavorites(),
  brands: {},
  isBrandLookupRunning: false,
  isLoading: true,
  tankEditing: false,
  tankCapacity: readTankCapacity(),
};

const elements = {
  dataStatus: document.querySelector("#dataStatus"),
  fuelSelect: document.querySelector("#fuelSelect"),
  locateButton: document.querySelector("#locateButton"),
  stationList: document.querySelector("#stationList"),
  settingsPanel: document.querySelector("#settingsPanel"),
  favoriteCount: document.querySelector("#favoriteCount"),
  stationTemplate: document.querySelector("#stationTemplate"),
  sortTab: document.querySelector("#sortTab"),
  sortTabLabel: document.querySelector("#sortTabLabel"),
  settingsTabBtn: document.querySelector("#settingsTabBtn"),
  tankDecBtn: document.querySelector("#tankDecBtn"),
  tankIncBtn: document.querySelector("#tankIncBtn"),
  tankVal: document.querySelector("#tankVal"),
  tankCollapsedRow: document.querySelector("#tankCollapsedRow"),
  tankCollapsedVal: document.querySelector("#tankCollapsedVal"),
  tankStepperRow: document.querySelector("#tankStepperRow"),
  tankEditBtn: document.querySelector("#tankEditBtn"),
  settingsHint: document.querySelector("#settingsHint"),
  changelogHeader: document.querySelector("#changelogHeader"),
  changelogList: document.querySelector("#changelogList"),
  versionBadge: document.querySelector("#versionBadge"),
  versionSha: document.querySelector("#versionSha"),
  viewButtons: document.querySelectorAll("[data-view]"),
};

init();

async function init() {
  syncControlsFromState();
  writeUrlState("replace");
  bindEvents();
  initPullToRefresh();
  locateUser();
}

function bindEvents() {
  elements.fuelSelect.addEventListener("change", (event) => {
    state.selectedFuel = event.target.value;
    writeUrlState("push");
    loadStations();
  });

  elements.locateButton.addEventListener("click", locateUser);

  elements.sortTab.addEventListener("click", () => {
    if (state.view === "settings") {
      state.view = "nearby";
      state.tankEditing = false;
    }
    cycleAllSorts();
    writeUrlState("push");
    render();
  });

  elements.settingsTabBtn.addEventListener("click", () => {
    state.view = "settings";
    render();
    loadChangelog();
  });

  elements.tankDecBtn.addEventListener("click", () => {
    if (state.tankCapacity >= 5) {
      state.tankCapacity -= 5;
      saveTankCapacity(state.tankCapacity);
      render();
    }
  });

  elements.tankIncBtn.addEventListener("click", () => {
    if (state.tankCapacity <= 195) {
      state.tankCapacity += 5;
      saveTankCapacity(state.tankCapacity);
      render();
    }
  });

  elements.tankEditBtn.addEventListener("click", () => {
    state.tankEditing = true;
    syncControlsFromState();
  });

  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.tankEditing = false;
      state.view = button.dataset.view;
      writeUrlState("push");
      loadStations();
    });
  });

  window.addEventListener("popstate", () => {
    const nextState = readUrlState();
    state.selectedFuel = nextState.selectedFuel;
    state.sortBy = nextState.sortBy;
    state.sortOrder = nextState.sortOrder;
    state.view = nextState.view;
    loadStations();
  });
}

async function loadStations(force = false) {
  if (!state.userPosition) {
    state.isLoading = false;
    render();
    return;
  }

  if (state.view === "favorites" && state.favorites.length === 0) {
    state.stations = [];
    state.isLoading = false;
    setStatus("Favoris 0/5", "ready");
    render();
    return;
  }

  setStatus("Chargement du flux", "");
  state.isLoading = true;
  render();

  try {
    const params = new URLSearchParams({
      fuel: state.selectedFuel,
      lat: String(state.userPosition.latitude),
      lon: String(state.userPosition.longitude),
    });

    if (state.view === "favorites") {
      params.set("ids", state.favorites.join(","));
    }
    if (force) {
      params.set("fresh", "1");
    }

    const response = await fetch(`/api/stations?${params.toString()}`);
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || "Flux impossible à charger");
    }

    const data = await response.json();
    state.stations = Array.isArray(data.stations) ? data.stations : [];
    state.isLoading = false;
    setStatus(
      `${state.stations.length.toLocaleString("fr-FR")} station${
        state.stations.length > 1 ? "s" : ""
      }`,
      "ready"
    );
    render();
  } catch (error) {
    state.isLoading = false;
    setStatus("Flux indisponible", "error");
    showEmpty(
      "Impossible de charger les données carburants. Vérifie ta connexion puis rafraîchis."
    );
    console.error(error);
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    state.userPosition = DEFAULT_POSITION;
    render();
    return;
  }

  elements.locateButton.disabled = true;
  elements.locateButton.style.opacity = "0.5";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userPosition = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label: "Ta position",
      };
      elements.locateButton.disabled = false;
      elements.locateButton.style.opacity = "";
      loadStations();
    },
    () => {
      state.userPosition = DEFAULT_POSITION;
      elements.locateButton.disabled = false;
      elements.locateButton.style.opacity = "";
      loadStations();
    },
    { enableHighAccuracy: true, timeout: 9000, maximumAge: 60000 }
  );
}

function parseStations(xml) {
  const documentXml = new DOMParser().parseFromString(xml, "application/xml");
  const parserError = documentXml.querySelector("parsererror");

  if (parserError) {
    throw new Error("XML carburants invalide.");
  }

  return [...documentXml.querySelectorAll("pdv")]
    .map((node) => {
      const latitude = Number(node.getAttribute("latitude")) / 100000;
      const longitude = Number(node.getAttribute("longitude")) / 100000;
      const city = formatFrenchLabel(text(node.querySelector("ville")));
      const address = formatFrenchLabel(text(node.querySelector("adresse")));
      const prices = new Map(
        [...node.querySelectorAll("prix")]
          .filter((priceNode) => FUELS.includes(priceNode.getAttribute("nom")))
          .map((priceNode) => [
            priceNode.getAttribute("nom"),
            {
              value: Number(priceNode.getAttribute("valeur")),
              updatedAt: priceNode.getAttribute("maj") || "",
            },
          ])
      );

      return {
        id: node.getAttribute("id"),
        latitude,
        longitude,
        postalCode: node.getAttribute("cp") || "",
        city,
        address,
        prices,
        isClosed: Boolean(node.querySelector('fermeture[type="definitive"]')),
      };
    })
    .filter(
      (station) =>
        station.id &&
        Number.isFinite(station.latitude) &&
        Number.isFinite(station.longitude) &&
        !station.isClosed
    );
}

function render() {
  syncControlsFromState();
  updateFavoriteCount();

  if (state.view === "settings") {
    elements.stationList.hidden = true;
    elements.settingsPanel.hidden = false;
    return;
  }

  elements.stationList.hidden = false;
  elements.settingsPanel.hidden = true;

  if (state.isLoading) {
    showEmpty("Chargement des stations...");
    return;
  }

  if (!state.userPosition) {
    showEmpty("En attente de ta position.");
    return;
  }

  const rows = buildRows();
  const isFavoritesView = state.view === "favorites";
  const list = isFavoritesView ? rows.filter((row) => state.favorites.includes(row.id)) : rows;
  const displayed = isFavoritesView ? sortRows(list).slice(0, 5) : sortNearestTen(rows);

  if (displayed.length === 0) {
    showEmpty(
      isFavoritesView
        ? "Aucun favori avec ce carburant pour le moment."
        : "Aucune station trouvée avec ce carburant autour de cette position."
    );
    return;
  }

  elements.stationList.replaceChildren(...displayed.map(renderStation));
  enrichBrands(displayed);
}

function buildRows() {
  return state.stations
    .map((station) => {
      const price = station.price || station.prices?.get(state.selectedFuel);
      if (!price) return null;
      return {
        ...station,
        price,
        distance: distanceInKm(state.userPosition, station),
      };
    })
    .filter(Boolean);
}

function sortNearestTen(rows) {
  const nearest = [...rows].sort((a, b) => a.distance - b.distance).slice(0, 10);
  return sortRows(nearest);
}

function sortRows(rows) {
  if (state.sortBy === "none") {
    return rows;
  }

  return [...rows].sort((a, b) => {
    const orderFactor = state.sortOrder === "desc" ? -1 : 1;
    if (state.sortBy === "price") {
      return (
        orderFactor * (a.price.value - b.price.value) ||
        a.distance - b.distance
      );
    }
    return orderFactor * (a.distance - b.distance) || a.price.value - b.price.value;
  });
}

function renderStation(station) {
  const fragment = elements.stationTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".station-card");
  const title = fragment.querySelector("h2");
  const address = fragment.querySelector(".station-address");
  const favoriteButton = fragment.querySelector(".favorite-button");
  const price = fragment.querySelector(".price-chip");
  const distance = fragment.querySelector(".distance-chip");
  const update = fragment.querySelector(".update-chip");
  const brand = state.brands[station.id];
  const isFavorite = state.favorites.includes(station.id);

  title.textContent = brand?.label || station.city || `Station ${station.id}`;
  address.textContent = [station.address, station.postalCode, station.city]
    .filter(Boolean)
    .join(" ");
  favoriteButton.textContent = isFavorite ? "★" : "☆";
  favoriteButton.classList.toggle("active", isFavorite);
  favoriteButton.setAttribute(
    "aria-label",
    isFavorite ? "Retirer des favoris" : "Ajouter aux favoris"
  );
  favoriteButton.addEventListener("click", () => toggleFavorite(station.id));

  if (state.tankCapacity > 0) {
    const total = station.price.value * state.tankCapacity;
    price.textContent = `${state.selectedFuel} ${formatPrice(station.price.value)} · ~${formatEuros(total)}`;
  } else {
    price.textContent = `${state.selectedFuel} ${formatPrice(station.price.value)}`;
  }
  distance.textContent = `${formatDistance(station.distance)}`;
  update.textContent = station.price.updatedAt
    ? `MAJ ${formatUpdateDate(station.price.updatedAt)}`
    : "MAJ inconnue";
  card.dataset.stationId = station.id;

  return fragment;
}

async function enrichBrands(stations) {
  const missingStations = stations.filter(
    (station) => !Object.hasOwn(state.brands, station.id)
  );

  if (state.isBrandLookupRunning || missingStations.length === 0) {
    return;
  }

  state.isBrandLookupRunning = true;

  try {
    const response = await fetch("/api/brands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stations: missingStations.map((station) => ({
          id: station.id,
          latitude: station.latitude,
          longitude: station.longitude,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error("Enseignes indisponibles");
    }

    const data = await response.json();
    state.brands = {
      ...state.brands,
      ...(data.brands || {}),
    };
    render();
  } catch (error) {
    console.warn(error);
  } finally {
    state.isBrandLookupRunning = false;
  }
}

function toggleFavorite(stationId) {
  if (state.favorites.includes(stationId)) {
    state.favorites = state.favorites.filter((id) => id !== stationId);
  } else if (state.favorites.length < 5) {
    state.favorites = [...state.favorites, stationId];
  } else {
    return;
  }

  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  if (state.view === "favorites") {
    loadStations();
    return;
  }
  render();
}

function readTankCapacity() {
  const val = parseInt(localStorage.getItem("ecoplein:tank") || "0", 10);
  return Number.isFinite(val) && val >= 0 ? val : 0;
}

function saveTankCapacity(val) {
  localStorage.setItem("ecoplein:tank", String(val));
}

function readFavorites() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function updateFavoriteCount() {
  elements.favoriteCount.textContent = `${state.favorites.length}/5`;
}

const SORT_CYCLE = [
  { sortBy: "distance", sortOrder: "asc" },
  { sortBy: "distance", sortOrder: "desc" },
  { sortBy: "price", sortOrder: "asc" },
  { sortBy: "price", sortOrder: "desc" },
  { sortBy: "none", sortOrder: "asc" },
];

function cycleAllSorts() {
  const idx = SORT_CYCLE.findIndex(
    (s) => s.sortBy === state.sortBy && s.sortOrder === state.sortOrder
  );
  const next = SORT_CYCLE[(idx + 1) % SORT_CYCLE.length];
  state.sortBy = next.sortBy;
  state.sortOrder = next.sortOrder;
}

function syncControlsFromState() {
  elements.fuelSelect.value = state.selectedFuel;

  const sortLabel = getSortTabLabel();
  elements.sortTabLabel.textContent = sortLabel;
  elements.sortTab.classList.toggle("active", state.sortBy !== "none" && state.view !== "settings");
  elements.settingsTabBtn.classList.toggle("active", state.view === "settings");

  elements.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });

  const cap = state.tankCapacity;
  const showCollapsed = cap > 0 && !state.tankEditing;
  elements.tankCollapsedRow.hidden = !showCollapsed;
  elements.tankStepperRow.hidden = showCollapsed;
  elements.settingsHint.hidden = showCollapsed;
  elements.tankCollapsedVal.textContent = `${cap} L`;
  elements.tankVal.textContent = cap > 0 ? `${cap} L` : "— L";
  elements.tankDecBtn.disabled = cap <= 0;
  elements.tankIncBtn.disabled = cap >= 200;
}

function getSortTabLabel() {
  if (state.sortBy === "none") return "Trier";
  const name = state.sortBy === "price" ? "Prix" : "Distance";
  const arrow = state.sortOrder === "desc" ? " ↓" : " ↑";
  return name + arrow;
}


function readUrlState() {
  const params = new URLSearchParams(window.location.search);

  return {
    selectedFuel: readFuelParam(params),
    sortBy: readSortParam(params),
    sortOrder: readOrderParam(params),
    view: readViewParam(params),
  };
}

function readFuelParam(params) {
  const requestedFuel = params.get("carburant") || params.get("fuel") || "Gazole";
  return (
    FUELS.find((fuel) => fuel.toLocaleLowerCase("fr-FR") === requestedFuel.toLocaleLowerCase("fr-FR")) ||
    "Gazole"
  );
}

function readSortParam(params) {
  const requestedSort = (params.get("tri") || params.get("sort") || "distance").toLowerCase();
  if (requestedSort === "prix" || requestedSort === "price") {
    return "price";
  }
  if (["aucun", "none", "rien"].includes(requestedSort)) {
    return "none";
  }
  return "distance";
}

function readOrderParam(params) {
  const requestedOrder = (params.get("ordre") || params.get("order") || "croissant")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

  if (["decroissant", "desc", "descending"].includes(requestedOrder)) {
    return "desc";
  }
  return "asc";
}

function readViewParam(params) {
  const requestedView = (params.get("vue") || params.get("view") || "autour").toLowerCase();
  if (["favoris", "favori", "favorites", "favorite"].includes(requestedView)) {
    return "favorites";
  }
  return "nearby";
}

function writeUrlState(mode = "replace") {
  const params = new URLSearchParams(window.location.search);
  params.set("carburant", state.selectedFuel);
  params.set("tri", SORT_QUERY_VALUES[state.sortBy]);
  if (state.sortBy === "none") {
    params.delete("ordre");
  } else {
    params.set("ordre", ORDER_QUERY_VALUES[state.sortOrder]);
  }
  if (state.view !== "settings") {
    params.set("vue", VIEW_QUERY_VALUES[state.view]);
  }
  params.delete("fuel");
  params.delete("sort");
  params.delete("order");
  params.delete("view");

  const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
  if (nextUrl === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    return;
  }

  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method]({}, "", nextUrl);
}

function showEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  elements.stationList.replaceChildren(empty);
}

function setStatus(message, type) {
  elements.dataStatus.textContent = message;
  elements.dataStatus.className = `status-pill ${type}`.trim();
}

function text(node) {
  return node?.textContent?.trim() || "";
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

function distanceInKm(origin, station) {
  const radius = 6371;
  const lat1 = toRadians(origin.latitude);
  const lat2 = toRadians(station.latitude);
  const deltaLat = toRadians(station.latitude - origin.latitude);
  const deltaLon = toRadians(station.longitude - origin.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function formatPrice(value) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
  }).format(value);
}

function formatDistance(value) {
  if (value < 1) {
    return `${Math.round(value * 1000)} m`;
  }
  return `${value.toLocaleString("fr-FR", {
    maximumFractionDigits: 1,
  })} km`;
}

function formatEuros(value) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatUpdateDate(value) {
  const normalized = value.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

async function loadChangelog() {
  if (versionCache) {
    renderChangelog(versionCache);
    return;
  }

  // Show loading placeholder
  elements.changelogHeader.hidden = true;
  elements.changelogList.hidden = false;
  elements.changelogList.innerHTML = '<li class="changelog-loading">Chargement de l\'historique…</li>';

  try {
    const res = await fetch("/api/version");
    if (!res.ok) throw new Error("unavailable");
    const data = await res.json();
    versionCache = data;
    renderChangelog(data);
  } catch {
    elements.changelogList.innerHTML = '<li class="changelog-loading">Historique indisponible</li>';
  }
}

function renderChangelog(data) {
  // Version badge
  elements.versionBadge.textContent = data.version;
  elements.versionSha.textContent = `· ${data.sha}`;
  elements.changelogHeader.hidden = false;

  // Commits list
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const items = data.commits.map((c) => {
    const date = new Date(c.date);
    date.setHours(0, 0, 0, 0);
    let dateLabel;
    if (date.getTime() === today.getTime()) {
      dateLabel = "aujourd'hui";
    } else if (date.getTime() === yesterday.getTime()) {
      dateLabel = "hier";
    } else {
      dateLabel = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(date);
    }

    const li = document.createElement("li");
    li.className = `changelog-item${c.current ? " current" : ""}`;
    li.innerHTML = `
      <div class="changelog-item-top">
        <span class="changelog-dot" aria-hidden="true"></span>
        <span class="changelog-sha">${c.sha}</span>
        <span class="changelog-date">${dateLabel}</span>
      </div>
      <p class="changelog-message"></p>
    `;
    li.querySelector(".changelog-message").textContent = c.message;
    return li;
  });

  elements.changelogList.hidden = false;
  elements.changelogList.replaceChildren(...items);
}

function initPullToRefresh() {
  const indicator = document.getElementById("ptrIndicator");
  const THRESHOLD = 72;
  let startY = 0;
  let active = false;

  document.addEventListener("touchstart", (e) => {
    if (window.scrollY === 0 && !state.isLoading) {
      startY = e.touches[0].clientY;
      active = true;
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!active) return;
    const pull = Math.max(0, e.touches[0].clientY - startY);
    if (pull === 0) return;
    const progress = Math.min(pull / THRESHOLD, 1);
    const offset = -52 + 68 * progress;
    indicator.style.top = `${offset}px`;
    indicator.style.opacity = String(progress);
    indicator.classList.toggle("ptr-ready", pull >= THRESHOLD);
  }, { passive: true });

  document.addEventListener("touchend", async () => {
    if (!active) return;
    active = false;
    const triggered = indicator.classList.contains("ptr-ready");
    indicator.classList.remove("ptr-ready");

    if (triggered) {
      indicator.style.top = "";
      indicator.style.opacity = "";
      indicator.classList.add("ptr-spinning");
      await loadStations(true);
      indicator.classList.remove("ptr-spinning");
    } else {
      indicator.style.top = "";
      indicator.style.opacity = "";
    }
  });
}
