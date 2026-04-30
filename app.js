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
};

const elements = {
  dataStatus: document.querySelector("#dataStatus"),
  fuelSelect: document.querySelector("#fuelSelect"),
  locateButton: document.querySelector("#locateButton"),
  refreshButton: document.querySelector("#refreshButton"),
  stationList: document.querySelector("#stationList"),
  summaryTitle: document.querySelector("#summaryTitle"),
  summaryText: document.querySelector("#summaryText"),
  favoriteCount: document.querySelector("#favoriteCount"),
  stationTemplate: document.querySelector("#stationTemplate"),
  sortToggleButtons: document.querySelectorAll("[data-sort-toggle]"),
  viewButtons: document.querySelectorAll("[data-view]"),
};

init();

async function init() {
  syncControlsFromState();
  writeUrlState("replace");
  bindEvents();
  await loadStations();
  locateUser();
}

function bindEvents() {
  elements.fuelSelect.addEventListener("change", (event) => {
    state.selectedFuel = event.target.value;
    writeUrlState("push");
    render();
  });

  elements.locateButton.addEventListener("click", locateUser);

  elements.refreshButton.addEventListener("click", async () => {
    await loadStations(true);
    render();
  });

  elements.sortToggleButtons.forEach((button) => {
    button.addEventListener("click", () => {
      cycleSort(button.dataset.sortToggle);
      writeUrlState("push");
      render();
    });
  });

  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      writeUrlState("push");
      render();
    });
  });

  window.addEventListener("popstate", () => {
    const nextState = readUrlState();
    state.selectedFuel = nextState.selectedFuel;
    state.sortBy = nextState.sortBy;
    state.sortOrder = nextState.sortOrder;
    state.view = nextState.view;
    render();
  });
}

async function loadStations(force = false) {
  setStatus("Chargement du flux", "");
  state.isLoading = true;
  render();

  try {
    const response = await fetch(`/api/fuel.xml${force ? "?fresh=1" : ""}`);
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      throw new Error(details.error || "Flux impossible à charger");
    }

    const xml = await response.text();
    state.stations = parseStations(xml);
    state.isLoading = false;
    setStatus(`${state.stations.length.toLocaleString("fr-FR")} stations`, "ready");
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
  elements.locateButton.textContent = "Localisation...";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.userPosition = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        label: "Ta position",
      };
      elements.locateButton.disabled = false;
      elements.locateButton.innerHTML = '<span aria-hidden="true">◎</span> Me géolocaliser';
      render();
    },
    () => {
      state.userPosition = DEFAULT_POSITION;
      elements.locateButton.disabled = false;
      elements.locateButton.innerHTML = '<span aria-hidden="true">◎</span> Me géolocaliser';
      render();
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

  if (state.isLoading) {
    elements.summaryTitle.textContent = "Chargement en cours";
    elements.summaryText.textContent = "Récupération du flux officiel et préparation de la liste.";
    showEmpty("Chargement des stations...");
    return;
  }

  if (!state.userPosition) {
    elements.summaryTitle.textContent = "Position attendue";
    elements.summaryText.textContent = "Autorise la géolocalisation ou relance la demande.";
    showEmpty("En attente de ta position.");
    return;
  }

  const rows = buildRows();
  const isFavoritesView = state.view === "favorites";
  const list = isFavoritesView ? rows.filter((row) => state.favorites.includes(row.id)) : rows;
  const displayed = isFavoritesView ? sortRows(list).slice(0, 5) : sortNearestTen(rows);

  elements.summaryTitle.textContent = isFavoritesView
    ? `Favoris ${state.selectedFuel}`
    : `10 stations pour ${state.selectedFuel}`;
  elements.summaryText.textContent = getSummaryText();

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
      const price = station.prices.get(state.selectedFuel);
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

  price.textContent = `${state.selectedFuel} ${formatPrice(station.price.value)}`;
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
    elements.summaryTitle.textContent = "Limite atteinte";
    elements.summaryText.textContent = "Tu peux conserver 5 stations favorites maximum.";
    return;
  }

  localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites));
  render();
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

function cycleSort(sortBy) {
  if (state.sortBy !== sortBy) {
    state.sortBy = sortBy;
    state.sortOrder = "asc";
    return;
  }

  if (state.sortOrder === "asc") {
    state.sortOrder = "desc";
    return;
  }

  state.sortBy = "none";
  state.sortOrder = "asc";
}

function syncControlsFromState() {
  elements.fuelSelect.value = state.selectedFuel;
  elements.sortToggleButtons.forEach((button) => {
    const sortBy = button.dataset.sortToggle;
    const isActive = state.sortBy === sortBy;
    button.classList.toggle("active", isActive);
    button.querySelector(".sort-arrow").textContent = getSortArrow(sortBy);
    button.setAttribute("aria-pressed", String(isActive));
    button.setAttribute("aria-label", getSortLabel(sortBy));
  });
  elements.viewButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === state.view);
  });
}

function getSortArrow(sortBy) {
  if (state.sortBy !== sortBy) return "-";
  return state.sortOrder === "desc" ? "↓" : "↑";
}

function getSortLabel(sortBy) {
  const label = sortBy === "price" ? "prix" : "distance";
  if (state.sortBy !== sortBy) return `Activer le tri par ${label} croissant`;
  if (state.sortOrder === "asc") return `Passer le tri par ${label} en décroissant`;
  return `Désactiver le tri par ${label}`;
}

function getSummaryText() {
  if (state.sortBy === "none") {
    return `${state.userPosition.label} - ordre naturel autour de toi.`;
  }

  return `${state.userPosition.label} - tri par ${
    state.sortBy === "price" ? "prix" : "distance"
  } ${state.sortOrder === "desc" ? "décroissant" : "croissant"}.`;
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
  params.set("vue", VIEW_QUERY_VALUES[state.view]);
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
