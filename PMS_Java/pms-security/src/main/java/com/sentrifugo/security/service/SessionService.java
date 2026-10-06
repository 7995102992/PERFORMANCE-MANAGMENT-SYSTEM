package com.sentrifugo.security.service;

import com.sentrifugo.security.context.PmsUserPrincipal;
import com.sentrifugo.security.context.PmsUserPrincipal.ModulePermission;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Resolves a bearer token to the caller by reading the session IAM wrote to
 * Valkey. PMS does not validate the JWT itself: the token is used verbatim as
 * the key, exactly like {@code get_current_user} in the Python services.
 */
@Service
public class SessionService {

    private static final Logger log = LoggerFactory.getLogger(SessionService.class);
    private static final String SESSION_PREFIX = "session:";

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;

    public SessionService(StringRedisTemplate redis, ObjectMapper objectMapper) {
        this.redis = redis;
        this.objectMapper = objectMapper;
    }

    public PmsUserPrincipal resolve(String accessToken) {
        String raw;
        try {
            raw = redis.opsForValue().get(SESSION_PREFIX + accessToken);
        } catch (RuntimeException e) {
            log.warn("Valkey session lookup failed: {}", e.getMessage());
            throw new AuthenticationServiceException("Session store unavailable", e);
        }
        if (raw == null || raw.isBlank()) {
            throw new BadCredentialsException("Session not found or expired");
        }

        JsonNode session;
        try {
            session = objectMapper.readTree(raw);
        } catch (JacksonException e) {
            log.warn("Session payload is not valid JSON: {}", e.getMessage());
            throw new BadCredentialsException("Session payload malformed", e);
        }
        if (!session.isObject()) {
            throw new BadCredentialsException("Session payload malformed");
        }

        String userId = text(session, "user_id", "id");
        if (userId == null) {
            throw new BadCredentialsException("Session payload malformed");
        }

        return new PmsUserPrincipal(
                userId,
                text(session, "org_id", "organisation_id"),
                text(session, "email"),
                text(session, "full_name", "display_name"),
                text(session, "first_name"),
                text(session, "last_name"),
                bool(session.get("is_super_admin")),
                bool(session.get("is_org_admin")),
                text(session, "auth_method"),
                text(session, "department_id"),
                text(session, "business_unit_id"),
                permissions(session.get("permissions")),
                accessToken
        );
    }

    /** First non-empty value among {@code fields}, or null. */
    private static String text(JsonNode node, String... fields) {
        for (String field : fields) {
            JsonNode value = node.get(field);
            if (value != null && value.isValueNode() && !value.isNull()) {
                String s = value.asString();
                if (!s.isEmpty()) {
                    return s;
                }
            }
        }
        return null;
    }

    private static boolean bool(JsonNode value) {
        if (value == null || value.isNull()) {
            return false;
        }
        if (value.isBoolean()) {
            return value.booleanValue();
        }
        if (!value.isValueNode()) {
            return false;
        }
        String s = value.asString().toLowerCase();
        return s.equals("1") || s.equals("true") || s.equals("yes");
    }

    /** IAM's grid: {module: {acl, actions: {code: bool}, action_acls: {code: acl}}}. */
    private static Map<String, ModulePermission> permissions(JsonNode grid) {
        Map<String, ModulePermission> out = new LinkedHashMap<>();
        if (grid == null || !grid.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> module : grid.properties()) {
            JsonNode entry = module.getValue();
            if (!entry.isObject()) {
                continue;
            }
            Map<String, Boolean> actions = new LinkedHashMap<>();
            JsonNode actionsNode = entry.get("actions");
            if (actionsNode != null && actionsNode.isObject()) {
                for (Map.Entry<String, JsonNode> action : actionsNode.properties()) {
                    actions.put(action.getKey(), bool(action.getValue()));
                }
            }
            Map<String, String> actionAcls = new LinkedHashMap<>();
            JsonNode aclsNode = entry.get("action_acls");
            if (aclsNode != null && aclsNode.isObject()) {
                for (Map.Entry<String, JsonNode> acl : aclsNode.properties()) {
                    if (acl.getValue().isValueNode() && !acl.getValue().isNull()) {
                        actionAcls.put(acl.getKey(), acl.getValue().asString());
                    }
                }
            }
            out.put(module.getKey(), new ModulePermission(text(entry, "acl"), actions, actionAcls));
        }
        return out;
    }
}
