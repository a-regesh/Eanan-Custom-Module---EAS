# Eanan Custom Modules — EAS

## eas_qc_flight_deck

HUD-style live control page for Odoo quality alerts (product non-conformances), served by Odoo at `/qc-deck`.

- Depends on `quality_control` (Odoo Enterprise).
- Menu: Quality → Flight Deck (Quality Users).
- Runs with the logged-in user's access rights; adds no models or security records.

Install: add this repository to the addons path, update the apps list, install **EAS QC Flight Deck**.

![Preview with sample data](docs/qc-flight-deck-preview.png)
