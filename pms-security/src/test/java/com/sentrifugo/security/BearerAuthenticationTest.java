package com.sentrifugo.security;

import com.sentrifugo.security.access.RequirePermission;
import com.sentrifugo.security.context.PmsUserPrincipal;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringBootConfiguration;
import org.springframework.boot.autoconfigure.EnableAutoConfiguration;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Drives the real security chain over HTTP with only the Valkey client mocked,
 * using session payloads in the shape IAM writes.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class BearerAuthenticationTest {

    private static final String EMPLOYEE_SESSION = """
            {"user_id": "665f1c2e9b1e8a0012345678", "email": "asha@example.com",
             "full_name": "Asha Rao", "first_name": "Asha", "last_name": "Rao",
             "org_id": "665f1c2e9b1e8a00aaaaaaaa", "is_super_admin": false, "is_org_admin": false,
             "auth_method": "local", "department_id": "d1", "business_unit_id": null,
             "is_pin_exists": false, "payslip_admin": false,
             "permissions": {
               "performance_management": {"acl": "editor",
                 "actions": {"create_resource": true},
                 "action_acls": {"create_resource": "editor"}},
               "core_hr": {"acl": "viewer", "actions": {"create_resource": false}, "action_acls": {}}
             }}
            """;

    private static final String ORG_ADMIN_SESSION = """
            {"user_id": "u-admin", "email": "admin@example.com", "org_id": "o1",
             "is_super_admin": false, "is_org_admin": true, "permissions": {}}
            """;

    @SpringBootConfiguration
    @EnableAutoConfiguration
    @ComponentScan("com.sentrifugo.security")
    static class TestApp {
    }

    @RestController
    static class ProbeController {

        @GetMapping("/api/home/health")
        String health() {
            return "ok";
        }

        @GetMapping("/api/home/valkey-test")
        String valkeyTest() {
            return "ok";
        }

        @GetMapping("/probe/me")
        PmsUserPrincipal me(@AuthenticationPrincipal PmsUserPrincipal user) {
            return user;
        }

        @GetMapping("/probe/pms")
        @RequirePermission(module = "performance_management", action = "create_resource")
        String pms() {
            return "pms";
        }

        @GetMapping("/probe/core-hr")
        @RequirePermission(module = "core_hr", action = "create_resource")
        String coreHr() {
            return "core-hr";
        }
    }

    @MockitoBean
    StringRedisTemplate redis;

    @Value("${local.server.port}")
    int port;

    private ValueOperations<String, String> sessions;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void stubSessionStore() {
        sessions = mock(ValueOperations.class);
        when(redis.opsForValue()).thenReturn(sessions);
        when(sessions.get("session:employee-token")).thenReturn(EMPLOYEE_SESSION);
        when(sessions.get("session:admin-token")).thenReturn(ORG_ADMIN_SESSION);
        when(sessions.get("session:garbage-token")).thenReturn("not json");
    }

    private HttpResponse<String> get(String path, String authorization) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
        if (authorization != null) {
            request.header("Authorization", authorization);
        }
        return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void validSessionResolvesTheCaller() throws Exception {
        HttpResponse<String> response = get("/probe/me", "Bearer employee-token");

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body())
                .contains("\"id\":\"665f1c2e9b1e8a0012345678\"")
                .contains("\"organisationId\":\"665f1c2e9b1e8a00aaaaaaaa\"")
                .contains("\"email\":\"asha@example.com\"")
                .contains("\"departmentId\":\"d1\"")
                .contains("\"performance_management\"")
                .doesNotContain("employee-token");
    }

    @Test
    void bearerSchemeIsCaseInsensitive() throws Exception {
        assertThat(get("/probe/me", "bearer employee-token").statusCode()).isEqualTo(200);
    }

    @Test
    void missingTokenIs401() throws Exception {
        HttpResponse<String> response = get("/probe/me", null);

        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.body()).contains("\"code\":\"UNAUTHORIZED\"").contains("Missing bearer token");
    }

    @Test
    void unknownOrExpiredTokenIs401() throws Exception {
        HttpResponse<String> response = get("/probe/me", "Bearer no-such-token");

        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.body()).contains("Session not found or expired");
    }

    @Test
    void malformedSessionPayloadIs401() throws Exception {
        HttpResponse<String> response = get("/probe/me", "Bearer garbage-token");

        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.body()).contains("Session payload malformed");
    }

    @Test
    void sessionStoreOutageIs401NotAnonymousAccess() throws Exception {
        when(sessions.get(anyString())).thenThrow(new RedisConnectionFailureException("down"));

        HttpResponse<String> response = get("/probe/me", "Bearer employee-token");

        assertThat(response.statusCode()).isEqualTo(401);
        assertThat(response.body()).contains("Session store unavailable");
    }

    @Test
    void publicRouteNeedsNoTokenAndIgnoresABadOne() throws Exception {
        assertThat(get("/api/home/valkey-test", null).statusCode()).isEqualTo(200);
        assertThat(get("/api/home/valkey-test", "Bearer no-such-token").statusCode()).isEqualTo(200);
    }

    @Test
    void healthRouteRequiresAValidSessionLikeAnyOtherRoute() throws Exception {
        assertThat(get("/api/home/health", null).statusCode()).isEqualTo(401);
        assertThat(get("/api/home/health", "Bearer employee-token").statusCode()).isEqualTo(200);
    }

    @Test
    void grantedPermissionIsAllowed() throws Exception {
        HttpResponse<String> response = get("/probe/pms", "Bearer employee-token");

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(response.body()).isEqualTo("pms");
    }

    @Test
    void ungrantedPermissionIs403() throws Exception {
        HttpResponse<String> response = get("/probe/core-hr", "Bearer employee-token");

        assertThat(response.statusCode()).isEqualTo(403);
        assertThat(response.body()).contains("\"code\":\"FORBIDDEN\"");
    }

    @Test
    void orgAdminBypassesThePermissionGrid() throws Exception {
        assertThat(get("/probe/core-hr", "Bearer admin-token").statusCode()).isEqualTo(200);
    }
}
