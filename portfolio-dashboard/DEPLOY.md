# Deploying the Portfolio Status Dashboard to Railway

This app lives in the `portfolio-dashboard/` subfolder of the `gantt-Slider`
repo, so the one setting that matters is telling Railway to use that folder as
the service **Root Directory**. There's no database, so no volume is needed.

## Steps (~2 minutes)

1. Go to <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
2. Pick the **`gantt-Slider`** repo and the branch
   `claude/portfolio-status-dashboard-gFkUl` (or `master` once merged).
3. Open the service → **Settings** → **Root Directory** → set it to:
   ```
   portfolio-dashboard
   ```
   Railway will now use this folder's `Dockerfile` / `railway.json`.
4. (Optional) **Settings → Variables** to read from a real central repo instead
   of the bundled seed data:
   | Variable        | Example                                  |
   | --------------- | ---------------------------------------- |
   | `GITHUB_REPO`   | `YousafBarikzai/portfolio-status`        |
   | `GITHUB_PATH`   | `projects`                               |
   | `GITHUB_TOKEN`  | _(only if that repo is private)_         |
   > Don't set `PORT` — Railway provides it automatically.
5. **Settings → Networking → Generate Domain.** That URL is your live board.

## Updating

Push to the deployed branch and Railway rebuilds automatically. To change the
displayed status, edit the `status.json` files — in the central repo if you set
`GITHUB_REPO`, otherwise in `portfolio-dashboard/data/projects/` and redeploy.

## Notes

- The repo root also contains a separate "Project Planner" app with its own
  `Dockerfile`. Setting the **Root Directory** to `portfolio-dashboard` is what
  keeps Railway building *this* app and not that one.
- No persistent volume is required — this app is stateless and reads status on
  each request (with a short in-memory cache).
