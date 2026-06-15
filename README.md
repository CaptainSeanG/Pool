
# Pool Chemistry Dashboard

A single-page GitHub Pages dashboard for Sean's 12,000-gallon PebbleTec pool.

## Files
- `index.html` — the dashboard
- `data.js` — the chemistry ledger feeding the charts

## Updating the site
Whenever new pool data comes into ChatGPT, I can append a new entry to `data.js` and push an update here. The page will refresh automatically on the next GitHub Pages deploy.

## Enable GitHub Pages
In the repository settings:
1. Open **Settings**
2. Open **Pages**
3. Under **Build and deployment**, choose **Deploy from a branch**
4. Select **main** and the **/root** folder
5. Save

Then GitHub will publish the site.
