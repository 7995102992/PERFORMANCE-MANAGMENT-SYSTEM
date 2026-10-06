package com.sentrifugo.security.context;

import com.fasterxml.jackson.annotation.JsonIgnore;

import java.util.Map;

/**
 * The authenticated caller, built from the session IAM writes to Valkey at
 * {@code session:<access_token>}. Equivalent of {@code UserBase} in the Python
 * services.
 */
public record PmsUserPrincipal(
        String id,
        String organisationId,
        String email,
        String fullName,
        String firstName,
        String lastName,
        boolean superAdmin,
        boolean orgAdmin,
        String authMethod,
        String departmentId,
        String businessUnitId,
        Map<String, ModulePermission> permissions,
        @JsonIgnore String accessToken
) {

    /** One module's slice of IAM's permission grid. */
    public record ModulePermission(
            String acl,
            Map<String, Boolean> actions,
            Map<String, String> actionAcls
    ) {
    }

    public boolean isAdmin() {
        return superAdmin || orgAdmin;
    }

    /** Reads {@code permissions[module].actions[action]}; no admin bypass here. */
    public boolean hasPermission(String module, String action) {
        ModulePermission entry = permissions.get(module);
        return entry != null && Boolean.TRUE.equals(entry.actions().get(action));
    }
}
