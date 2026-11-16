# EV Charge

A free web app to find EV charging stations near you (all of India), see availability at partner
stations and book a 30-minute slot. Built to test product-market fit at zero cost.

- **Live site:** https://findevcharger.github.io/
- **Hosting:** GitHub Pages, served from the `docs/` folder
- **Sign-in and database:** Firebase (Google sign-in + Firestore, free Spark plan)
- **Map:** Leaflet + OpenStreetMap
- **Station data:** Open Charge Map (© Open Charge Map contributors)

## How it works

- `docs/stations.json` holds the station list (read-only, built from Open Charge Map).
- Firestore holds only the live parts: `partners` (charger status, hours, price),
  `slotLocks` (one document per charger per slot), `bookings`, `users`, `reports`.
- `firestore.rules` never lets a slot lock be overwritten, so a slot cannot be booked twice.
- The admin opens any station in the app and makes it a bookable partner station by
  entering the owner's Google email. That owner then gets a "My stations" tab.

## Updating

- Change the app: edit files in `docs/`, commit and push. The site updates in about a minute.
- Change database rules: paste `firestore.rules` into Firebase console → Firestore → Rules → Publish.
- Refresh station data: download from the Open Charge Map API into `data/`, then run
  `node scripts/build-stations.mjs`.
