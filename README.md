# LocalDrop

Send files to nearby devices over a local network, or use QR codes for small offline transfers.

[Open LocalDrop](https://okaryo.github.io/localdrop/)

## Local network transfer

Connect both devices to the same network, such as the same Wi-Fi. Start with **Receive** on one device, then choose **Send** on the other and follow the QR pairing steps. Select one or more files to send directly between the devices over WebRTC.

## Offline QR transfer

Open **QR file transfer** on both devices before going offline. Wait until both are ready, then choose **Send by QR** on one device and **Receive by QR** on the other. Scan each code and download the file when it is ready.

## Limits

- Some networks block connections between devices, even on the same Wi-Fi. Try another network if the devices cannot connect.
- Files over 25 MiB require a browser that lets the receiving device choose where to save the file.
- Offline QR transfer supports one file up to 4 KiB.

See the [development guide](docs/development.md) for local setup and testing.

## License

LocalDrop's source code and documentation are available under the [MIT License](LICENSE). The app footer links to the licenses for bundled libraries.

QR Code is a registered trademark of DENSO WAVE INCORPORATED in Japan and in other countries.
