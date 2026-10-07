# PLEASE RESET THE PASSWORD IN config.json!! ITS DEFAULT PASSWORD IS "password" AND YOU MUST CHANGE IT.
# YOU CAN RUN THE APP FROM THE COMMAND LINE USING `npm start server.js`!

xCastVM is a selfhosted, open-source Node.JS app that lets you stream music from your PC to any device over the web, no Jellyfin or Plex required.
It runs entirely in your web browser, and can be accessed anywhere on your network, assuming you didn't forget the password.
If you did... well hackers will get the password from config.json so i might add in Base64 encryption.

Features:
- Stream music from your PC to any device over the web
- THEMES
- supports mp3 and wav

TBC:
- Functioning Now Playing

Prerequisites:
- Node.JS 18 or higher
- npm
- media-metadata (required!) (install with `npm install media-metadata`)
- functioning NIC and network connection
- last but not least, a free port (16610)