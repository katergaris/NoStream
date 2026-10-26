NoStream — portable version for Windows
=======================================

START
  Double-click NoStream.exe. Your browser opens http://localhost:4321
  Keep the small black window open: closing it stops NoStream.

FIRST TIME
  - Windows may show "Windows protected your PC" (SmartScreen): "More info" →
    "Run anyway". It happens because the program isn't signed.
  - Windows may ask whether to allow network access: choose "Private networks".
    It's needed to use NoStream from your phone too (Nuvio or browser).
  - NoStream guides you: TMDB API key, addons (or your Nuvio account).
  - The interface follows your browser language (Italian, English, Spanish,
    French, German); you can change it in Settings.

WHERE EVERYTHING IS
  config.json   settings, TMDB key, access to your Nuvio account. DON'T share it.
  data\         files prepared on the PC, videos from links, yt-dlp updates, logs.
  app\          the program (Node, NoStream, ffmpeg, yt-dlp): don't change it.
  Nothing is written outside this folder. To uninstall: delete it.

WHERE NOT TO PUT IT
  Not in C:\Program Files or other protected folders: NoStream must be able to
  write config.json and data\. Documents, Desktop, another drive or a USB stick
  are fine.

UPDATING
  Download the new zip and replace only NoStream.exe and the app\ folder.
  config.json and data\ stay.

FROM YOUR PHONE
  In NoStream: Settings → Install in Nuvio shows the PC address to use.
  The PC must stay on and on the same network (or reachable through a VPN such
  as Tailscale).
