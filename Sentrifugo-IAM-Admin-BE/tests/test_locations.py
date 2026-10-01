from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient


# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------
SAMPLE_COUNTRY = {
    "id": 101,
    "name": "India",
    "iso2": "IN",
    "iso3": "IND",
    "phone_code": "91",
    "capital": "New Delhi",
    "currency": "INR",
    "currency_symbol": "₹",
    "region": "Asia",
    "subregion": "Southern Asia",
    "emoji": "🇮🇳",
}

SAMPLE_COUNTRY_2 = {
    "id": 102,
    "name": "Indonesia",
    "iso2": "ID",
    "iso3": "IDN",
    "phone_code": "62",
    "capital": "Jakarta",
    "currency": "IDR",
    "currency_symbol": "Rp",
    "region": "Asia",
    "subregion": "South-Eastern Asia",
    "emoji": "🇮🇩",
}

SAMPLE_STATE = {
    "id": 4028,
    "name": "Kerala",
    "state_code": "KL",
    "country_id": 101,
    "country_name": "India",
    "country_code": "IN",
    "latitude": "10.85051590",
    "longitude": "76.27108330",
}

SAMPLE_STATE_2 = {
    "id": 4029,
    "name": "Karnataka",
    "state_code": "KA",
    "country_id": 101,
    "country_name": "India",
    "country_code": "IN",
    "latitude": "15.31727750",
    "longitude": "75.71388840",
}

SAMPLE_CITY = {
    "id": 57606,
    "name": "Kochi",
    "state_id": 4028,
    "state_name": "Kerala",
    "state_code": "KL",
    "country_id": 101,
    "country_name": "India",
    "country_code": "IN",
    "latitude": "9.93988200",
    "longitude": "76.26022200",
}

SAMPLE_CITY_2 = {
    "id": 57607,
    "name": "Thiruvananthapuram",
    "state_id": 4028,
    "state_name": "Kerala",
    "state_code": "KL",
    "country_id": 101,
    "country_name": "India",
    "country_code": "IN",
    "latitude": "8.52413900",
    "longitude": "76.93609500",
}


# ---------------------------------------------------------------------------
# GET /master-data/countries
# ---------------------------------------------------------------------------
class TestListCountries:
    @pytest.mark.asyncio
    async def test_list_countries_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_countries",
            new_callable=AsyncMock,
            return_value=[SAMPLE_COUNTRY, SAMPLE_COUNTRY_2],
        ):
            response = await client.get("/master-data/countries")

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) == 2
        assert data[0]["name"] == "India"
        assert data[1]["name"] == "Indonesia"

    @pytest.mark.asyncio
    async def test_list_countries_empty(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_countries",
            new_callable=AsyncMock,
            return_value=[],
        ):
            response = await client.get("/master-data/countries")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_search_countries_by_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_countries",
            new_callable=AsyncMock,
            return_value=[SAMPLE_COUNTRY],
        ) as mock_search:
            response = await client.get("/master-data/countries?search=ind")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["name"] == "India"
        query = mock_search.call_args[0][0]
        assert "name" in query

    @pytest.mark.asyncio
    async def test_list_countries_pagination(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_countries",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_search:
            response = await client.get("/master-data/countries?skip=10&limit=5")

        assert response.status_code == 200
        mock_search.assert_called_once()
        call_args = mock_search.call_args
        assert call_args[0][1] == 10  # skip
        assert call_args[0][2] == 5   # limit


# ---------------------------------------------------------------------------
# GET /master-data/countries/{id}
# ---------------------------------------------------------------------------
class TestGetCountry:
    @pytest.mark.asyncio
    async def test_get_country_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_country_by_id",
            new_callable=AsyncMock,
            return_value=SAMPLE_COUNTRY,
        ):
            response = await client.get("/master-data/countries/101")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 101
        assert data["name"] == "India"
        assert data["iso2"] == "IN"

    @pytest.mark.asyncio
    async def test_get_country_not_found(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_country_by_id",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await client.get("/master-data/countries/99999")

        assert response.status_code == 404
        assert response.json()["code"] == "COUNTRY_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /master-data/states
# ---------------------------------------------------------------------------
class TestListStates:
    @pytest.mark.asyncio
    async def test_list_states_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[SAMPLE_STATE, SAMPLE_STATE_2],
        ):
            response = await client.get("/master-data/states")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["name"] == "Kerala"
        assert data[1]["name"] == "Karnataka"

    @pytest.mark.asyncio
    async def test_search_states_by_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[SAMPLE_STATE],
        ) as mock_search:
            response = await client.get("/master-data/states?search=ker")

        assert response.status_code == 200
        assert len(response.json()) == 1
        query = mock_search.call_args[0][0]
        assert "name" in query

    @pytest.mark.asyncio
    async def test_filter_states_by_country_id(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[SAMPLE_STATE, SAMPLE_STATE_2],
        ) as mock_search:
            response = await client.get("/master-data/states?country_id=101")

        assert response.status_code == 200
        assert len(response.json()) == 2
        query = mock_search.call_args[0][0]
        assert query["country_id"] == 101

    @pytest.mark.asyncio
    async def test_filter_states_by_country_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[SAMPLE_STATE],
        ) as mock_search:
            response = await client.get("/master-data/states?country_name=India")

        assert response.status_code == 200
        query = mock_search.call_args[0][0]
        assert "country_name" in query

    @pytest.mark.asyncio
    async def test_list_states_empty(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[],
        ):
            response = await client.get("/master-data/states?country_name=Narnia")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_states_pagination(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_states",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_search:
            response = await client.get("/master-data/states?skip=5&limit=10")

        assert response.status_code == 200
        call_args = mock_search.call_args
        assert call_args[0][1] == 5   # skip
        assert call_args[0][2] == 10  # limit


# ---------------------------------------------------------------------------
# GET /master-data/states/{id}
# ---------------------------------------------------------------------------
class TestGetState:
    @pytest.mark.asyncio
    async def test_get_state_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_state_by_id",
            new_callable=AsyncMock,
            return_value=SAMPLE_STATE,
        ):
            response = await client.get("/master-data/states/4028")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 4028
        assert data["name"] == "Kerala"
        assert data["country_name"] == "India"

    @pytest.mark.asyncio
    async def test_get_state_not_found(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_state_by_id",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await client.get("/master-data/states/99999")

        assert response.status_code == 404
        assert response.json()["code"] == "STATE_NOT_FOUND"


# ---------------------------------------------------------------------------
# GET /master-data/cities
# ---------------------------------------------------------------------------
class TestListCities:
    @pytest.mark.asyncio
    async def test_list_cities_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY, SAMPLE_CITY_2],
        ):
            response = await client.get("/master-data/cities")

        assert response.status_code == 200
        data = response.json()
        assert len(data) == 2
        assert data[0]["name"] == "Kochi"
        assert data[1]["name"] == "Thiruvananthapuram"

    @pytest.mark.asyncio
    async def test_search_cities_by_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY],
        ) as mock_search:
            response = await client.get("/master-data/cities?search=kochi")

        assert response.status_code == 200
        assert len(response.json()) == 1
        query = mock_search.call_args[0][0]
        assert "name" in query

    @pytest.mark.asyncio
    async def test_filter_cities_by_state_id(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY, SAMPLE_CITY_2],
        ) as mock_search:
            response = await client.get("/master-data/cities?state_id=4028")

        assert response.status_code == 200
        assert len(response.json()) == 2
        query = mock_search.call_args[0][0]
        assert query["state_id"] == 4028

    @pytest.mark.asyncio
    async def test_filter_cities_by_state_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY],
        ) as mock_search:
            response = await client.get("/master-data/cities?state_name=Kerala")

        assert response.status_code == 200
        query = mock_search.call_args[0][0]
        assert "state_name" in query

    @pytest.mark.asyncio
    async def test_filter_cities_by_country_id(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY],
        ) as mock_search:
            response = await client.get("/master-data/cities?country_id=101")

        assert response.status_code == 200
        query = mock_search.call_args[0][0]
        assert query["country_id"] == 101

    @pytest.mark.asyncio
    async def test_filter_cities_by_country_name(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY],
        ) as mock_search:
            response = await client.get("/master-data/cities?country_name=India")

        assert response.status_code == 200
        query = mock_search.call_args[0][0]
        assert "country_name" in query

    @pytest.mark.asyncio
    async def test_filter_cities_combined(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[SAMPLE_CITY],
        ) as mock_search:
            response = await client.get("/master-data/cities?country_name=India&state_name=Kerala&search=kochi")

        assert response.status_code == 200
        query = mock_search.call_args[0][0]
        assert "name" in query
        assert "state_name" in query
        assert "country_name" in query

    @pytest.mark.asyncio
    async def test_list_cities_empty(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[],
        ):
            response = await client.get("/master-data/cities?state_name=Narnia")

        assert response.status_code == 200
        assert response.json() == []

    @pytest.mark.asyncio
    async def test_list_cities_pagination(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.search_cities",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_search:
            response = await client.get("/master-data/cities?skip=20&limit=50")

        assert response.status_code == 200
        call_args = mock_search.call_args
        assert call_args[0][1] == 20  # skip
        assert call_args[0][2] == 50  # limit


# ---------------------------------------------------------------------------
# GET /master-data/cities/{id}
# ---------------------------------------------------------------------------
class TestGetCity:
    @pytest.mark.asyncio
    async def test_get_city_success(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_city_by_id",
            new_callable=AsyncMock,
            return_value=SAMPLE_CITY,
        ):
            response = await client.get("/master-data/cities/57606")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == 57606
        assert data["name"] == "Kochi"
        assert data["state_name"] == "Kerala"
        assert data["country_name"] == "India"

    @pytest.mark.asyncio
    async def test_get_city_not_found(self, client: AsyncClient):
        with patch(
            "src.location.service.repository.get_city_by_id",
            new_callable=AsyncMock,
            return_value=None,
        ):
            response = await client.get("/master-data/cities/99999")

        assert response.status_code == 404
        assert response.json()["code"] == "CITY_NOT_FOUND"


# ---------------------------------------------------------------------------
# Invalid entity
# ---------------------------------------------------------------------------
class TestInvalidEntity:
    @pytest.mark.asyncio
    async def test_invalid_entity_returns_422(self, client: AsyncClient):
        response = await client.get("/master-data/planets")
        assert response.status_code == 422
