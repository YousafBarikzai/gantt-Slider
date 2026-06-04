# Deploying to Railway

This app is a Node server + SQLite database, so it needs Railway (not a static
host). A `Dockerfile` is included; Railway builds it automatically.

## One-time setup

### 1. Create the project

1. Go to <https://railway.app> → **New Project** → **Deploy from GitHub repo**.
2. Pick the **`gantt-Slider`** repo and the branch you want to deploy.
3. Railway detects the `Dockerfile` and starts building. Let the first build
   finish (it will be running, but read step 2 before you use it).

### 2. Add a persistent Volume (IMPORTANT — do this before relying on it)

Railway's filesystem resets on every redeploy, so the database must live on a
Volume or you'll lose your data.

1. Open the service → **Variables/Settings** → **Volumes** → **New Volume**.
2. Set the **Mount path** to `/data`.
   (The Dockerfile already sets `DATA_DIR=/data`, so the DB will be stored there.)

### 3. Set environment variables

Service → **Variables** → add:

| Variable         | Value                                             |
| ---------------- | ------------------------------------------------- |
| `TEAM_PASSWORD`  | the shared password your team will type to log in |
| `SESSION_SECRET` | a long random string (e.g. run `openssl rand -hex 32`) |

> `PORT` is provided by Railway automatically — don't set it.
>
> ⚠️ `TEAM_PASSWORD` is only applied **the first time the database is created**
> (the empty-volume first boot). Set it **before** that first run. To change it
> later, see "Rotating the password" below.

### 4. Get your link

Service → **Settings** → **Networking** → **Generate Domain**. That URL is your
live site — open it and you'll see the login splash.

## Who can log in

The first boot seeds these users: **Yousaf** (admin), **Alex**, **Tommy**,
**Tom**. They all use `TEAM_PASSWORD`. New people use **"Request an account"**
on the splash; you (Yousaf) approve them, which adds them as members.

## Redeploying / updating

Push to the deployed branch — Railway rebuilds automatically. Your data is safe
because it's on the `/data` volume.

## Rotating the shared password

Sign in as **Yousaf** (admin) and click **"Team password"** in the board
toolbar — enter the current password and the new one. That's it; everyone uses
the new password on their next sign-in.

(`TEAM_PASSWORD` only sets the *initial* password on first boot; after that the
button is the way to change it.)

## Troubleshooting

- **Blank page / "cannot GET":** make sure the build succeeded and the service
  has a generated domain.
- **Data disappears after deploys:** the `/data` volume isn't mounted — recheck
  step 2.
- **Login always fails:** the DB was first created with the default password
  (`changeme`) before `TEAM_PASSWORD` was set — wipe the volume and redeploy.
