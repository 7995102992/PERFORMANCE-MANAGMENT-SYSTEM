from src.models import CustomModel


class CountryTimezone(CustomModel):
    zoneName: str | None = None
    gmtOffset: int | None = None
    gmtOffsetName: str | None = None
    abbreviation: str | None = None
    tzName: str | None = None


class CountryResponse(CustomModel):
    id: int
    name: str
    native: str | None = None
    iso2: str | None = None
    iso3: str | None = None
    phone_code: str | None = None
    capital: str | None = None
    currency: str | None = None
    currency_name: str | None = None
    currency_symbol: str | None = None
    region: str | None = None
    subregion: str | None = None
    timezones: list[CountryTimezone] | None = None
    latitude: str | None = None
    longitude: str | None = None
    emoji: str | None = None


class CurrencyResponse(CustomModel):
    currency: str
    currency_name: str | None = None
    currency_symbol: str | None = None


class TimezoneResponse(CustomModel):
    zoneName: str
    gmtOffset: int | None = None
    gmtOffsetName: str | None = None
    abbreviation: str | None = None
    tzName: str | None = None


class StateResponse(CustomModel):
    id: int
    name: str
    state_code: str | None = None
    iso3166_2: str | None = None
    country_id: int
    country_name: str | None = None
    country_code: str | None = None
    latitude: str | None = None
    longitude: str | None = None
    timezone: str | None = None


class CityResponse(CustomModel):
    id: int
    name: str
    state_id: int
    state_name: str | None = None
    state_code: str | None = None
    country_id: int
    country_name: str | None = None
    country_code: str | None = None
    latitude: str | None = None
    longitude: str | None = None
    timezone: str | None = None
