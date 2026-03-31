# Cloudflare Worker Deploy (SPA Routing)

This project is a Single Page Application (React Router). The Worker must serve `index.html` for non-asset routes like `/generators/colorize`.

## Repo setup

- SPA fallback is implemented in [worker.ts](./worker.ts).
- Static assets are served from `./dist` via [wrangler.toml](./wrangler.toml).

## Cloudflare “Builds & Deployments” settings

If your Cloudflare deploy logs show:

`Workers Sites does not support uploading versions through wrangler versions upload. You must use wrangler deploy instead.`

Update the deploy command to use `wrangler deploy`.

Recommended settings:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

## Manual deploy from your machine

```powershell
npm install
npm run build
npx wrangler deploy
```

