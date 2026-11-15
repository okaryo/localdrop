# Development

## Run locally

Use Node.js 22.12 or later and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev --host 0.0.0.0
```

Connect both devices to the same Wi-Fi and open the **Network** URL printed by
Vite in Chrome on both devices. If the page does not load, check that the
computer running Vite allows incoming connections to the dev server.

## Test the current prototype

1. Open an HTTPS build in Chrome on both devices. Connect them to the same Wi-Fi.
2. Choose the receive option on one device and select **Create offer**.
3. Choose the send option on the other device, select **Scan offer QR code**,
   and point the camera at the offer. The answer QR code appears after scanning.
4. On the receiving device, select **Scan answer QR code** and scan the answer.
5. When both pages show **Connected**, send a short message in each direction.

Use **Use a text code** if your browser cannot access the camera or read the QR
code. It lets you copy and paste the offer and answer manually, including on
local HTTP. Share connection codes privately. Use **Start over** on both devices
to create a fresh pair of codes. If the pages load but the peer connection
fails, check Wi-Fi client isolation, firewall settings, and VPN settings.

## Build

```sh
pnpm build
```

The static build is written to `dist/`.

## Publish to GitHub Pages

In **Settings → Pages**, set **Source** to **GitHub Actions**. The
**Deploy to GitHub Pages** workflow builds and publishes the site when changes
reach `main`. You can also run it from the **Actions** tab on `main`.

After the workflow succeeds, open the URL shown by the deployment job.
For this repository, the default URL is
[okaryo.github.io/localdrop](https://okaryo.github.io/localdrop/).
