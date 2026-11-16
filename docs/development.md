# Development

## Run locally

Use Node.js 22.12 or later and the pnpm version in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm dev --host 0.0.0.0
```

Connect both devices to the same network and open the **Network** URL printed by
Vite in Chrome on both devices. If the page does not load, check that the
computer running Vite allows incoming connections to the dev server.

LocalDrop defaults to Japanese if the browser language is Japanese. Use the
language picker to switch between Japanese and English. LocalDrop remembers
that choice in the browser.

## Test QR file transfer offline

1. Open LocalDrop in Chrome on both devices. Use an HTTPS build or, for two
   tabs on one computer, the localhost URL printed by `pnpm preview` after
   `pnpm build`.
2. Choose **QR file transfer** on both pages. Wait until both say **Ready for
   offline transfer**, then disconnect both devices from the network or
   set both tabs to **Offline** in Chrome DevTools. Keep the pages open.
3. Choose **Send by QR** on one device and select a file of up to 4 KiB. On the
   receiving device, choose **Receive by QR** and then **Scan file QR codes**.
4. Show each QR code to the camera. Advance with **Next code** after each scan.
   The receiver lists any missing codes, which can be scanned in any order.
5. When every code has been read and the file verified, select **Download**.

## Test local network pairing

1. Open an HTTPS build in Chrome on both devices. Connect them to the same network, such as the same Wi-Fi.
2. Choose **Receive** on the receiving device and select **Create offer**.
   Allow camera access if prompted. LocalDrop creates the offer after access is granted.
3. Choose **Send** on the sending device, select **Scan offer QR code**, and
   point the camera at the offer. The answer QR code appears after scanning.
4. On the receiving device, select **Scan answer QR code** and scan the answer.
5. When both pages show **Connected**, follow the file transfer steps below.

Use **Use a text code** if your browser cannot access the camera or read the QR
code. The receiver can choose **Create offer text code** to start without
camera access. Copy and paste the offer and answer between devices, including
on local HTTP. Share connection codes privately.

If pairing stops, check the status shown in the app:

- **Looking for the answer QR code…** means the camera is waiting for a readable
  code. Keep the entire code in the camera guide, or try the text option.
- **Could not apply the answer** means the browser rejected the answer. Check
  that it came from the offer still shown on the receiving device.
- **Could not connect** means the devices could not start a transfer. Check
  that both devices are on the same network. Some networks block connections
  between devices, so try another network if the problem continues.

Use **Start over** on both devices to create a fresh pair of codes.

## Test file transfer

After connecting, select one or more files on the sending device. Choose
**Send files** to send them one at a time in the order shown. For files up to
25 MiB, the receiver can download each file as soon as it arrives.

For larger files, open the page on the receiving device in Chrome over HTTPS
or localhost. When the file appears, choose **Choose where to save** and pick
a destination before the transfer starts. Compare the saved file with the
original. Canceling the save dialog or choosing **Skip file** skips that file
and continues the queue. Browsers without a save dialog still support files
up to 25 MiB.

To test an interruption, wait until the first file is available to download
and disconnect either device while the next file is transferring. The
receiver keeps completed downloads on the receiving screen and discards the
unfinished data. An interrupted large-file transfer does not commit its
contents to the chosen destination. Save completed downloads before choosing
**Start over**.

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

QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in other countries.
