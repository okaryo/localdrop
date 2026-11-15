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

1. Choose the receive option on one device and select **Create offer**.
2. Choose the send option on the other device. Paste the complete offer code
   into the offer field and select **Create answer**.
3. Paste the complete answer code into the answer field on the receiving device
   and select **Apply answer**.
4. When both pages show **Connected**, send a short message from each device and
   check that it appears on the other screen.

On a local HTTP URL, use **Select offer** or **Select answer**, then copy the
selected text using your device’s copy command. Share connection codes privately.
Use **Start over** on both devices to create a fresh pair of codes. If the pages
load but the peer connection fails, check Wi-Fi client isolation, firewall
settings, and VPN settings.

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
