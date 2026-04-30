# ecoplein — Contexte projet

Application web mobile (PWA) affichant les prix des carburants en temps réel autour de l'utilisateur, sourcés depuis le flux officiel gouvernemental français.

URL de production : https://ecoplein.vercel.app  
Dépôt GitHub : https://github.com/benjj2500-ctrl/ecoplein  
Projet Vercel : https://vercel.com/benjj2500-5777s-projects/ecoplein

---

## Architecture des fichiers

```
ecoplein/
├── api/
│   ├── stations.js      — Serverless: récupère le flux XML gouvernemental, filtre par carburant + position
│   └── brands.js        — Serverless: recherche le nom de marque via l'API Overpass (OpenStreetMap)
├── lib/
│   └── fuel-data.mjs    — Logique partagée côté serveur : parsing XML, géodistance, requêtes Overpass
├── public/
│   ├── index.html       — Shell HTML (topbar, tabbar, templates)
│   ├── app.js           — Logique client (état, rendu, géolocalisation, pull-to-refresh)
│   └── styles.css       — Styles CSS (design system, composants)
├── vercel.json          — Config déploiement Vercel (builds explicites)
├── .vercelignore        — Exclut .cache du déploiement
└── CONTEXT.md           — Ce fichier
```

---

## Stack technique

- **Zéro framework** : HTML/CSS/JS vanilla côté client
- **Serverless** : Vercel Functions (Node.js, `@vercel/node`)
- **Statique** : `@vercel/static` pour `public/`
- **Données** : flux XML gouvernemental `data.economie.gouv.fr/carburants`
- **Noms de marque** : Overpass API (OpenStreetMap), deux phases (ID direct + rayon de proximité)
- **Persistance** : `localStorage` uniquement (favoris + capacité réservoir)

---

## Déploiement Vercel

Le `vercel.json` utilise un tableau `builds` explicite pour éviter la détection automatique Node.js qui confondait `app.js` ou `server.mjs` comme point d'entrée.

```json
{
  "version": 2,
  "builds": [
    { "src": "api/stations.js", "use": "@vercel/node", "config": { "maxDuration": 30 } },
    { "src": "api/brands.js",   "use": "@vercel/node", "config": { "maxDuration": 30 } },
    { "src": "public/**",       "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/stations", "dest": "/api/stations.js" },
    { "src": "/api/brands",   "dest": "/api/brands.js" },
    { "src": "/(.*)",          "dest": "/public/$1" }
  ]
}
```

---

## État applicatif (`state` dans app.js)

| Clé | Type | Description |
|-----|------|-------------|
| `stations` | Array | Stations chargées depuis l'API |
| `userPosition` | Object\|null | `{latitude, longitude, label}` |
| `selectedFuel` | string | Gazole / E10 / SP95 / SP98 / E85 / GPLc |
| `sortBy` | string | `distance` / `price` / `none` |
| `sortOrder` | string | `asc` / `desc` |
| `view` | string | `nearby` / `favorites` |
| `favorites` | string[] | IDs des stations favorites (max 5) |
| `brands` | Object | Cache `stationId → {label}` |
| `settingsOpen` | boolean | Panneau Réglages ouvert |
| `tankEditing` | boolean | Stepper réservoir en cours d'édition |
| `tankCapacity` | number | Litres (0 = désactivé), paliers de 5 L |

### localStorage
- `prix-carburants:favorites` — JSON array d'IDs
- `ecoplein:tank` — capacité réservoir en litres

---

## Design system

Variables CSS définies dans `:root` de `styles.css` :

| Variable | Valeur | Usage |
|----------|--------|-------|
| `--bg` | `#f6f7f4` | Fond général |
| `--ink` | `#1d2623` | Texte principal |
| `--muted` | `#68746f` | Texte secondaire |
| `--line` | `#d9ded7` | Bordures |
| `--green` | `#0f7b63` | Accent principal |
| `--green-dark` | `#0b5f4d` | Texte vert |
| `--coral` | `#d85f47` | Favoris |
| `--topbar-h` | `56px` | Hauteur topbar |
| `--tabbar-h` | `calc(56px + env(safe-area-inset-bottom))` | Tabbar + safe area iPhone |

---

## Composants UI clés

### Topbar
- `.fuel-pill` — sélecteur carburant (fond noir, select natif blanc)
- `#dataStatus` — pastille de statut (chargement / nb stations / erreur)
- `#locateButton` — bouton géolocalisation

### Tabbar (4 onglets)
- **Autour** (`data-view="nearby"`) — 10 stations les plus proches, puis triées
- **Favoris** (`data-view="favorites"`) — jusqu'à 5 favoris
- **Trier** (`#sortTab`) — cycle 5 états : dist↑ dist↓ prix↑ prix↓ aucun
- **Réglages** (`#settingsTabBtn`) — toggle du panneau paramètres

### Station card
- Titre : nom de marque OSM ou ville
- `.price-chip` — `Gazole 1,759 €/L · ~88 €` (si réservoir configuré) ou `Gazole 1,759 €/L`
- `.distance-chip` — distance en m ou km
- `.update-chip` — date de mise à jour du prix
- `.favorite-button` — ☆/★ toggle

### Panneau Réglages
- Réservoir : stepper 5–200 L par paliers de 5
- Comportement : si valeur > 0, affiche une ligne compacte "Réservoir · 50 L · ✎ Modifier"
  Le stepper se ré-ouvre au clic sur "Modifier", et se referme en quittant l'onglet

### Pull-to-refresh
- Détection touch : glissement depuis `scrollY === 0`
- Seuil : 72 px
- Indicateur animé `#ptrIndicator` avec spin CSS

---

## Détection de marques (OSM)

Fichier : `lib/fuel-data.mjs`

Deux phases :
1. **ID direct** — recherche par `ref:FR:prix-carburants` (ID gouvernemental)
2. **Proximité** — rayon de 150 m autour des coordonnées GPS non résolues

Tags OSM prioritaires pour le libellé : `brand`, `brand:fr`, `name:fr`, `name`, `operator`

---

## Changelog

### 2026-04 (session 2)
- **Chip compact option A** : prix €/L + estimation plein en une seule ligne `· ~XX €`
- **Réglages réservoir** : stepper masqué après saisie ; ligne compacte avec bouton "✎ Modifier"
- **CONTEXT.md** créé

### 2026-04 (session 1)
- Ajout capacité réservoir (localStorage `ecoplein:tank`)
- Chip de station : affichage empilé prix €/L + coût plein estimé
- 4ème onglet Réglages (stepper de capacité réservoir)
- Correction bug iPhone : texte carte collapsé verticalement (passage de grid 2 colonnes à flex colonne)
- Redesign UI mobile : topbar compacte + tabbar bottom (Option C)
- Pull-to-refresh avec animation spinner
- Suppression de la bande de résumé
- Amélioration détection OSM : ID direct + rayon 150 m + tags `brand:fr`/`name:fr`
- Déploiement Vercel production (builds explicites dans vercel.json)
- Dépôt GitHub : https://github.com/benjj2500-ctrl/ecoplein
