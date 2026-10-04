package com.sentrifugo.pms;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Drives the PMS Cycle API end to end over HTTP through the real security chain, controllers, services,
 * MapStruct mapper and JPA, against in-memory H2 (schema {@code pms}). Only the Valkey client is mocked.
 */
@SpringBootTest(
        classes = PmsApplication.class,
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {
                // Never touch the real database/Valkey configured in application.properties.
                "spring.datasource.url=jdbc:h2:mem:pmscycle;DB_CLOSE_DELAY=-1;INIT=CREATE SCHEMA IF NOT EXISTS pms",
                "spring.datasource.driver-class-name=org.h2.Driver",
                "spring.datasource.username=sa",
                "spring.datasource.password=",
                "spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.H2Dialect",
                "spring.jpa.hibernate.ddl-auto=create-drop"
        })
class PmsCycleApiTest {

    private static final String ORG_A = "11111111-1111-1111-1111-111111111111";
    private static final String ORG_B = "22222222-2222-2222-2222-222222222222";

    private static String session(String userId, String orgId, boolean canWrite) {
        return """
                {"user_id": "%s", "email": "u@example.com", "org_id": "%s", "is_super_admin": false,
                 "is_org_admin": false,
                 "permissions": {"performance_management": {"acl": "editor",
                   "actions": {"create_resource": %s}, "action_acls": {}}}}
                """.formatted(userId, orgId, canWrite);
    }

    @MockitoBean
    StringRedisTemplate redis;

    @Value("${local.server.port}")
    int port;

    private final ObjectMapper json = new ObjectMapper();

    @BeforeEach
    @SuppressWarnings("unchecked")
    void stubSessions() {
        ValueOperations<String, String> sessions = mock(ValueOperations.class);
        when(redis.opsForValue()).thenReturn(sessions);
        when(sessions.get("session:writer-a")).thenReturn(session("aaaaaaaa-0000-0000-0000-000000000001", ORG_A, true));
        when(sessions.get("session:reader-a")).thenReturn(session("aaaaaaaa-0000-0000-0000-000000000002", ORG_A, false));
        when(sessions.get("session:writer-b")).thenReturn(session("bbbbbbbb-0000-0000-0000-000000000001", ORG_B, true));
        when(sessions.get("session:mongo-org")).thenReturn(session("u1", "665f1c2e9b1e8a00aaaaaaaa", true));
    }

    private HttpResponse<String> call(String method, String path, String token, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json");
        if (token != null) {
            request.header("Authorization", "Bearer " + token);
        }
        request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(body));
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static String cycleBody(String name, String type, String start, String end, boolean withScale) {
        return """
                {"basic": {"name": "%s", "description": "d", "type": "%s", "period_start": "%s", "period_end": "%s"},
                 "finalize": {"rating_scale_id": %s, "notify_managers": true, "notify_employees": true,
                              "notify_hod": false, "notify_hr": true},
                 "current_step": 2}
                """.formatted(name, type, start, end,
                withScale ? "\"33333333-3333-3333-3333-333333333333\"" : "null");
    }

    private JsonNode create(String token, String name, boolean withScale) throws Exception {
        HttpResponse<String> response = call("POST", "/api/pms/cycles", token,
                cycleBody(name, "annual", "2026-04-01", "2027-03-31", withScale));
        assertThat(response.statusCode()).isEqualTo(201);
        return json.readTree(response.body());
    }

    @Test
    void protectedRouteWithoutTokenIs401() throws Exception {
        HttpResponse<String> response = call("GET", "/api/pms/cycles", null, null);
        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(json.readTree(response.body()).get("code").asString()).isEqualTo("UNAUTHORIZED");
    }

    @Test
    void createReturnsDraftWithGeneratedCodeInTheApiResponseEnvelope() throws Exception {
        JsonNode body = create("writer-a", "FY 2026-27", true);
        assertThat(body.get("success").asBoolean()).isTrue();
        assertThat(body.get("message").asString()).isEqualTo("PMS cycle created successfully");
        JsonNode cycle = body.get("data");
        assertThat(cycle.get("cycle_code").asString()).startsWith("PMS-2627-A");
        assertThat(cycle.get("status").asString()).isEqualTo("draft");
        assertThat(cycle.get("basic").get("type").asString()).isEqualTo("annual");
        assertThat(cycle.get("basic").get("period_start").asString()).isEqualTo("2026-04-01");
        assertThat(cycle.get("finalize").get("notify_hod").asBoolean()).isFalse();
        assertThat(cycle.get("current_step").asInt()).isEqualTo(2);
        assertThat(cycle.get("created_on").isNull()).isFalse();
    }

    @Test
    void secondCycleForTheSameYearAndTypeGetsASuffixedCode() throws Exception {
        String first = create("writer-a", "one", true).get("data").get("cycle_code").asString();
        String second = create("writer-a", "two", true).get("data").get("cycle_code").asString();
        assertThat(second).isNotEqualTo(first).startsWith("PMS-2627-A");
    }

    @Test
    void anotherOrganisationCannotSeeOrChangeTheCycle() throws Exception {
        String id = create("writer-a", "A cycle", true).get("data").get("id").asString();

        assertThat(call("GET", "/api/pms/cycles/" + id, "writer-a", null).statusCode()).isEqualTo(200);
        assertThat(call("GET", "/api/pms/cycles/" + id, "writer-b", null).statusCode()).isEqualTo(404);
        assertThat(call("POST", "/api/pms/cycles/" + id + "/cancel", "writer-b", null).statusCode()).isEqualTo(404);
        assertThat(call("PUT", "/api/pms/cycles/" + id, "writer-b",
                cycleBody("x", "annual", "2026-04-01", "2027-03-31", true)).statusCode()).isEqualTo(404);

        JsonNode listB = json.readTree(call("GET", "/api/pms/cycles?search=A%20cycle", "writer-b", null).body());
        assertThat(listB.get("data").get("total").asInt()).isZero();
    }

    @Test
    void writeWithoutThePermissionIs403NotA500() throws Exception {
        HttpResponse<String> response = call("POST", "/api/pms/cycles", "reader-a",
                cycleBody("n", "annual", "2026-04-01", "2027-03-31", true));
        assertThat(response.statusCode()).isEqualTo(403);
        assertThat(json.readTree(response.body()).get("code").asString()).isEqualTo("FORBIDDEN");
        assertThat(call("GET", "/api/pms/cycles", "reader-a", null).statusCode()).isEqualTo(200);
    }

    @Test
    void sessionWhoseOrganisationIsNotAUuidIsRefused() throws Exception {
        HttpResponse<String> response = call("GET", "/api/pms/cycles", "mongo-org", null);
        assertThat(response.statusCode()).isEqualTo(403);
        assertThat(json.readTree(response.body()).get("code").asString()).isEqualTo("PMS_INVALID_ORGANISATION");
    }

    @Test
    void validationErrorsUseTheDetailAndCodeShape() throws Exception {
        HttpResponse<String> badPeriod = call("POST", "/api/pms/cycles", "writer-a",
                cycleBody("n", "annual", "2027-03-31", "2026-04-01", true));
        assertThat(badPeriod.statusCode()).isEqualTo(422);
        assertThat(json.readTree(badPeriod.body()).get("code").asString()).isEqualTo("VALIDATION_ERROR");

        HttpResponse<String> badType = call("POST", "/api/pms/cycles", "writer-a",
                cycleBody("n", "weekly", "2026-04-01", "2027-03-31", true));
        assertThat(badType.statusCode()).isEqualTo(422);

        HttpResponse<String> noName = call("POST", "/api/pms/cycles", "writer-a",
                cycleBody("", "annual", "2026-04-01", "2027-03-31", true));
        assertThat(noName.statusCode()).isEqualTo(422);
        assertThat(json.readTree(noName.body()).get("detail").asString()).contains("name");

        assertThat(call("POST", "/api/pms/cycles", "writer-a", "{not json").statusCode()).isEqualTo(400);
    }

    @Test
    void lifecycleDraftToActiveToCancelledWithStateTransitionGuards() throws Exception {
        String id = create("writer-a", "no scale yet", false).get("data").get("id").asString();

        // activation of a draft is a conflict
        HttpResponse<String> draftActivation = call("GET", "/api/pms/cycles/" + id + "/activation", "writer-a", null);
        assertThat(draftActivation.statusCode()).isEqualTo(409);
        assertThat(json.readTree(draftActivation.body()).get("code").asString()).isEqualTo("PMS_CYCLE_NOT_PUBLISHED");

        // publish needs a rating scale
        HttpResponse<String> noScale = call("POST", "/api/pms/cycles/" + id + "/publish", "writer-a", null);
        assertThat(noScale.statusCode()).isEqualTo(422);
        assertThat(json.readTree(noScale.body()).get("code").asString())
                .isEqualTo("PMS_CYCLE_PUBLISH_VALIDATION_FAILED");

        // add one through update, then publish
        HttpResponse<String> updated = call("PUT", "/api/pms/cycles/" + id, "writer-a",
                cycleBody("renamed", "mid_year", "2026-04-01", "2026-09-30", true));
        assertThat(updated.statusCode()).isEqualTo(200);
        JsonNode updatedCycle = json.readTree(updated.body()).get("data");
        assertThat(updatedCycle.get("basic").get("name").asString()).isEqualTo("renamed");
        assertThat(updatedCycle.get("basic").get("type").asString()).isEqualTo("mid_year");
        assertThat(updatedCycle.get("cycle_code").asString()).startsWith("PMS-2627-A"); // code never changes
        assertThat(updatedCycle.get("status").asString()).isEqualTo("draft");

        HttpResponse<String> published = call("POST", "/api/pms/cycles/" + id + "/publish", "writer-a", null);
        assertThat(published.statusCode()).isEqualTo(200);
        JsonNode activation = json.readTree(published.body()).get("data");
        assertThat(activation.get("cycle").get("status").asString()).isEqualTo("active");
        assertThat(activation.get("published_on").isNull()).isFalse();

        assertThat(call("POST", "/api/pms/cycles/" + id + "/publish", "writer-a", null).statusCode()).isEqualTo(409);
        assertThat(call("GET", "/api/pms/cycles/" + id + "/activation", "writer-a", null).statusCode())
                .isEqualTo(200);

        // an active cycle is still editable, and can be cancelled once
        assertThat(call("PUT", "/api/pms/cycles/" + id, "writer-a",
                cycleBody("renamed again", "mid_year", "2026-04-01", "2026-09-30", true)).statusCode())
                .isEqualTo(200);
        HttpResponse<String> cancelled = call("POST", "/api/pms/cycles/" + id + "/cancel", "writer-a", null);
        assertThat(cancelled.statusCode()).isEqualTo(200);
        assertThat(json.readTree(cancelled.body()).get("data").get("status").asString()).isEqualTo("cancelled");

        HttpResponse<String> cancelAgain = call("POST", "/api/pms/cycles/" + id + "/cancel", "writer-a", null);
        assertThat(cancelAgain.statusCode()).isEqualTo(409);
        assertThat(json.readTree(cancelAgain.body()).get("code").asString()).isEqualTo("PMS_CYCLE_NOT_CANCELLABLE");

        HttpResponse<String> editCancelled = call("PUT", "/api/pms/cycles/" + id, "writer-a",
                cycleBody("x", "annual", "2026-04-01", "2027-03-31", true));
        assertThat(editCancelled.statusCode()).isEqualTo(409);
        assertThat(json.readTree(editCancelled.body()).get("code").asString()).isEqualTo("PMS_CYCLE_NOT_EDITABLE");
    }

    @Test
    void listSummaryIgnoresStatusFilterButTotalHonoursIt() throws Exception {
        // an organisation of its own so counts are exact regardless of the other tests
        String token = "writer-b";
        String keep = create(token, "list-keep", true).get("data").get("id").asString();
        String drop = create(token, "list-drop", true).get("data").get("id").asString();
        call("POST", "/api/pms/cycles/" + drop + "/cancel", token, null);

        JsonNode all = json.readTree(call("GET", "/api/pms/cycles?search=list-", token, null).body()).get("data");
        assertThat(all.get("total").asInt()).isEqualTo(2);
        assertThat(all.get("summary").get("all").asInt()).isEqualTo(2);

        JsonNode cancelledTab = json.readTree(
                call("GET", "/api/pms/cycles?search=list-&status=cancelled", token, null).body()).get("data");
        assertThat(cancelledTab.get("total").asInt()).isEqualTo(1);
        assertThat(cancelledTab.get("items").size()).isEqualTo(1);
        assertThat(cancelledTab.get("items").get(0).get("id").asString()).isEqualTo(drop);
        assertThat(cancelledTab.get("summary").get("all").asInt()).isEqualTo(2);
        assertThat(cancelledTab.get("summary").get("draft").asInt()).isEqualTo(1);
        assertThat(cancelledTab.get("summary").get("cancelled").asInt()).isEqualTo(1);

        assertThat(call("GET", "/api/pms/cycles?status=bogus", token, null).statusCode()).isEqualTo(422);
        assertThat(keep).isNotEqualTo(drop);
    }

    @Test
    void exportReturnsACsvFile() throws Exception {
        create("writer-a", "csv-cycle", true);
        HttpResponse<String> response = call("GET", "/api/pms/cycles/export?search=csv-cycle", "writer-a", null);
        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.headers().firstValue("Content-Type").orElse("")).startsWith("text/csv");
        assertThat(response.body()).startsWith("Cycle ID,Cycle Name").contains("csv-cycle");
    }
}
