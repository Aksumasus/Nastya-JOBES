# Nastya JOBES

Personal work tracker: video recording hours, levels (music / no music), units, and Steam table statuses, with pay calculated in dollars and hryvnia.

## Two ways to run it

**Locally (full version).** Requires Node.js. Double-click `start.bat` — it starts a small local server on http://localhost:3210 and opens the site. Data is stored in `data.json` next to the server. The local version can also launch the watcher program and fetch game names from Steam.

**GitHub Pages (online version).** The `docs/` folder is a static build of the same site. Data is stored in the browser's localStorage, so it stays on the device where you enter it. The watcher button is hidden online. Use "Settings → My data" to export the data file from one place and import it in another.

## Notes

- Pay rule: a configurable number of real minutes (default 65) counts as one paid hour.
- `data.json` is intentionally not committed — it contains personal work statistics.
