# DDP Inventory Demo

A single-page React/TypeScript demo simulating a **DDP (Delivered Duty Paid) Brokerage** workflow for agricultural commodities. It covers the full cycle: farmer onboarding, inventory submission, DDP operator review, master inventory management, and a buyer preview portal.

All data is stored in **browser localStorage** — no backend, no database, no authentication.

---

## What this demo is

This is a static front-end prototype built with **Vite + React + TypeScript**. It demonstrates:

- Farmer portal — onboarding and inventory submission (EN/Thai)
- DDP operator dashboard — farm approval, inventory review, fulfilment packing queue
- Master inventory and buyer preview views

There is no server-side component. Resetting the demo clears localStorage and restores seed data.

---

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Other scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the `dist/` build locally |

---

## Deploy to Render (Static Site)

1. Push this repo to GitHub (or GitLab).
2. In [Render](https://render.com), click **New → Static Site**.
3. Connect your repository.
4. Set the following:

| Setting | Value |
|---|---|
| **Build Command** | `npm run build` |
| **Publish Directory** | `dist` |

5. Click **Create Static Site**. Render will install dependencies, build, and serve `dist/`.

No environment variables are required.

---

## Notes

- The app uses `react-router`-style in-app navigation (no actual URL routing), so all routes resolve to `index.html`. Render serves static sites from `index.html` by default, which is correct.
- Demo data resets via the **Reset Demo** button in the app; it does not affect the deployed build in any way.
