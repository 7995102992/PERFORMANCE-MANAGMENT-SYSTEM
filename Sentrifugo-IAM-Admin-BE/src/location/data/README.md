# Location Data

## Source

Location data (countries, states, cities) is sourced from:

**Repository:** https://github.com/dr5hn/countries-states-cities-database

This is a comprehensive, open-source database containing 250 countries, 5000+ states/provinces, and 153K+ cities with ISO codes, timezones, coordinates, and multilingual support.

## Files

Download the following JSON files from the repository and place them in this directory:

- `countries.json` — All countries with ISO2/ISO3 codes, capitals, currencies, timezones
- `states.json` — States/provinces mapped to countries
- `cities.json` — Cities with latitude/longitude, mapped to states and countries

**Direct download links:**

- https://github.com/dr5hn/countries-states-cities-database/blob/master/json/countries.json
- https://github.com/dr5hn/countries-states-cities-database/blob/master/json/states.json
- https://github.com/dr5hn/countries-states-cities-database/blob/master/json/cities.json

## Usage

After placing the JSON files here, run the seed script to import them into MongoDB:

```bash
python scripts/seed_locations.py
```

## License

The source dataset is licensed under the Open Database License (ODbL).
